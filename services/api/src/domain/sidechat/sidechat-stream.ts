/**
 * Sidechat-OOC streaming (SIDECHAT_PLAN, Wave 1 / SC-4b) — the
 * `sidechat-ooc` kind's wiring into the generic agent turn loop
 * (`agent-stream.ts`), the way `script-agent-stream.ts` supplies the script
 * seams: the loop owns thread load, turn-input persistence, provider stream
 * consumption, SSE relay, ordered persistence and metrics; THIS module owns
 * the kind's turn knowledge — the RP sync + context package (loadContext),
 * the chat-owned profile chain, and the sidechat assembly (base prompt +
 * the SC-3b package as the system message's volatile tail).
 *
 * TURN ORDER (the unit's contract): chat + branch come from the THREAD ROW
 * (never the request); `syncBeforeUserMessage` (SC-2c) runs inside the
 * loadContext seam — BEFORE the generic loop persists the user message and
 * BEFORE the SC-3b loader's `listTimeline` read, so this turn's freshly
 * frozen RP delta sits at a seq BELOW the user message's on the merged
 * timeline. Since SC-4d (variant A) the system message carries the loader's
 * STATIC package only (character/persona/active_lore/objectives/
 * current_scene); the frozen events ride the MESSAGE FLOW as their own
 * user-role message bodies, placed by the merged timeline's order (the
 * loader's placement counts), so the OOC conversation reaches the model
 * exactly once — as the real history rows. The reply persists through the
 * generic loop exactly like the other kinds'.
 *
 * NO tools until Wave 3 (buildTools returns the empty set) and NO
 * compaction/window until Wave 2 (history passes through unwindowed; no
 * auto-compaction is wired) — the plan's explicit cuts for this unit.
 */

// fork #1 of script-agent-stream.ts (services/api/src/domain/agent/script-agent/script-agent-stream.ts)
// — the seams-wiring skeleton (deps interface shape, the seams object's
// loadContext/resolveProfile/assemble/buildTools entries, the streamDeps
// handoff, the generator tail). The seam BODIES are the sidechat's own: the
// sync+package load, the chat-owned-only profile chain, and the sidechat
// assembly have no script analog. Correspondence map: loadContext ←
// loadScriptAgentContext, resolveProfile ← the script 3-way chain (narrowed:
// sidechat threads are ALWAYS chat-owned), assemble ← the AS-7 assembly call
// (replaced by the SC-4b assembly below, reshaped by SC-4d: the STATIC
// package rides the system message and the frozen events interleave into
// the message flow), buildTools ← buildScriptAgentTools (empty until Wave 3),
// limits/logChannelPrefix/streamDeps ← verbatim shape.

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderProfile, AppDb, ExperienceCopilotStore, ExperienceCopilotThread } from "@vibe-tavern/db";
import type { CopilotProfile, ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import { estimateTokens, setModelHint } from "@vibe-tavern/prompt-pipeline";
import type { ProviderFetch } from "../providers/provider-fetch-factory.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import {
  streamAgentTurn,
  type AgentAssembledPrompt,
  type AgentPromptMessage,
  type AgentStreamDeps,
  type AgentStreamSeams,
} from "../agent/agent-stream.js";
import {
  estimateHistoryTokens,
  renderDigestSection,
  type AgentFlowMessage,
  type AgentHistoryMessage,
} from "../agent/agent-prompt.js";
import { renderAttachedContext, type CopilotContextItem } from "../agent/agent-context.js";
import { isChatOwnedAgentThread } from "../agent/agent-thread-owner.js";
import { getAgentKind } from "../agent/agent-kind-registry.js";
// The value import doubles as the side effect: importing the kind module
// registers the `sidechat-ooc` kind at module init, so the descriptor read
// below (the recency anchor) resolves in ANY process that streams a turn
// (tests included — they do not go through server-runtime).
import { resolveBuiltinSidechatOocProfile } from "../agent/kinds/sidechat-ooc-kind.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS, COPILOT_RESPONSE_RESERVE_TOKENS, COPILOT_TOOL_LOOP_CEILING } from "../interactive/copilot/copilot-limits.js";
import { syncBeforeUserMessage, type RpSyncDeps } from "./rp-sync.js";
import {
  loadSidechatContext,
  type SidechatContextDeps,
  type SidechatContextPackage,
} from "./sidechat-context.js";
import type { ExperienceCopilotStreamRequest, ExperienceCopilotStreamEvent } from "../interactive/copilot/experience-copilot-stream-contract.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface SidechatStreamDeps {
  /** The shared agent-thread store (thread + message persistence — the
   *  sidechat's threads live in the same store as every kind's). */
  readonly store: ExperienceCopilotStore;
  /** The SC-2c RP-sync writer's deps (chats / messages / assembly /
   *  experienceCopilot) — passed through verbatim to
   *  {@link syncBeforeUserMessage} each turn. */
  readonly sync: RpSyncDeps;
  /** The SC-3b context loader's deps (chats / characters / messages /
   *  traces / experienceCopilot / assembly) — passed through verbatim to
   *  {@link loadSidechatContext} after the sync. */
  readonly context: SidechatContextDeps;
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
  /** Resolve the profile for the CHAT-OWNED thread (its chatId + agentKind
   *  owner columns — every sidechat thread is chat-owned): the chat's own
   *  choice → the kind default → the kind's built-in seed, with dangling ids
   *  falling through (`CopilotProfileResolver.resolveForChat`, SC-0f).
   *  Absent (tests, legacy harnesses) → the built-in `sidechat-ooc` seed
   *  (with the `sidechat_ooc_base` SP-5 override when `db` is present). */
  readonly resolveProfileForChat?: (thread: {
    readonly chatId: string;
    readonly agentKind: string;
  }) => Promise<CopilotProfile>;
  /** CX-3: resolve the thread's pinned-context links into rendered-block
   *  input (the same kind-agnostic loader the other kinds' streams use).
   *  Absent (tests, legacy harnesses) → no attached context. */
  readonly resolveContextItems?: (
    links: readonly ExperienceCopilotContextLink[],
  ) => Promise<CopilotContextItem[]>;
  /** Optional DB handle for the `sidechat_ooc_base` seed override on the
   *  built-in fallback path. */
  readonly db?: AppDb;
  /** Injectable streamText (tests substitute a fake without `mock.module("ai")`). */
  readonly streamText?: typeof streamText;
}

// ─── Kind context ────────────────────────────────────────────────────────────

/** The turn-start sidechat context — SC-3b's load, reshaped by SC-4d: the
 *  STATIC package string (loaded AFTER the RP sync) + the frozen events as
 *  flow-ready user-message bodies placed by the merged timeline's order.
 *  The package parts are the shape SC-4b's assembly below consumes
 *  directly. */
async function loadSidechatTurnContext(
  deps: SidechatStreamDeps,
  threadId: ExperienceCopilotThread["id"],
): Promise<SidechatContextPackage> {
  await syncBeforeUserMessage(deps.sync, threadId);
  return loadSidechatContext(deps.context, threadId);
}

// ─── Assembly (SC-4b, reshaped by SC-4d) ───────────────────────────────────

/**
 * Build the turn's message flow (SC-4d, variant A): the loop's real history
 * — tool parts and digest handling intact — with each frozen RP event
 * injected as its own user-role message at its merged-timeline position (the
 * loader's `precedingMessages` counts; NO seq arithmetic here — listTimeline's
 * merged order is the single ordering source). Consecutive user messages are
 * fine: they follow the CX-3 precedent (the pinned block already rides as a
 * user message before the turn's own). The turn's own user message (content
 * mode — the loop appends it LAST) re-attaches LAST: every frozen event
 * predates it by the sync-before-persist order, so events never displace it.
 * Pure — every input is a parameter.
 */
function buildSidechatMessageFlow(
  historyFlow: readonly AgentFlowMessage[],
  context: SidechatContextPackage,
  hasUserPush: boolean,
): AgentFlowMessage[] {
  const last = historyFlow[historyFlow.length - 1];
  if (hasUserPush && (last === undefined || last.role !== "user")) {
    throw new Error(
      "buildSidechatMessageFlow: content-mode history must end with the turn's own user message " +
        "(the generic loop appends it last) — refusing to assemble a mismatched flow",
    );
  }
  const realMessages = hasUserPush && last !== undefined ? historyFlow.slice(0, -1) : [...historyFlow];
  if (realMessages.length !== context.messageCount) {
    // The loop's history and the loader's timeline must carry the SAME
    // message rows. Today only a compaction digest split can break that
    // (the loop drops covered rows; the timeline keeps them) — and the
    // sidechat has no compaction writer until Wave 2, so this is the loud
    // guard on that seam, in the family of the corrupt-payload refusals:
    // a mismatched flow would show the model covered messages again.
    throw new Error(
      `buildSidechatMessageFlow: history carries ${realMessages.length} flow messages but the merged ` +
        `timeline carries ${context.messageCount} message rows — the sidechat flow does not follow a ` +
        "digest split yet (Wave 2 wires sidechat compaction)",
    );
  }
  const flow = [...realMessages];
  let inserted = 0;
  for (const event of context.eventMessages) {
    // Events arrive in merged-timeline order, so `precedingMessages +
    // inserted` is each event's stable index among the messages already
    // placed (same-position events stay in their frozen order).
    flow.splice(event.precedingMessages + inserted, 0, { role: "user", content: event.content });
    inserted += 1;
  }
  if (hasUserPush && last !== undefined) flow.push(last);
  return flow;
}

/** Assemble the sidechat prompt: system message = the profile's base prompt +
 *  (any digest section) + the SC-3b STATIC package — the volatile context
 *  section with NO timeline in it (SC-4d: the frozen events and the OOC
 *  conversation both ride the message flow, so the model reads ONE
 *  chronological flow); history passes through UNWINDOWED (compaction/
 *  windowing is Wave 2) with the frozen events interleaved as user-role
 *  message bodies placed by the merged timeline's order; the pinned-context
 *  block + the kind's recency anchor inject as trailing user messages
 *  (the CX-3 pattern the other kinds' assemblers use). Pure — every input is
 *  a parameter. */
function assembleSidechatPrompt(input: {
  basePrompt: string;
  context: SidechatContextPackage;
  history: readonly AgentHistoryMessage[];
  /** Content mode: the loop appended the turn's own user message LAST. */
  hasUserPush: boolean;
  attachedContextBlock: string;
  recencyAnchorText: string;
  model?: string;
}): AgentAssembledPrompt {
  if (input.model !== undefined) setModelHint(input.model);

  // Digest lift (the generic loop's CM-3 contract: it pre-splits at the
  // boundary and hands the LAST digest back at the front of the history —
  // honored here rather than silently dropped). The sidechat has no
  // compaction writer yet (Wave 2), so a digest cannot be born today.
  const digestMessages = input.history.filter((m) => m.role === "digest");
  const lastDigest = digestMessages.length > 0 ? digestMessages[digestMessages.length - 1] : null;
  const digestText = lastDigest !== null && lastDigest.role === "digest" ? lastDigest.content : null;
  const historyFlow: AgentFlowMessage[] = input.history.filter(
    (m): m is AgentFlowMessage => m.role !== "digest",
  );
  const digestSectionText = digestText !== null ? renderDigestSection(digestText) : "";

  // System message: STABLE base prompt first, VOLATILE tail (digest → the
  // SC-3b STATIC package — no timeline section since SC-4d) last — the other
  // assemblers' cache-friendly order.
  const systemWithoutDigest = [input.basePrompt, "", input.context.staticPackage].join("\n");
  const systemMessage = digestSectionText
    ? [input.basePrompt, "", digestSectionText, "", input.context.staticPackage].join("\n")
    : systemWithoutDigest;

  // Message flow (SC-4d): the real OOC history with the frozen RP events
  // interleaved as user-role messages placed by the merged timeline's order —
  // the OOC conversation exists in the prompt exactly once.
  const flow = buildSidechatMessageFlow(historyFlow, input.context, input.hasUserPush);

  const systemTokens = estimateTokens(systemWithoutDigest);
  const digestTokens = digestSectionText ? estimateTokens(digestSectionText) : 0;
  // Event messages count with the history (SC-4d; Wave 2's SC-9 splits them
  // into their own segments later).
  const historyTokens = estimateHistoryTokens(flow);
  const attachedTokens = input.attachedContextBlock
    ? estimateTokens(input.attachedContextBlock) + estimateTokens(input.recencyAnchorText)
    : 0;

  const messages: AgentPromptMessage[] = [{ role: "system", content: systemMessage }, ...flow];
  if (input.attachedContextBlock) {
    // CX-3: the pinned block rides as a user message immediately before the
    // turn's own user message (so the anchor sits directly under the block).
    const lastMessage = messages[messages.length - 1];
    const insertAt = lastMessage && lastMessage.role === "user" ? messages.length - 1 : messages.length;
    messages.splice(
      insertAt,
      0,
      { role: "user", content: input.attachedContextBlock },
      { role: "user", content: input.recencyAnchorText },
    );
  }

  return {
    systemMessage,
    messages,
    tokenAccounting: {
      system: systemTokens,
      digest: digestTokens,
      history: historyTokens,
      attached: attachedTokens,
      total: systemTokens + digestTokens + historyTokens + attachedTokens,
    },
  };
}

// ─── Main streaming function ─────────────────────────────────────────────────

/**
 * Stream one sidechat-OOC turn: the RP sync + SC-3b load (loadContext),
 * the chat-owned profile chain, and the SC-4b/SC-4d assembly wired into the
 * generic agent turn loop. Yields the same SSE-shaped `{ event, data }`
 * chunks the route relays verbatim; throws `notFound` for a missing thread
 * and `RpSyncThreadNotChatOwnedError` for a thread this kind cannot own (a
 * script-owned/draft row can never resolve to `sidechat-ooc`, so that
 * refusal is the corruption guard, not an expected path).
 */
export async function* streamSidechatTurn(
  request: ExperienceCopilotStreamRequest,
  deps: SidechatStreamDeps,
  signal?: AbortSignal,
): AsyncGenerator<ExperienceCopilotStreamEvent> {
  const seams: AgentStreamSeams<
    ExperienceCopilotStreamRequest,
    ExperienceCopilotThread,
    SidechatContextPackage,
    CopilotProfile,
    AgentAssembledPrompt
  > = {
    logChannelPrefix: "api.sidechat-ooc",
    threadLabel: "ExperienceCopilotThread",
    limits: {
      contextBudgetTokens: COPILOT_CONTEXT_BUDGET_TOKENS,
      responseReserveTokens: COPILOT_RESPONSE_RESERVE_TOKENS,
      toolLoopCeiling: COPILOT_TOOL_LOOP_CEILING,
    },

    // ── The kind's turn: RP sync FIRST, then the SC-3b load (static package
    //  + flow-placed events). This seam runs BEFORE the generic loop persists
    //  the user message, which is what puts the frozen delta below the turn's
    //  own seq on the merged timeline. ──
    loadContext: (thread) => loadSidechatTurnContext(deps, thread.id),

    // ── Agent profile: sidechat threads are ALWAYS chat-owned (the kind
    //  owns its threads), so the chat chain is the only path — the SC-0f
    //  seam when wired, the built-in seed otherwise (tests). The owner test
    //  also narrows the thread for the seam AND refuses a non-chat-owned row
    //  (unreachable through the dispatch; the corruption guard). ──
    resolveProfile: (thread) =>
      deps.resolveProfileForChat && isChatOwnedAgentThread(thread)
        ? deps.resolveProfileForChat(thread)
        : resolveBuiltinSidechatOocProfile(deps.db),

    // ── SC-4b/SC-4d assembly: base prompt + STATIC package in the system
    //  message, frozen events interleaved into the flow (+ pinned context +
    //  anchor before the turn's own user message) ──
    assemble: async ({ thread, request, kindContext: context, agentProfile, history, model }) => {
      const contextItems =
        deps.resolveContextItems && thread.contextLinks.length > 0
          ? await deps.resolveContextItems(thread.contextLinks)
          : [];
      const attachedContextBlock = renderAttachedContext(contextItems);
      logSendDebug("api.sidechat-ooc.attached-context-resolved", {
        threadId: request.threadId,
        linkCount: thread.contextLinks.length,
        itemCount: contextItems.length,
        blockLength: attachedContextBlock.length,
      });
      return assembleSidechatPrompt({
        basePrompt: agentProfile.basePrompt,
        context,
        history,
        hasUserPush: request.content !== undefined,
        attachedContextBlock,
        recencyAnchorText: getAgentKind("sidechat-ooc").recencyAnchorText,
        ...(model !== undefined ? { model } : {}),
      });
    },

    // ── No tools until Wave 3 — the empty set, matching the kind's strict
    //  empty tool-set schema (nothing can smuggle a tool in early). ──
    buildTools: () => ({}),
  };

  const streamDeps: AgentStreamDeps<ExperienceCopilotThread> = {
    store: deps.store,
    getProviderProfile: deps.getProviderProfile,
    getEffectiveProviderProfile: deps.getEffectiveProviderProfile,
    resolveModel: deps.resolveModel,
    // No autoCompact: compaction is Wave 2's unit; the sidechat's threads
    // never auto-compact (and the manual compact route refuses the kind with
    // AGENT_KIND_NOT_WIRED until that unit wires its compactionKinds entry).
    ...(deps.streamText !== undefined ? { streamText: deps.streamText } : {}),
  };

  yield* streamAgentTurn(request, streamDeps, seams, signal);
}
