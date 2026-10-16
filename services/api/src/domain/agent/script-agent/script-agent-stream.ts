/**
 * Script-agent streaming (AGENT_SHELL_PLAN, Wave 4 / AS-8b) — the `script`
 * kind's wiring into the generic agent turn loop (`agent-stream.ts`), exactly
 * the way `experience-copilot-stream.ts` supplies the experience seams: the
 * loop owns thread load, turn-input persistence, provider stream consumption,
 * SSE relay, ordered persistence and metrics; THIS module owns the kind's
 * knowledge — the prompt/dice script context (name, scope, linked owners,
 * trust), the kind-aware profile resolution, the AS-7 assembly call
 * (`assembleScriptAgentPrompt`) and tool build (`buildScriptAgentTools`).
 *
 * LIVE-BUFFER CONTRACT (the plan's failure point #3): the `code` working
 * buffer is seeded from the REQUEST's `code` field (what the user's editor
 * shows — unsaved edits included); the stored row's code is only the fallback
 * when the request carries no buffer. The model must never be fed stale DB
 * code.
 *
 * The `scriptKind` request field is advisory telemetry only — the STORED
 * script kind selects the API-knowledge section (immutable after creation).
 */

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderProfile, ScriptRow, AppDb, ExperienceCopilotStore, ExperienceCopilotThread } from "@vibe-tavern/db";
import type { StoreContainer } from "@vibe-tavern/db";
import type { CopilotProfile, ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import type { AgentPlan, AgentPlanOwner } from "@vibe-tavern/domain";
import type { ProviderFetch } from "../../providers/provider-fetch-factory.js";
import { logSendDebug } from "../../../shared/send-debug-log.js";
import { streamAgentTurn, type AgentStreamDeps, type AgentStreamSeams } from "../agent-stream.js";
import { renderAttachedContext, type CopilotContextItem } from "../agent-context.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS, COPILOT_RESPONSE_RESERVE_TOKENS, COPILOT_TOOL_LOOP_CEILING } from "../../interactive/copilot/copilot-limits.js";
import { assembleScriptAgentPrompt, type ScriptAgentAssembleResult } from "./script-agent-prompt.js";
import { buildScriptAgentTools } from "./script-agent-tools.js";
import { resolveBuiltinScriptAgentProfile, isScriptAuthoringTrusted } from "./script-agent-module.js";
import type { ExperienceCopilotStreamRequest, ExperienceCopilotStreamEvent } from "../../interactive/copilot/experience-copilot-stream-contract.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface ScriptAgentStreamDeps {
  /** The shared agent-thread store (thread + message persistence — script
   *  threads live in the same store as experience threads; only the assembly
   *  and tools are kind-specific). */
  readonly store: ExperienceCopilotStore;
  /** Script-owned plan persistence for the model-facing plan/read_plan tools. */
  readonly agentPlans: {
    get(owner: AgentPlanOwner): Promise<AgentPlan | null>;
    save(owner: AgentPlanOwner, plan: AgentPlan): Promise<void>;
  };
  /** Fetch a script by id (identity + stored code fallback). Null when missing. */
  readonly getScript: (scriptId: string) => Promise<ScriptRow | null>;
  /** Resolve the script's linked owner display names (script_links). */
  readonly getOwnerNames: (scriptId: string) => Promise<string[]>;
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
  /** Resolve the agent profile for a script (the kind-aware
   *  `CopilotProfileResolver.resolveForScript`). Absent → the built-in
   *  `script` seed (with the `script_agent_base` SP-5 override when `db` is
   *  present). */
  readonly resolveProfile?: (scriptId: string | null) => Promise<CopilotProfile>;
  /** Optional user-skill root for the two-root catalog scan. */
  readonly skillUserRoot?: string;
  /** Optional DB handle for service-prompt overrides (script/dice_script API
   *  sections + the script_agent_base seed override). */
  readonly db?: AppDb;
  /** CX-3: resolve the thread's pinned-context links into rendered-block input
   *  (the same kind-agnostic loader the experience stream uses). */
  readonly resolveContextItems?: (
    links: readonly ExperienceCopilotContextLink[],
  ) => Promise<CopilotContextItem[]>;
  /** The full store container — `run_script_test` runs the script through the
   *  real `testScript` domain service (the same seam the script-test route
   *  uses). */
  readonly stores: StoreContainer;
  /** CM-6 fire-and-forget auto-compaction trigger, called after a completed
   *  turn once metrics are persisted (the adapter wires the script kind's
   *  `ScriptAgentCompactionService`). Absent → the thread never auto-compacts. */
  readonly autoCompact?: (threadId: string) => Promise<void>;
  /** Injectable streamText (tests substitute a fake without `mock.module("ai")`). */
  readonly streamText?: typeof streamText;
}

// ─── Kind context ────────────────────────────────────────────────────────────

/** The turn-start script context — everything the assembly and tools need
 *  about the script row, resolved ONCE per turn before assembly. */
interface ScriptAgentTurnContext {
  readonly scriptName: string;
  readonly scriptKind: "prompt" | "dice";
  readonly scopeType: string;
  readonly ownerNames: readonly string[];
  /** The STORED code — the fallback when the request carries no live buffer. */
  readonly storedCode: string;
  /** SCRIPT_SAFETY_PLAN trust flag (imported && never enabled → false). */
  readonly codeTrusted: boolean;
}

async function loadScriptAgentContext(
  scriptId: string | null,
  deps: ScriptAgentStreamDeps,
): Promise<ScriptAgentTurnContext> {
  if (scriptId === null) {
    // Draft semantics (mirrors the experience stream): empty buffers, trusted.
    return { scriptName: "Script", scriptKind: "prompt", scopeType: "global", ownerNames: [], storedCode: "", codeTrusted: true };
  }
  const [script, ownerNames] = await Promise.all([
    deps.getScript(scriptId),
    deps.getOwnerNames(scriptId),
  ]);
  const scriptKind = script?.scriptKind === "dice" ? "dice" : "prompt";
  return {
    scriptName: script?.name ?? "Script",
    scriptKind,
    scopeType: script?.scopeType ?? "global",
    ownerNames,
    storedCode: script?.code ?? "",
    // Derived ONCE here (the single source every consumer reads): imported
    // rows are trusted only after the first explicit enable.
    codeTrusted: script === null || isScriptAuthoringTrusted(script),
  };
}

/** The script-owned plan owner for a thread — null for unsaved drafts (the
 *  plan tools' precondition guard reports that as a tool-error). */
function planOwnerFor(thread: ExperienceCopilotThread): AgentPlanOwner | null {
  return thread.scriptId === null ? null : { kind: "script", scriptId: thread.scriptId };
}

// ─── Main streaming function ─────────────────────────────────────────────────

/**
 * Stream one script-agent turn: the `script` seams (context loading, profile
 * resolution, AS-7 assembly + tools) wired into the generic agent turn loop.
 * Yields the same SSE-shaped `{ event, data }` chunks the route relays
 * verbatim; throws `notFound` for a missing thread (HTTP 404 before any SSE
 * headers, via the global error handler).
 */
export async function* streamScriptAgentTurn(
  request: ExperienceCopilotStreamRequest,
  deps: ScriptAgentStreamDeps,
  signal?: AbortSignal,
): AsyncGenerator<ExperienceCopilotStreamEvent> {
  const seams: AgentStreamSeams<
    ExperienceCopilotStreamRequest,
    ExperienceCopilotThread,
    ScriptAgentTurnContext,
    CopilotProfile,
    ScriptAgentAssembleResult
  > = {
    logChannelPrefix: "api.script-agent",
    threadLabel: "ExperienceCopilotThread",
    limits: {
      contextBudgetTokens: COPILOT_CONTEXT_BUDGET_TOKENS,
      responseReserveTokens: COPILOT_RESPONSE_RESERVE_TOKENS,
      toolLoopCeiling: COPILOT_TOOL_LOOP_CEILING,
    },
    assembleDebugFields: (context) => ({
      scriptKind: context.scriptKind,
      codeTrusted: context.codeTrusted,
    }),

    // ── Script context: identity, scope, linked owners, stored code, trust ──
    loadContext: (thread) => loadScriptAgentContext(thread.scriptId, deps),

    // ── Agent profile: thread → script → profile row → the kind's builtin ──
    resolveProfile: (thread) =>
      deps.resolveProfile
        ? deps.resolveProfile(thread.scriptId)
        : resolveBuiltinScriptAgentProfile(deps.db),

    // ── AS-7 assembly: live code + attached context + plan → prompt ──
    assemble: async ({ thread, request, kindContext: context, agentProfile, history, model: modelName }) => {
      // LIVE buffer wins — the model must see exactly what the user sees;
      // the stored row's code is only the no-live-buffer fallback.
      const code = request.code ?? context.storedCode;
      const contextItems =
        deps.resolveContextItems && thread.contextLinks.length > 0
          ? await deps.resolveContextItems(thread.contextLinks)
          : [];
      const attachedContextBlock = renderAttachedContext(contextItems);
      logSendDebug("api.script-agent.attached-context-resolved", {
        threadId: request.threadId,
        linkCount: thread.contextLinks.length,
        itemCount: contextItems.length,
        blockLength: attachedContextBlock.length,
      });
      const agentPlanOwner = planOwnerFor(thread);
      const agentPlan = agentPlanOwner === null ? null : await deps.agentPlans.get(agentPlanOwner);
      return await assembleScriptAgentPrompt({
        ...(deps.db ? { db: deps.db } : {}),
        history,
        scriptName: context.scriptName,
        scriptKind: context.scriptKind,
        scopeType: context.scopeType,
        ownerNames: [...context.ownerNames],
        code,
        codeTrusted: context.codeTrusted,
        ...(request.codeSaved !== undefined ? { codeSaved: request.codeSaved } : {}),
        profile: agentProfile,
        plan: agentPlan,
        model: modelName,
        contextBudget: COPILOT_CONTEXT_BUDGET_TOKENS,
        responseReserve: COPILOT_RESPONSE_RESERVE_TOKENS,
        ...(deps.skillUserRoot !== undefined ? { skillUserRoot: deps.skillUserRoot } : {}),
        ...(attachedContextBlock ? { attachedContextBlock } : {}),
      });
    },

    // ── AS-7 tools, seeded from the same live code the assembly saw ──
    buildTools: ({ thread, request, kindContext: context, agentProfile, assembled }) => {
      const code = request.code ?? context.storedCode;
      const agentPlanOwner = planOwnerFor(thread);
      const requireAgentPlanOwner = (): AgentPlanOwner => {
        if (agentPlanOwner === null) {
          throw new Error("plan: a script must be saved before its plan can be read or updated");
        }
        return agentPlanOwner;
      };
      return buildScriptAgentTools({
        scriptId: thread.scriptId ?? "",
        code,
        codeTrusted: context.codeTrusted,
        stores: deps.stores,
        toolSet: agentProfile.toolSet,
        loadPlan: () => deps.agentPlans.get(requireAgentPlanOwner()),
        savePlan: (plan) => deps.agentPlans.save(requireAgentPlanOwner(), plan),
        skillRoots: [...assembled.skillRoots],
      });
    },
  };

  const streamDeps: AgentStreamDeps<ExperienceCopilotThread> = {
    store: deps.store,
    getProviderProfile: deps.getProviderProfile,
    getEffectiveProviderProfile: deps.getEffectiveProviderProfile,
    resolveModel: deps.resolveModel,
    ...(deps.streamText !== undefined ? { streamText: deps.streamText } : {}),
    // Fire-and-forget auto-compaction trigger, wired by the adapter to the
    // SCRIPT kind's compaction service (script-authoring summarizer prompt).
    // Absent when the adapter has no provider profile service.
    ...(deps.autoCompact !== undefined ? { autoCompact: deps.autoCompact } : {}),
  };

  yield* streamAgentTurn(request, streamDeps, seams, signal);
}
