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
 * timeline; since SC-17 the same seam also freezes the turn's ATTACHED RP
 * VARIANTS (`attachedVariants` → `variants_attached` events, one per
 * attached message in position order, texts transformed through SC-2a's
 * reader, `selected` read from the RP's own state, all-or-nothing on
 * validation) between the sync and the load.
 * Since SC-4d (variant A) the system message carries the loader's
 * STATIC package only (character/persona/active_lore/objectives/
 * current_scene); the frozen events ride the MESSAGE FLOW as their own
 * user-role message bodies, placed by the merged timeline's order (the
 * loader's placement counts), so the OOC conversation reaches the model
 * exactly once — as the real history rows. The reply persists through the
 * generic loop exactly like the other kinds'.
 *
 * Since SC-10 the kind serves its first tools: `search_context` /
 * `read_context_item` (kinds/sidechat/sidechat-search-tools.ts) over a
 * per-turn `ContextSearchSession` built in the buildTools seam — the ONE
 * extracted store-reads mapping (no Co-Author skill catalog), the chat's
 * active scope, and the branch view the turn's sync ALREADY read ("one view
 * per turn" — a search never runs a second branch read or dry RP assembly).
 * Served only when the resolved profile's tool set enables them; absent
 * mapping (tests, legacy harnesses) → no search tools. Since SC-11 the
 * kind also serves `propose_objective` (kinds/sidechat/
 * sidechat-objective-tools.ts) — the proposal-returning twin that needs no
 * per-turn state, so it rides the SAME seam and the SAME profile gating
 * even when the search mapping is absent.
 *
 * NO tools until Wave 3 — since SC-10 the search pair, since SC-11 also the
 * objective-proposal tool, and since SC-12 the closing pair: `todo` (the
 * session checklist — the shared standalone factory, persisted through the
 * thread store's `updateTodo`) and `read_plan` (the shared agent-plan tools
 * in read-only mode — the plan owner is the thread row's chat + branch, and
 * NO plan-write tool exists in the set), both from
 * `kinds/sidechat/sidechat-checklist-tools.ts`. Since SC-6 the
 * assembly runs the SHELL's existing budget trim (planHistoryCompaction)
 * over the merged flow: over the shared budget the OLDEST flow entries drop
 * first, RP and discussion alike, in time order. Since SC-8c the flow
 * follows a compaction digest split (the SC-4d count guard is gone — see
 * buildSidechatMessageFlow): the digest rides the flow as its own user-role
 * message after the pre-boundary RP layer, and the kind's auto-compaction
 * measures the discussion against the room left after the static context
 * and the RP layer through the compaction seam.
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
// the message flow), buildTools ← buildScriptAgentTools (SC-10: the sidechat
// search pair, profile-gated), limits/logChannelPrefix/streamDeps ← verbatim
// shape.

import { streamText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderProfile, AppDb, ExperienceCopilotStore, ExperienceCopilotThread } from "@vibe-tavern/db";
import type { AgentPlan, AgentPlanOwner } from "@vibe-tavern/domain";
import type { CopilotProfile, ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import { estimateTokens, planHistoryCompaction, setModelHint } from "@vibe-tavern/prompt-pipeline";
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
import {
	createContextSearchSession,
	type ContextSearchStoreReads,
} from "../context/context-search-service.js";
import { buildSidechatSearchTools } from "../agent/kinds/sidechat/sidechat-search-tools.js";
import { buildSidechatObjectiveTools } from "../agent/kinds/sidechat/sidechat-objective-tools.js";
import { buildSidechatChecklistTools } from "../agent/kinds/sidechat/sidechat-checklist-tools.js";
import type { SidechatAutoCompactPressure, SidechatOocCompactionService } from "./sidechat-compaction.js";
// The value import doubles as the side effect: importing the kind module
// registers the `sidechat-ooc` kind at module init, so the descriptor read
// below (the recency anchor) resolves in ANY process that streams a turn
// (tests included — they do not go through server-runtime).
import { resolveBuiltinSidechatOocProfile } from "../agent/kinds/sidechat-ooc-kind.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS, COPILOT_RESPONSE_RESERVE_TOKENS, COPILOT_TOOL_LOOP_CEILING } from "../interactive/copilot/copilot-limits.js";
import { RpSyncThreadNotChatOwnedError, syncBeforeUserMessage, type RpSyncDeps } from "./rp-sync.js";
import { attachVariantsBeforeUserMessage, type VariantAttachDeps } from "./sidechat-variant-attach.js";
import type { AttachedVariantPair, RpBranchView } from "./rp-branch-view.js";
import {
  loadSidechatContext,
  SIDECHAT_OOC_METER_SEGMENT_KEYS,
  type SidechatContextDeps,
  type SidechatContextPackage,
  type SidechatOocMeterSegmentKey,
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
  /** SC-17: the variant-attach freeze's deps (the "discuss in the sidechat"
   *  flow — the SC-2a reader deps + the thread row read + the frozen-event
   *  append) — passed through verbatim to
   *  {@link attachVariantsBeforeUserMessage}
   *  between the sync and the SC-3b load, only on turns that carry
   *  `attachedVariants`. In production the same store instances the sync and
   *  context seams read; the seam exists so the freeze is its own typed
   *  contract, not a widening of the sync's. */
  readonly attach: VariantAttachDeps;
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
  /** SC-10: the store-reads mapping for the turn's context-search session —
   *  the ONE extracted mapping (context-search-store-reads.ts), built WITHOUT
   *  a Co-Author skill catalog (the sidechat's session indexes no skill
   *  records; its own skills come through `@` pins, SC-5). Absent (tests,
   *  legacy harnesses) → the stream serves no search tools. */
  readonly searchStoreReads?: ContextSearchStoreReads;
  /** SC-12: the shared agent-plan store's READ seam for `read_plan`. The
   *  sidechat's plan access is read-only — the branch-plan write belongs to
   *  the director kind (owner ruling 7), so no `plan` tool exists — and the
   *  owner the stream reads through is the THREAD ROW's chat + branch,
   *  never the request. */
  readonly agentPlans: {
    get(owner: AgentPlanOwner): Promise<AgentPlan | null>;
  };
  /** SC-8c: the kind's own compaction service — present → the stream wires
   *  the loop's autoCompact hook to the sidechat rule (the discussion
   *  against the room left after the static context and the RP layer).
   *  Absent (tests, legacy harnesses) → the sidechat's threads never
   *  auto-compact; the manual compact route still works through the
   *  adapter's compactionKinds entry. */
  readonly compaction?: SidechatOocCompactionService;
  /** Injectable streamText (tests substitute a fake without `mock.module("ai")`). */
  readonly streamText?: typeof streamText;
}

// ─── Kind context ────────────────────────────────────────────────────────────

/** The turn-start sidechat context — SC-3b's load, reshaped by SC-4d: the
 *  STATIC package string (loaded AFTER the RP sync) + the frozen events as
 *  flow-ready user-message bodies placed by the merged timeline's order.
 *  Since SC-10 the helper also returns the sync's SC-2a branch view: the
 *  turn's search session consumes THIS view ("one view per turn") — never a
 *  second branch read or dry RP assembly per search. The package parts are
 *  the shape SC-4b's assembly below consumes directly.
 *
 *  Since SC-17 the turn may carry attached RP variants (`attachedVariants`,
 *  the request's pairs): they freeze BETWEEN the sync and the SC-3b load —
 *  above the sync's events, below the user message the generic loop persists
 *  next, and already visible to the load's listTimeline read so THIS turn's
 *  prompt carries the frozen `<rp_variants>` rows. */
async function loadSidechatTurnContext(
  deps: SidechatStreamDeps,
  threadId: ExperienceCopilotThread["id"],
  attachedVariants?: readonly AttachedVariantPair[],
): Promise<SidechatContextPackage & { branchView: RpBranchView }> {
  const branchView = await syncBeforeUserMessage(deps.sync, threadId);
  // SC-17: the variant-attach freeze — AFTER SC-2c's sync (its events land at
  // seqs above the sync's delta), BEFORE the loop persists the user message
  // (they anchor below it on the merged timeline) and BEFORE the SC-3b
  // loader's listTimeline read (this turn's prompt already sees them). A
  // foreign pair throws the typed validation before any freeze — the turn
  // refuses, nothing is written.
  if (attachedVariants !== undefined && attachedVariants.length > 0) {
    await attachVariantsBeforeUserMessage(deps.attach, threadId, attachedVariants);
  }
  return { ...(await loadSidechatContext(deps.context, threadId)), branchView };
}

// ─── Assembly (SC-4b, reshaped by SC-4d; digest-aware since SC-8c) ────────

/** The sidechat assembly's own result (SC-8c): the generic assembled prompt
 *  plus the auto-compaction pressure the kind's rule measures — the assembly
 *  is the one place that knows both the discussion's size (digest + OOC
 *  rows) and the room left for it (budget − static context − RP layer). */
export interface SidechatAssembledPrompt extends AgentAssembledPrompt {
  readonly autoCompactPressure: SidechatAutoCompactPressure;
}

/** A flow entry tagged with the meter segment its tokens feed (SC-9). The
 *  budget trim keeps entry OBJECTS (it slices suffixes), so the tag survives
 *  `planHistoryCompaction` and the assembly measures the meter split on the
 *  trimmed window — the same entries the model saw — without a second
 *  derivation of which entry is what. */
type SidechatMeteredFlowMessage = AgentFlowMessage & {
  readonly meterSegment: SidechatOocMeterSegmentKey;
};

/** Tag every real history row (the OOC conversation — user, assistant, tool
 *  rows alike) as discussion (SC-9): none of them is RP-layer material. */
function toDiscussionEntry(message: AgentFlowMessage): SidechatMeteredFlowMessage {
  return { ...message, meterSegment: "discussion" };
}

/**
 * Build the turn's message flow (SC-4d, variant A; digest-aware since SC-8c):
 * the loop's real history — tool parts intact — with each frozen RP event
 * injected as its own user-role message at its merged-timeline position (the
 * loader's `precedingMessages` counts; NO seq arithmetic here — listTimeline's
 * merged order is the single ordering source). Consecutive user messages are
 * fine: they follow the CX-3 precedent (the pinned block already rides as a
 * user message before the turn's own). The turn's own user message (content
 * mode — the loop appends it LAST) re-attaches LAST: every frozen event
 * predates it by the sync-before-persist order, so events never displace it.
 *
 * Since SC-9 every returned entry carries its meter segment (discussion for
 * the OOC rows, the event's own classification for RP rows) — see
 * {@link SidechatMeteredFlowMessage}.
 *
 * DIGEST SPLITS (SC-8c — this replaces the SC-4d count guard): after a
 * compaction the loop's history carries only the rows past the digest's
 * anchor while the loader's timeline still counts every row (the store keeps
 * them for the UI — the digest replaces them in the MODEL WINDOW only). The
 * covered count is derived, never trusted blind: `timeline − history − the
 * digest row itself`. OOC rows covered by the digest leave BOTH the history
 * and the event placement; RP events before the boundary stay where SC-6
 * puts them — they lead the flow (in frozen order) and the digest row is
 * handed back separately so the assembly can seat it between that RP layer
 * and the verbatim tail (the flow builder itself never renders the digest).
 * A count that would go NEGATIVE (a history longer than the timeline) or a
 * covered remainder on a digest-less thread is still refused — both are
 * impossible by construction (the two reads share the pre-persist store
 * state), so a hit means corruption, in the corrupt-payload refusal family.
 * Pure — every input is a parameter.
 */
function buildSidechatMessageFlow(
  historyFlow: readonly AgentFlowMessage[],
  context: SidechatContextPackage,
  hasUserPush: boolean,
  hasDigest: boolean,
): { flow: SidechatMeteredFlowMessage[]; headCount: number } {
  const last = historyFlow[historyFlow.length - 1];
  if (hasUserPush && (last === undefined || last.role !== "user")) {
    throw new Error(
      "buildSidechatMessageFlow: content-mode history must end with the turn's own user message " +
        "(the generic loop appends it last) — refusing to assemble a mismatched flow",
    );
  }
  const realMessages: SidechatMeteredFlowMessage[] = (
    hasUserPush && last !== undefined ? historyFlow.slice(0, -1) : [...historyFlow]
  ).map(toDiscussionEntry);
  // Digest-aware alignment: the timeline's message count minus the history's
  // rows (minus the digest row itself, which the timeline counts as a
  // message row but the loop lifts out of the flow).
  const coveredCount = context.messageCount - realMessages.length - (hasDigest ? 1 : 0);
  if (coveredCount < 0 || (!hasDigest && coveredCount > 0)) {
    // Impossible by construction (both reads share the pre-persist store
    // state and the same table): a hit means corruption — refuse rather than
    // assemble a flow the model would misread.
    throw new Error(
      `buildSidechatMessageFlow: history carries ${realMessages.length} flow messages against ` +
        `${context.messageCount} timeline message rows (${coveredCount} covered) — the counts cannot ` +
        "reconcile; refusing to assemble a mismatched flow",
    );
  }
  // Pre-boundary RP events lead the flow (the SC-8c assembly seats the digest
  // after them, before the verbatim tail); post-boundary events interleave
  // into the tail exactly as SC-4d placed them (the counts shift by the rows
  // the digest covered).
  const head: SidechatMeteredFlowMessage[] = [];
  const tail = [...realMessages];
  let inserted = 0;
  for (const event of context.eventMessages) {
    if (event.precedingMessages <= coveredCount) {
      head.push({ role: "user", content: event.content, meterSegment: event.meterSegment });
      continue;
    }
    // Events arrive in merged-timeline order, so the offset count is each
    // event's stable index among the tail's already-placed entries
    // (same-position events stay in their frozen order).
    tail.splice(event.precedingMessages - coveredCount + inserted, 0, {
      role: "user",
      content: event.content,
      meterSegment: event.meterSegment,
    });
    inserted += 1;
  }
  const flow = [...head, ...tail];
  if (hasUserPush && last !== undefined) flow.push(toDiscussionEntry(last));
  return { flow, headCount: head.length };
}

/** Assemble the sidechat prompt: system message = the profile's base prompt +
 *  (any digest section) + the SC-3b STATIC package — the volatile context
 *  section with NO timeline in it (SC-4d: the frozen events and the OOC
 *  conversation both ride the message flow, so the model reads ONE
 *  chronological flow); the frozen events interleave as user-role message
 *  bodies placed by the merged timeline's order, and over the shared budget
 *  the SHELL's existing trim (planHistoryCompaction) drops the OLDEST merged
 *  flow entries first — RP and discussion alike, in time order (SC-6, owner
 *  2026-10-20: the assistant loses the start of the story together with the
 *  talk about it, never one without the other). After a compaction (SC-8c)
 *  the digest rides the flow as its own user-role message — the shell's
 *  digest-section rendering — seated AFTER the pre-boundary RP layer and
 *  BEFORE the verbatim tail (static context → RP layer → digest → tail):
 *  re-inserted after the trim so the budget walk can never eat it, its
 *  tokens riding the digest segment (the shell's accounting). The result
 *  also carries the kind's auto-compaction pressure (SC-8c): the discussion
 *  (digest + OOC rows) against the room left after the static context and
 *  the RP layer, and since SC-9 the kind's FIVE meter segments in
 *  `tokenAccounting.segments` (`context` / `rp_summaries` / `rp_messages` /
 *  `digest` / `discussion`), measured on this same accounting pass — the
 *  single place all five numbers exist (no second tokenizer pass anywhere
 *  else). The pinned-context block +
 *  the kind's recency anchor inject as trailing user messages (the CX-3
 *  pattern the other kinds' assemblers use). Pure — every input is a
 *  parameter; exported so the trim's flow semantics are testable directly. */
export function assembleSidechatPrompt(input: {
  basePrompt: string;
  context: SidechatContextPackage;
  history: readonly AgentHistoryMessage[];
  /** Content mode: the loop appended the turn's own user message LAST. */
  hasUserPush: boolean;
  attachedContextBlock: string;
  recencyAnchorText: string;
  model?: string;
  /** The kind's shared owner-fixed budget pair (the seams' limits) — the SC-6
   *  overflow trim runs against these, never a kind-specific number. */
  contextBudgetTokens: number;
  responseReserveTokens: number;
}): SidechatAssembledPrompt {
  if (input.model !== undefined) setModelHint(input.model);

  // Digest lift (the generic loop's CM-3 contract: it pre-splits at the
  // boundary and hands the LAST digest back at the front of the history —
  // honored here rather than silently dropped). Since SC-8c a digest IS
  // born (the sidechat's compaction service appends it through the shell's
  // generic mechanism), and the assembly seats it in the FLOW (below),
  // never in the system message.
  const digestMessages = input.history.filter((m) => m.role === "digest");
  const lastDigest = digestMessages.length > 0 ? digestMessages[digestMessages.length - 1] : null;
  const digestText = lastDigest !== null && lastDigest.role === "digest" ? lastDigest.content : null;
  const historyFlow: AgentFlowMessage[] = input.history.filter(
    (m): m is AgentFlowMessage => m.role !== "digest",
  );
  const digestSectionText = digestText !== null ? renderDigestSection(digestText) : "";

  // System message (SC-4d, unchanged by SC-8c): STABLE base prompt + the
  // SC-3b STATIC package — no timeline section, and no digest section either
  // (the digest rides the message flow after the pre-boundary RP layer).
  const systemMessage = [input.basePrompt, "", input.context.staticPackage].join("\n");

  // Message flow (SC-4d, digest-aware since SC-8c): the real OOC history with
  // the frozen RP events interleaved as user-role messages placed by the
  // merged timeline's order — the OOC conversation exists in the prompt
  // exactly once. `headCount` is the pre-boundary RP layer's size (where the
  // digest seats, after the trim).
  const { flow, headCount } = buildSidechatMessageFlow(
    historyFlow,
    input.context,
    input.hasUserPush,
    digestText !== null,
  );

  const systemTokens = estimateTokens(systemMessage);
  const digestTokens = digestSectionText ? estimateTokens(digestSectionText) : 0;
  const attachedTokens = input.attachedContextBlock
    ? estimateTokens(input.attachedContextBlock) + estimateTokens(input.recencyAnchorText)
    : 0;

  // ── SC-6 overflow: the shell's existing budget trim over the MERGED flow.
  // planHistoryCompaction keeps the largest fitting suffix — the oldest flow
  // entries drop first, whatever their kind (rp_summary row, rp_message row,
  // OOC row alike): RP and discussion recede together, in time order, never
  // one without the other. No sidechat-specific trim, no kind carve-outs;
  // the attached block is injected AFTER this (the CX-3 rule) but its tokens
  // are paid here, exactly like the other assemblers' trim. The digest rides
  // the nonHistory side of this arithmetic (its tokens are pressure the trim
  // cannot recover) and is re-inserted into the flow AFTERWARDS — the trim
  // can shrink the RP layer and the tail, never the digest itself.
  const nonHistoryTokens = systemTokens + digestTokens + attachedTokens;
  const plan = planHistoryCompaction({
    messages: flow,
    nonHistoryTokens,
    contextBudget: input.contextBudgetTokens,
    responseReserve: input.responseReserveTokens,
    countHistoryTokens: estimateHistoryTokens,
  });
  const trimmedFlow = plan ? [...plan.messages] : [...flow];
  // The history segment and the summary line are measured BEFORE the digest
  // message seats — its tokens ride the digest segment, exactly the shell's
  // accounting (a digest in the flow must not double-count).
  const historyTokens = estimateHistoryTokens(trimmedFlow);
  // ── SC-9 meter split: the three history-segment values, measured HERE —
  // the one accounting point that already knows both the whole (the same
  // `estimateHistoryTokens` call the trim's arithmetic used, above) and each
  // entry's class (the flow tags the loader + flow builder derived). The two
  // RP classes are measured per class; `discussion` takes the REMAINDER of
  // the authoritative whole so the five segments reconstruct the metered
  // total exactly — never a rounding hole (the per-class formatter joins add
  // a few separator/rounding tokens the residual absorbs).
  const rpSummariesTokens = estimateHistoryTokens(
    trimmedFlow.filter((m) => m.meterSegment === "rp_summaries"),
  );
  const rpMessagesTokens = estimateHistoryTokens(
    trimmedFlow.filter((m) => m.meterSegment === "rp_messages"),
  );
  const discussionTokens = historyTokens - rpSummariesTokens - rpMessagesTokens;
  const compactionSummary = plan
    ? `Kept ${trimmedFlow.length} of ${flow.length} flow messages (budget-trimmed to ~${plan.preservedHistoryTokens} tokens, budget=${input.contextBudgetTokens}, reserve=${input.responseReserveTokens}).`
    : undefined;
  // Seat the digest after the SURVIVING pre-boundary RP layer: the trim kept
  // a suffix, so the surviving head is however much of it outlived the cut.
  const windowedFlow = trimmedFlow;
  if (digestSectionText) {
    const dropped = flow.length - windowedFlow.length;
    const survivingHeadCount = Math.max(0, headCount - dropped);
    windowedFlow.splice(survivingHeadCount, 0, {
      role: "user",
      content: digestSectionText,
      meterSegment: "digest",
    });
  }

  // ── SC-8c auto-compaction pressure: the discussion against the room it
  // has. The discussion = the digest + the OOC rows as they exist (the
  // history flow the loop handed in, pre-trim — what a compaction would
  // fold); the room = the budget minus the static context (system +
  // attached) and the RP layer — the two things compacting the discussion
  // cannot shrink. The assembly is the one place both numbers exist; the
  // stream hands them to the compaction service's sidechat rule. The SPLIT
  // mirrors the meter segments (digest + discussion = the pressure's
  // discussion; every event row = its RP layer) on the PRE-TRIM base — the
  // pressure measures what a compaction would fold, the segments above
  // measure the trimmed window the model saw.
  const rpLayerTokens = estimateHistoryTokens(
    input.context.eventMessages.map((event) => ({ role: "user" as const, content: event.content })),
  );
  const autoCompactPressure: SidechatAutoCompactPressure = {
    discussionTokens: digestTokens + estimateHistoryTokens(historyFlow),
    roomTokens: input.contextBudgetTokens - (systemTokens + attachedTokens) - rpLayerTokens,
  };

  const messages: AgentPromptMessage[] = [{ role: "system", content: systemMessage }, ...windowedFlow];
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

  // SC-9: the kind's five meter segments, keyed by the ONE key list —
  // `context` folds the system message (base prompt + static package) and
  // the attached block (`@` links + anchor) into the single "everything
  // constant" bucket; the three history-segment values and the digest come
  // from the measurements above. Sum == the assembler's total by
  // construction (the discussion remainder closes the arithmetic).
  const meterSegmentTokens: Record<SidechatOocMeterSegmentKey, number> = {
    context: systemTokens + attachedTokens,
    rp_summaries: rpSummariesTokens,
    rp_messages: rpMessagesTokens,
    digest: digestTokens,
    discussion: discussionTokens,
  };

  return {
    systemMessage,
    messages,
    autoCompactPressure,
    tokenAccounting: {
      system: systemTokens,
      digest: digestTokens,
      history: historyTokens,
      attached: attachedTokens,
      total: systemTokens + digestTokens + historyTokens + attachedTokens,
      segments: SIDECHAT_OOC_METER_SEGMENT_KEYS.map((key) => ({
        key,
        tokens: meterSegmentTokens[key],
      })),
    },
    ...(compactionSummary !== undefined ? { compactionSummary } : {}),
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
  // The kind's shared owner-fixed limits — one object feeds both consumers
  // (the loop's metrics + tool ceiling, and the assembly's SC-6 trim).
  const limits = {
    contextBudgetTokens: COPILOT_CONTEXT_BUDGET_TOKENS,
    responseReserveTokens: COPILOT_RESPONSE_RESERVE_TOKENS,
    toolLoopCeiling: COPILOT_TOOL_LOOP_CEILING,
  };
  // SC-8c: this turn's auto-compaction pressure — written by the assemble
  // seam, read by the auto hook the generic loop fires after the turn's
  // metrics persist. Per-turn state of THIS generator call only.
  let autoCompactPressure: SidechatAutoCompactPressure | null = null;
  // SC-10: this turn's branch view — written by the loadContext seam (the
  // sync's SC-2a view), read by the buildTools seam's search session. Per-turn
  // state of THIS generator call only, exactly like the pressure above.
  let turnBranchView: RpBranchView | null = null;
  const seams: AgentStreamSeams<
    ExperienceCopilotStreamRequest,
    ExperienceCopilotThread,
    SidechatContextPackage,
    CopilotProfile,
    SidechatAssembledPrompt
  > = {
    logChannelPrefix: "api.sidechat-ooc",
    threadLabel: "ExperienceCopilotThread",
    limits,

    // ── The kind's turn: RP sync FIRST, then the SC-17 variant-attach freeze
    //  (only on turns that carry `attachedVariants`), then the SC-3b load
    //  (static package + flow-placed events). This seam runs BEFORE the
    //  generic loop persists the user message, which is what puts the frozen
    //  delta — sync and attached variants alike — below the turn's own seq on
    //  the merged timeline. Since SC-10 the sync's branch view is captured for
    //  the turn's search session (below). ──
    loadContext: async (thread) => {
      const loaded = await loadSidechatTurnContext(deps, thread.id, request.attachedVariants);
      turnBranchView = loaded.branchView;
      return loaded;
    },

    // ── Agent profile: sidechat threads are ALWAYS chat-owned (the kind
    //  owns its threads), so the chat chain is the only path — the SC-0f
    //  seam when wired, the built-in seed otherwise (tests). The owner test
    //  also narrows the thread for the seam AND refuses a non-chat-owned row
    //  (unreachable through the dispatch; the corruption guard). ──
    resolveProfile: (thread) =>
      deps.resolveProfileForChat && isChatOwnedAgentThread(thread)
        ? deps.resolveProfileForChat(thread)
        : resolveBuiltinSidechatOocProfile(deps.db),

    // ── SC-4b/SC-4d assembly (digest-aware since SC-8c): base prompt +
    //  STATIC package in the system message, frozen events interleaved into
    //  the flow, the digest seated after the pre-boundary RP layer (+ pinned
    //  context + anchor before the turn's own user message). The assembly's
    //  auto-compaction pressure is captured for the turn's auto hook — the
    //  loop fires it only after a COMPLETED turn, by which time this seam
    //  has run, so the closure below always reads this turn's numbers. ──
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
      const assembled = assembleSidechatPrompt({
        basePrompt: agentProfile.basePrompt,
        context,
        history,
        hasUserPush: request.content !== undefined,
        attachedContextBlock,
        recencyAnchorText: getAgentKind("sidechat-ooc").recencyAnchorText,
        contextBudgetTokens: limits.contextBudgetTokens,
        responseReserveTokens: limits.responseReserveTokens,
        ...(model !== undefined ? { model } : {}),
      });
      autoCompactPressure = assembled.autoCompactPressure;
      return assembled;
    },

    // ── SC-10 + SC-11 + SC-12: the kind's tools. The search pair
    //  (kinds/sidechat/sidechat-search-tools.ts) over a per-turn session:
    //  the ONE extracted store-reads mapping (NO Co-Author skill catalog —
    //  the sidechat's skills come through `@` pins, SC-5), the chat's active
    //  scope, and THIS turn's branch view (the sync's — never a second
    //  branch read or dry RP assembly). SC-11 adds `propose_objective`
    //  (kinds/sidechat/sidechat-objective-tools.ts), which needs no
    //  per-turn state and therefore rides the same profile gating even
    //  when the search mapping is absent. SC-12 closes the set: `todo`
    //  (the shared session-checklist factory, persisted through the
    //  thread store's `updateTodo` — kinds/sidechat/sidechat-checklist-
    //  tools.ts) and `read_plan` (the shared plan tools READ-ONLY over the
    //  thread row's own chat + branch — no plan-write tool is ever built).
    //  Served only when the RESOLVED profile's tool set enables them (a tool
    //  landed with its toggle off is not landed); the ownership narrowing
    //  is the same corruption guard resolveProfile uses. ──
    buildTools: ({ thread, agentProfile }) => {
      if (!isChatOwnedAgentThread(thread)) return {};
      // A null branchId on a chat-owned row is corruption — loadContext's
      // sync (SC-2c) already refused it before this seam, so this throw is
      // unreachable in practice; it narrows the type for the plan owner
      // below (never read through, same guard as the context loader).
      if (thread.branchId === null) throw new RpSyncThreadNotChatOwnedError(thread.id);
      const search =
        deps.searchStoreReads !== undefined
          ? buildSidechatSearchTools({
              session: createContextSearchSession(
                deps.searchStoreReads,
                async () => {
                  const chat = await deps.context.chats.getById(thread.chatId);
                  return {
                    activeCharacterId: chat?.characterId ?? null,
                    activePersonaId: chat?.personaId ?? null,
                  };
                },
                () => Promise.resolve(turnBranchView),
              ),
              toolSet: agentProfile.toolSet,
            })
          : {};
      const checklist = buildSidechatChecklistTools({
        toolSet: agentProfile.toolSet,
        // The plan owner is the THREAD ROW's own pair — never the request
        // (SC-12's contract; the same row the sync/context seams read).
        owner: { chatId: thread.chatId, branchId: thread.branchId },
        // updateTodo(threadId, items) is the store's structural twin of the
        // checklist factory's `(items) => Promise<void>` dep (the same seam
        // the experience kind wires).
        saveTodo: (items) => deps.store.updateTodo(thread.id, items),
        agentPlans: deps.agentPlans,
      });
      return {
        ...search,
        ...buildSidechatObjectiveTools({ toolSet: agentProfile.toolSet }),
        ...checklist,
      };
    },
  };

  const streamDeps: AgentStreamDeps<ExperienceCopilotThread> = {
    store: deps.store,
    getProviderProfile: deps.getProviderProfile,
    getEffectiveProviderProfile: deps.getEffectiveProviderProfile,
    resolveModel: deps.resolveModel,
    // SC-8c auto-compaction: the kind's own rule — the discussion against
    // the room left after the static context and the RP layer — through the
    // sidechat compaction service, with THIS turn's assembly pressure. The
    // generic loop fires the hook fire-and-forget after the metrics persist;
    // absent service (tests, legacy harnesses) → the sidechat never
    // auto-compacts (the manual route still serves the kind).
    ...(deps.compaction !== undefined
      ? {
          autoCompact: (threadId: string) => {
            const pressure = autoCompactPressure;
            if (pressure === null) return Promise.resolve();
            return deps.compaction!.autoCompactAfterSidechatTurn(threadId, pressure);
          },
        }
      : {}),
    ...(deps.streamText !== undefined ? { streamText: deps.streamText } : {}),
  };

  yield* streamAgentTurn(request, streamDeps, seams, signal);
}
