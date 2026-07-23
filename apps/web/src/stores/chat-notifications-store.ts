import { create } from "zustand";

// ────────────────────────────────────────────────────────────────────────────
// Chat notifications store — UI state for background server→browser events (W7)
// ────────────────────────────────────────────────────────────────────────────
// Fed by `useChatEvents` (the per-chat SSE subscription). The only producer
// today is the auto-summary `summary.generated` notification, but the store is
// generic enough to carry future background-event UI flags (insights-done,
// scene-ready…) by extension, not rewrite.
//
// Plain (non-immer) zustand — this is ephemeral UI state, not canonical data.
// ────────────────────────────────────────────────────────────────────────────

/** A pulse waiting to be consumed by the memory badge / a toast. */
export interface SummaryPulse {
  readonly summaryId: string;
  readonly label: string;
  /**
   * Monotonic counter so two pulses with the same summaryId (or two pulses in
   * quick succession) each re-trigger the badge animation. Components key off
   * `seq`, not the id.
   */
  readonly seq: number;
}

interface ChatNotificationsState {
  /** The most recent unconsumed summary pulse, or null. */
  pulse: SummaryPulse | null;
  /** Record a fresh auto-summary landing. */
  triggerSummaryPulse: (summaryId: string, label: string) => void;
  /** Clear the pulse (called by the badge on click or after the animation). */
  clearSummaryPulse: () => void;
}

export const useChatNotifications = create<ChatNotificationsState>((set) => ({
  pulse: null,
  triggerSummaryPulse: (summaryId, label) =>
    set((s) => ({ pulse: { summaryId, label, seq: (s.pulse?.seq ?? 0) + 1 } })),
  clearSummaryPulse: () => set({ pulse: null }),
}));
