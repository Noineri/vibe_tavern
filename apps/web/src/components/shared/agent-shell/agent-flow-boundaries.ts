import type { OrderedCopilotMessage } from "../../../lib/copilot-context.js";

/**
 * The visible-flow boundaries the agent feed's turn rows derive from
 * (AP-11 / AP-33) — extracted from `AgentMessageList.tsx` under the
 * file-size ratchet (the list sat at the 800-line cap).
 *
 * AP-33: the folded boundary is the last digest's ANCHOR (the first kept
 * message — the id the digest carries in its `toolCallId`), never the
 * digest's own slot. The digest renders at the compaction moment, LATER
 * than its anchor, and the kept tail between the two must stay
 * deletable/editable exactly as when the digest sat at its anchor:
 * covered = strictly before the anchor either way (the same kept set the
 * server's `resolveDigestBoundary` computes — anchor-found rows split
 * there). A dangling anchor (the kept row itself deleted, or an anchor
 * naming no visible row) degrades to the visible end — everything
 * covered, the conservative end placement the digest ordering uses.
 *
 * Pure — no React, no store reads.
 */

/** The boundaries `buildAgentTurnRow` consumes. */
export interface AgentFlowBoundaries {
  /** The last user row's visible slot (regenerate = past it; -1 when the
   *  thread has no user row — the whole feed is one turn). */
  lastUserVisibleIndex: number;
  /** The last digest's ANCHOR slot — the first kept message (delete/edit
   *  hide strictly BEFORE it; the visible end when the anchor dangles;
   *  null = no digest). */
  lastDigestAnchorVisibleIndex: number | null;
}

/** Derive the turn-row boundaries from the digest-ordered visible flow. */
export function agentFlowBoundaries(
  visibleMessages: readonly OrderedCopilotMessage[],
): AgentFlowBoundaries {
  let userIdx = -1;
  let digestIdx = -1;
  visibleMessages.forEach((entry, index) => {
    if (entry.message.role === "user") userIdx = index;
    else if (entry.message.role === "digest") digestIdx = index;
  });
  let anchorIdx: number | null = null;
  if (digestIdx >= 0) {
    const anchorId = visibleMessages[digestIdx]!.message.toolCallId;
    const found = anchorId != null
      ? visibleMessages.findIndex((entry) => entry.message.id === anchorId)
      : -1;
    anchorIdx = found >= 0 ? found : visibleMessages.length;
  }
  return { lastUserVisibleIndex: userIdx, lastDigestAnchorVisibleIndex: anchorIdx };
}
