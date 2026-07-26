import { create } from "zustand";

// ────────────────────────────────────────────────────────────────────────────
// Chat notifications store — UI state for background server→browser events (W7)
// ────────────────────────────────────────────────────────────────────────────
// Fed by `useChatEvents` (the per-chat SSE subscription). The memory badge
// mirrors the auto-summary lifecycle as a three-state indicator:
//   idle       → green dot (nothing happening)
//   generating → spinner (a summary is being generated right now)
//   ready      → checkmark (a summary just landed; auto-reverts to idle)
//
// Plain (non-immer) zustand — this is ephemeral UI state, not canonical data.
// ────────────────────────────────────────────────────────────────────────────

export type SummaryBadgeStatus = "idle" | "generating" | "ready";

export interface SummaryReady {
  readonly summaryId: string;
  readonly label: string;
  /**
   * Monotonic counter so two summaries landing in quick succession each
   * re-trigger the ready animation. Components key off `seq`, not the id.
   */
  readonly seq: number;
}

interface ChatNotificationsState {
  /** The current badge indicator state. */
  status: SummaryBadgeStatus;
  /** Set when status flips to "ready" — drives the toast + the checkmark auto-revert. */
  ready: SummaryReady | null;
  /** A summary generation has started — show the spinner. */
  setGenerating: () => void;
  /** A summary has landed — show the checkmark + carry the payload for the toast. */
  setReady: (summaryId: string, label: string) => void;
  /** Back to idle (ready dismissed, or a failure interrupted the spinner). */
  setIdle: () => void;
}

export const useChatNotifications = create<ChatNotificationsState>((set) => ({
  status: "idle",
  ready: null,
  setGenerating: () => set({ status: "generating", ready: null }),
  setReady: (summaryId, label) =>
    set((s) => ({ status: "ready", ready: { summaryId, label, seq: (s.ready?.seq ?? 0) + 1 } })),
  setIdle: () => set({ status: "idle", ready: null }),
}));
