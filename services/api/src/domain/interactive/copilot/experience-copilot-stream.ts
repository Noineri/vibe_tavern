/**
 * Experience-Copilot streaming — the experience wiring (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 2 / ER-6; AGENT_SHELL_PLAN Wave 1 / AS-2c).
 *
 * AS-2c SPLIT: the generic turn MECHANISM (thread load, turn-input persistence
 * incl. the TAG-5 answer-mode rewrite, digest-boundary pre-split, provider
 * stream consumption, SSE relay, TF-3 ordered persistence, CM-4 metrics, CM-6
 * auto-compaction) lives in `domain/agent/agent-stream.ts` (`streamAgentTurn`,
 * parameterized by `AgentStreamSeams`); this module supplies the EXPERIENCE
 * seams — rules/visual/bound-visuals/trust context loading, the copilot
 * profile resolution (with the built-in seed default), the ER-5 assembly call
 * (attached context + plan owner + live drafts), and the ER-4 tool-set build.
 * A second agent kind runs the same loop with its own assembly + tools.
 *
 * The output remains an `AsyncGenerator<{ event, data }>` of SSE-shaped chunks
 * that the route emits verbatim through `streamSSE` (same contract as
 * `runtime.sendMessageStream`). SINGLE-MODE: the copilot proposes rules/visual
 * edits + runs tests; it is NOT the multi-mode AI-assistant and NOT a
 * chat-mode. It mirrors the AI-assistant's CORE (standalone `streamText`,
 * direct provider/model resolution) but emits the SAME SSE event vocabulary
 * as the chat stream (`text-delta`, `reasoning-delta`, `tool-call`,
 * `tool-result`, `finish`, `error`) so the frontend's `parseSSEStream`
 * consumes it unchanged.
 */

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderProfile, ScriptRow, ExperienceVisualRow, AppDb } from "@vibe-tavern/db";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";
import type { AgentPlan, AgentPlanOwner } from "@vibe-tavern/domain";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotThread,
} from "@vibe-tavern/db";
import type { ProviderFetch } from "../../providers/provider-fetch-factory.js";
import { logSendDebug } from "../../../shared/send-debug-log.js";
import {
  streamAgentTurn,
  type AgentStreamDeps,
  type AgentStreamSeams,
} from "../../agent/agent-stream.js";
import {
  assembleExperienceCopilotPrompt,
  type ExperienceCopilotAssembleResult,
  type ExperienceCopilotTestFeedback,
} from "./experience-copilot-prompt.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS, COPILOT_RESPONSE_RESERVE_TOKENS, COPILOT_TOOL_LOOP_CEILING } from "./copilot-limits.js";
import { buildExperienceCopilotTools } from "./experience-copilot-tools.js";
import { resolveBuiltinCopilotProfile } from "./experience-copilot-module.js";
import { renderAttachedContext, type CopilotContextItem } from "../../agent/agent-context.js";
import type {
  ExperienceCopilotContextLink,
  ExperienceCopilotStep,
} from "@vibe-tavern/api-contracts";
import type {
  ExperienceCopilotStreamEvent,
  ExperienceCopilotStreamRequest,
} from "./experience-copilot-stream-contract.js";
export type {
  ExperienceCopilotStreamAnswer,
  ExperienceCopilotStreamEvent,
  ExperienceCopilotStreamRequest,
} from "./experience-copilot-stream-contract.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface ExperienceCopilotStreamDeps {
  /** The ER-3 store (thread + message persistence). */
  readonly store: ExperienceCopilotStore;
  /** Script-owned plan persistence for the model-facing plan/read_plan tools. */
  readonly agentPlans: {
    get(owner: AgentPlanOwner): Promise<AgentPlan | null>;
    save(owner: AgentPlanOwner, plan: AgentPlan): Promise<void>;
  };
  /** Fetch a script by id (rules source). Null when missing. */
  readonly getScript: (scriptId: string) => Promise<ScriptRow | null>;
  /** List the visual ids bound to a script (the bound-visuals set). */
  readonly getBoundVisualIds: (scriptId: string) => Promise<string[]>;
  /** Fetch one visual resource by id. Null when missing. */
  readonly getVisual: (id: string) => Promise<ExperienceVisualRow | null>;
  /** Resolve a raw provider profile by id. */
  readonly getProviderProfile: (id: string) => Promise<ProviderProfile | null>;
  /** Resolve the effective profile (base + per-model overlay). */
  readonly getEffectiveProviderProfile: (id: string, model: string) => Promise<ProviderProfile>;
  /** Resolve a `LanguageModel` from a profile + model name. */
  readonly resolveModel: (
    profile: { providerPreset: string; endpoint: string; apiKey: string | null },
    model: string,
    fetch?: ProviderFetch,
  ) => LanguageModel;
  /** Resolve the copilot profile for a script (CP-6/CP-7). Absent → the built-in
   *  seed (the pre-plan ER-16 module). */
  readonly resolveProfile?: (scriptId: string | null) => Promise<CopilotProfile>;
  /** Optional copilot user-skill root for the two-root catalog (CP-4). Absent →
   *  built-in root only. */
  readonly skillUserRoot?: string;
  /** Optional DB handle for service-prompt overrides (copilot base + references). */
  readonly db?: AppDb;
  /** CX-3: resolve the thread's pinned-context links into rendered-block input.
   *  The adapter supplies this over the real stores + copilot skill library;
   *  absent (tests, legacy harnesses) → no attached context, byte-identical
   *  pre-CX-3 assembly. Dangling links resolve to skipped items inside
   *  `getCopilotContextItems` — a missing entity never fails the turn. */
  readonly resolveContextItems?: (
    links: readonly ExperienceCopilotContextLink[],
  ) => Promise<CopilotContextItem[]>;
  /** The AI SDK streaming function. Defaults to the real `streamText` from "ai".
   *  Injectable so tests can substitute a fake WITHOUT `mock.module("ai")` —
   *  under bun:test that mock is process-global and permanent (neither
   *  `mock.restore()` nor re-registration undoes it; see AGENTS.md gotcha), and
   *  its `streamText` override leaks into later files, hanging their real AI
   *  SDK usage. Production wiring omits this field and gets the real function. */
  readonly streamText?: typeof streamText;
  /** CM-6 fire-and-forget auto-compaction trigger. Called AFTER the turn's
   *  metrics are persisted (so the service reads the fresh `lastProviderProfileId`
   *  / `lastModel` + `contextMetrics`). The stream does NOT await it — the
   *  compaction runs under its own per-thread background lock and must never
   *  block or fail the stream. Absent → no auto-compaction (tests, legacy). */
  readonly autoCompact?: (threadId: string) => Promise<void>;
}

// The tool-loop bound was REMOVED (TAG-4): the profile's `maxSteps` no longer
// exists — the loop runs until the model stops calling tools (pi parity, the
// user cancels). The AI SDK still requires a finite `stopWhen`, so the stream
// feeds it COPILOT_TOOL_LOOP_CEILING (1,000,000 — a wire-level formality, not
// a nanny cap). See copilot-limits.ts.

// ─── Context loading (rules / visual / bound visuals by scriptId) ────────────

interface CopilotContext {
  rules: string;
  visual: string | undefined;
  boundVisuals: Array<{ id: string; name: string; kind: string }>;
  /** SS-4B: trust flag of the thread's script (`origin === 'imported' &&
   *  firstEnabledAt === null` → false) — gates every copilot execution path. */
  rulesTrusted: boolean;
}

/** Load the turn-start context package by `thread.scriptId`. When `scriptId` is
 *  null (a draft, pre-save), rules/visual are empty so the model writes fresh.
 *  Bound-visual metadata is best-effort: a missing visual id is skipped, never
 *  fatal (mirrors the loader-skip convention used elsewhere). */
async function loadCopilotContext(
  scriptId: string | null,
  deps: ExperienceCopilotStreamDeps,
): Promise<CopilotContext> {
  if (scriptId === null) {
    return { rules: "", visual: undefined, boundVisuals: [], rulesTrusted: true };
  }
  const [script, boundVisualIds] = await Promise.all([
    deps.getScript(scriptId),
    deps.getBoundVisualIds(scriptId),
  ]);

  // Rules source = the script's code. A missing script is treated as an empty
  // draft (the thread's scriptId is a soft link that may dangle pre-save).
  const rules = script?.code ?? "";
  // SS-4B, derived ONCE here: imported rows are trusted only after the first
  // explicit enable; in_app rows, drafts and dangling ids are trusted.
  const rulesTrusted =
    script === null || script.origin !== "imported" || script.firstEnabledAt !== null;

  // Active visual = the script's defaultVisualId, resolved to its source.
  let visual: string | undefined;
  if (script?.defaultVisualId) {
    const v = await deps.getVisual(script.defaultVisualId);
    if (v) visual = v.source;
  }

  // Bound-visual metadata (id/name/kind) — metadata-only, never the source.
  const boundVisuals: CopilotContext["boundVisuals"] = [];
  for (const id of boundVisualIds) {
    const v = await deps.getVisual(id);
    if (v) boundVisuals.push({ id: v.id, name: v.name, kind: "visual" });
  }

  return { rules, visual, boundVisuals, rulesTrusted };
}

/** The script-owned plan owner for a thread — null for unsaved drafts (the
 *  plan tools' precondition guard reports that as a tool-error). */
function planOwnerFor(thread: ExperienceCopilotThread): AgentPlanOwner | null {
  return thread.scriptId === null ? null : { kind: "script", scriptId: thread.scriptId };
}

// ─── Main streaming function ─────────────────────────────────────────────────

/**
 * Stream one experience-copilot turn: the experience seams (context loading,
 * profile resolution, ER-5 assembly, ER-4 tools) wired into the generic agent
 * turn loop (`streamAgentTurn`). The loop loads the thread, persists the
 * turn's input, streams via `streamText`, and yields SSE-shaped
 * `{ event, data }` chunks; after the stream completes the turn (user message
 * + tool calls/results + final assistant text) is persisted to the ER-3 store
 * so history reloads next turn.
 *
 * @throws {@link notFound} when the thread does not exist (surfaces as HTTP 404
 *   via the global error handler, before any SSE headers are sent).
 */
export async function* streamExperienceCopilot(
  request: ExperienceCopilotStreamRequest,
  deps: ExperienceCopilotStreamDeps,
  signal?: AbortSignal,
): AsyncGenerator<ExperienceCopilotStreamEvent> {
  const seams: AgentStreamSeams<
    ExperienceCopilotStreamRequest,
    ExperienceCopilotThread,
    CopilotContext,
    CopilotProfile,
    ExperienceCopilotAssembleResult
  > = {
    logChannelPrefix: "api.experience-copilot",
    threadLabel: "ExperienceCopilotThread",
    limits: {
      contextBudgetTokens: COPILOT_CONTEXT_BUDGET_TOKENS,
      responseReserveTokens: COPILOT_RESPONSE_RESERVE_TOKENS,
      toolLoopCeiling: COPILOT_TOOL_LOOP_CEILING,
    },
    // The kind-context fact the old prompt-assembled debug line carried.
    assembleDebugFields: (context) => ({ rulesTrusted: context.rulesTrusted }),

    // ── Experience context: rules / visual / bound visuals / trust flag ──
    loadContext: (thread) => loadCopilotContext(thread.scriptId, deps),

    // ── Copilot profile (CP-6/CP-7): thread → script → profile row → built-in seed.
    resolveProfile: (thread) =>
      deps.resolveProfile
        ? deps.resolveProfile(thread.scriptId)
        : resolveBuiltinCopilotProfile(),

    // ── ER-5 assembly: live drafts + attached context + plan → prompt ──
    assemble: async ({ thread, request, kindContext: context, agentProfile: copilotProfile, history, model: modelName }) => {
      // Prefer the LIVE drafts the editor sent over the persisted DB buffers —
      // the copilot must see exactly what the user sees (in-progress edits,
      // pre-save drafts where the DB buffers are empty, the switched-to buffer).
      const rules = request.rules ?? context.rules;
      const visual = request.visual ?? context.visual;
      const step: ExperienceCopilotStep = request.step ?? "rules";
      // CX-3: resolve the thread's pinned links into the rendered attached
      // block. Live by-id resolution EVERY turn — never persisted, so a later
      // rename/delete/edit re-resolves next turn (dangling ids vanish). No dep
      // or no links → empty string → the assembler omits the section entirely.
      const contextItems = deps.resolveContextItems && thread.contextLinks.length > 0
        ? await deps.resolveContextItems(thread.contextLinks)
        : [];
      const attachedContextBlock = renderAttachedContext(contextItems);
      logSendDebug("api.experience-copilot.attached-context-resolved", {
        threadId: request.threadId,
        linkCount: thread.contextLinks.length,
        itemCount: contextItems.length,
        blockLength: attachedContextBlock.length,
      });
      const agentPlanOwner = planOwnerFor(thread);
      const agentPlan = agentPlanOwner === null ? null : await deps.agentPlans.get(agentPlanOwner);
      return await assembleExperienceCopilotPrompt({
        ...(deps.db ? { db: deps.db } : {}),
        history,
        rules,
        ...(visual !== undefined ? { visual } : {}),
        ...(context.boundVisuals.length > 0 ? { boundVisuals: context.boundVisuals } : {}),
        ...(request.testFeedback !== undefined && request.testFeedback !== null
          ? { testFeedback: request.testFeedback as unknown as ExperienceCopilotTestFeedback }
          : {}),
        step,
        model: modelName,
        contextBudget: COPILOT_CONTEXT_BUDGET_TOKENS,
        responseReserve: COPILOT_RESPONSE_RESERVE_TOKENS,
        profile: copilotProfile,
        plan: agentPlan,
        rulesTrusted: context.rulesTrusted,
        reviewSnapshot: request.reviewSnapshot,
        rulesSaved: request.rulesSaved,
        visualSaved: request.visualSaved,
        ...(deps.skillUserRoot !== undefined ? { skillUserRoot: deps.skillUserRoot } : {}),
        ...(attachedContextBlock ? { attachedContextBlock } : {}),
      });
    },

    // ── ER-4 tools, seeded from the same context the assembly saw ──
    buildTools: ({ thread, request, kindContext: context, agentProfile: copilotProfile, assembled }) => {
      const rules = request.rules ?? context.rules;
      const visual = request.visual ?? context.visual;
      const agentPlanOwner = planOwnerFor(thread);
      const requireAgentPlanOwner = (): AgentPlanOwner => {
        if (agentPlanOwner === null) {
          throw new Error("plan: a script must be saved before its plan can be read or updated");
        }
        return agentPlanOwner;
      };
      const loadPlan = (): Promise<AgentPlan | null> => deps.agentPlans.get(requireAgentPlanOwner());
      const savePlan = (plan: AgentPlan): Promise<void> => deps.agentPlans.save(requireAgentPlanOwner(), plan);
      // Skill roots come from the resolved skill catalog (ER-16) so
      // read_skill_file resolves against the rendered catalog's root; toolSet
      // is the resolved profile's set (read_skill_file always added on top,
      // mirroring Co-Author).
      return buildExperienceCopilotTools({
        ...(rules ? { rules } : {}),
        ...(visual !== undefined ? { visual } : {}),
        rulesTrusted: context.rulesTrusted,
        ...(request.launchContext !== undefined ? { launchContext: request.launchContext } : {}),
        toolSet: copilotProfile.toolSet,
        skillRoots: assembled.skillRoots,
        loadPlan,
        savePlan,
        // TAG-6 (restored PM-7): the todo tool's full-list rewrite persists onto
        // the thread row via the ER-3 store (session-scoped — survives turns and
        // reloads through the thread wire); `updateTodo(threadId, items)` is the
        // store's structural twin of the tool's `(items) => Promise<void>` dep.
        saveTodo: (items) => deps.store.updateTodo(request.threadId, items),
      });
    },
  };

  const streamDeps: AgentStreamDeps<ExperienceCopilotThread> = {
    store: deps.store,
    getProviderProfile: deps.getProviderProfile,
    getEffectiveProviderProfile: deps.getEffectiveProviderProfile,
    resolveModel: deps.resolveModel,
    ...(deps.streamText !== undefined ? { streamText: deps.streamText } : {}),
    ...(deps.autoCompact !== undefined ? { autoCompact: deps.autoCompact } : {}),
  };

  yield* streamAgentTurn(request, streamDeps, seams, signal);
}
