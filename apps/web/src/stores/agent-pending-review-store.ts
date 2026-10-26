import { create } from "zustand";
import { agentThreadKey, type AgentI18nKey, type AgentKind } from "../lib/agent-host-registry.js";

/**
 * Agent pending-review summary store (AP-15, AGENT_SHELL_POLISH Wave 4) —
 * the ONE plain per-thread seam between a host's review session and the
 * shell's pending-changes strip (AP-16 renders that strip from here; nothing
 * reads this store yet — AP-15 is invisible plumbing by design).
 *
 * WHY A STORE (not prop drilling): the strip lives in the generic shell
 * (above the composer) while the pending state is owned by each host's
 * editor pane — different subtrees, host-agnostic shell. The per-thread key
 * (`agentThreadKey(kind, threadId)`, the single derivation every agent store
 * shares) isolates concurrent hosts; the experience kind keeps its legacy
 * bare threadId, later kinds namespace.
 *
 * OWNERSHIP CONTRACT — the store only HOLDS what consumers register:
 * `acceptAll` (the strip's accept-pending-hunks action) and `open` (the
 * strip's open-the-review-surface action) belong to the LIVE review session
 * that published the entry. Publishers must therefore:
 *   - republish whenever the pending counts change (proposal lands, hunk
 *     accepted/dismissed),
 *   - clear the entry when nothing is pending anymore, and
 *   - clear the entry on unmount / thread switch — the callables die with
 *     the pane, and the store must never hold a stale one.
 * While a turn streams the review objects go null (the frozen editor shows
 * no review); the published entry follows that visibility — it republishes
 * when the round reappears after the turn settles (dangling capture
 * included). The summary carries i18n KEYs, never rendered strings: the
 * label keys come from the host descriptor's `bufferSpecs` (the one
 * declaration of buffer labels), so the future strip translates them.
 */

/** One buffer's pending-review summary: its label KEY (descriptor-declared)
 *  and the count of still-pending hunks (1 in the tooLarge wholesale path). */
export interface AgentPendingBufferSummary {
  labelKey: AgentI18nKey;
  pending: number;
}

/** The per-thread pending-review summary a review session publishes. */
export interface AgentPendingReviewSummary {
  /** Buffers with pending hunks, in the descriptor's bufferSpecs order. */
  buffers: AgentPendingBufferSummary[];
  /** Accept every pending hunk of every buffer (registered by the session). */
  acceptAll: () => void;
  /** Open the review surface (registered by the session's host pane). */
  open: () => void;
}

interface AgentPendingReviewState {
  summariesByThread: Record<string, AgentPendingReviewSummary>;
  /** Write the thread's summary (replaces any prior entry wholesale). */
  publish: (kind: AgentKind, threadId: string, summary: AgentPendingReviewSummary) => void;
  /** Drop the thread's entry (no-op when nothing is stored). */
  clear: (kind: AgentKind, threadId: string) => void;
}

export const useAgentPendingReviewStore = create<AgentPendingReviewState>((set) => ({
  summariesByThread: {},
  publish: (kind, threadId, summary) => {
    const key = agentThreadKey(kind, threadId);
    set((state) => ({ summariesByThread: { ...state.summariesByThread, [key]: summary } }));
  },
  clear: (kind, threadId) => {
    const key = agentThreadKey(kind, threadId);
    set((state) => {
      if (state.summariesByThread[key] === undefined) return state;
      const summariesByThread = { ...state.summariesByThread };
      delete summariesByThread[key];
      return { summariesByThread };
    });
  },
}));
