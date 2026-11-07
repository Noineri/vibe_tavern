/**
 * The sidechat-OOC prompt assembly (SIDECHAT_PLAN SC-4b, reshaped by SC-4d,
 * digest-aware since SC-8c, story-plan-metered since DR-4b) — the PURE
 * assembly of one sidechat turn: the system message (base prompt + the SC-3b
 * STATIC package), the message flow (the real OOC history with the frozen RP
 * events interleaved by the merged timeline's order), the SC-6 budget trim
 * and the SC-9/DR-4b token meter. Extracted from `sidechat-stream.ts` when
 * the arch-gate's 800-line cap caught that file's growth — DR-4b,
 * extraction-only, byte-identical code; the stream owns the SEAMS, this
 * module owns the pure prompt arithmetic (every input a parameter, exported
 * so the flow/trim semantics stay testable directly).
 */

import { estimateTokens, planHistoryCompaction, setModelHint } from "@vibe-tavern/prompt-pipeline";
import {
  estimateHistoryTokens,
  renderDigestSection,
  type AgentFlowMessage,
  type AgentHistoryMessage,
} from "../agent/agent-prompt.js";
import type { AgentAssembledPrompt, AgentPromptMessage } from "../agent/agent-stream.js";
import type { SidechatAutoCompactPressure } from "./sidechat-compaction.js";
import {
  SIDECHAT_OOC_METER_SEGMENT_KEYS,
  type SidechatContextPackage,
  type SidechatOocMeterSegmentKey,
} from "./sidechat-context.js";

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
 *  the RP layer, and since SC-9/DR-4b the kind's SIX meter segments in
 *  `tokenAccounting.segments` (`context` / `story_plan` / `rp_summaries` /
 *  `rp_messages` / `digest` / `discussion`), measured on this same accounting
 *  pass — the single place all six numbers exist (no second tokenizer pass
 *  anywhere else). The pinned-context block +
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
  // DR-4b: the story-plan section's own tokens — its own meter segment. The
  // section already rides the system message (inside staticPackage), so the
  // `context` segment takes the REMAINDER (the same reconstruction discipline
  // as the discussion remainder below: the segments always sum to the metered
  // total exactly, and tokenizer join-boundary tokens land in the remainder).
  // DK-5b: the twist-deck section's tokens meter into the SAME `story_plan`
  // segment (the owner-sanctioned fold — the deck is story-direction
  // material); the one-line `<story_time>` section stays in the remainder.
  const storyPlanTokens = input.context.storyPlanSection !== null
    ? estimateTokens(input.context.storyPlanSection)
    : 0;
  const storyDeckTokens = input.context.storyDeckSection !== null
    ? estimateTokens(input.context.storyDeckSection)
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

  // SC-9 + DR-4b: the kind's six meter segments, keyed by the ONE key list —
  // `context` folds the system message minus the story-plan AND twist-deck
  // sections (base prompt + the rest of the static package, the one-line
  // `<story_time>` included, DK-5b) and the attached block (`@` links +
  // anchor) into the single "everything constant" bucket; `story_plan`
  // carries the plan + deck sections the loader rendered; the three
  // history-segment values and the digest come from the measurements above.
  // Sum == the assembler's total by construction (the two remainder closes —
  // story_plan out of context, discussion out of history — keep the
  // arithmetic exact).
  const meterSegmentTokens: Record<SidechatOocMeterSegmentKey, number> = {
    context: systemTokens + attachedTokens - storyPlanTokens - storyDeckTokens,
    story_plan: storyPlanTokens + storyDeckTokens,
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
