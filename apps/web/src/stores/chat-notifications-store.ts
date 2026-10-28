import { create } from "zustand";

// ────────────────────────────────────────────────────────────────────────────
// Chat notifications store — UI state for background server→browser events (W7)
// ────────────────────────────────────────────────────────────────────────────
// Fed by `useChatEvents` (the per-chat SSE subscription). The memory badge
// mirrors manual and automatic summary lifecycles independently per chat:
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
  byChat: Record<string, SummaryNotificationState>;
  /** Keep the channel while a local request is awaiting its first server event. */
  holdsByChat: Record<string, number>;
  retain: (chatId: string) => (completedSummaryId?: string) => void;
  setGenerating: (chatId: string) => void;
  setReady: (chatId: string, summaryId: string, label: string) => void;
  /** A failure/cancel settles one run, not another concurrently running summary. */
  settle: (chatId: string) => void;
  /** Dismiss only a ready checkmark; stale timers cannot clear a newer result. */
  setIdle: (chatId: string, expectedSeq?: number) => void;
}

interface SummaryNotificationState {
  status: SummaryBadgeStatus;
  ready: SummaryReady | null;
  pending: number;
  seq: number;
  /** Last received completion for each summary, including regenerated summaries. */
  received: Record<string, number>;
}

const EMPTY: SummaryNotificationState = { status: "idle", ready: null, pending: 0, seq: 0, received: {} };

export const useChatNotifications = create<ChatNotificationsState>((set, get) => ({
  byChat: {},
  holdsByChat: {},
  retain: (chatId) => {
    const startSeq = get().byChat[chatId]?.seq ?? 0;
    set((state) => ({ holdsByChat: { ...state.holdsByChat, [chatId]: (state.holdsByChat[chatId] ?? 0) + 1 } }));
    let released = false;
    const release = () => {
      set((state) => {
        const holdsByChat = { ...state.holdsByChat };
        const remaining = (holdsByChat[chatId] ?? 1) - 1;
        if (remaining > 0) holdsByChat[chatId] = remaining;
        else delete holdsByChat[chatId];
        return { holdsByChat };
      });
    };
    return (completedSummaryId) => {
      if (released) return;
      released = true;
      // JSON and SSE use different connections: a fast JSON response must not
      // close the background channel before its completion event is delivered.
      const received = () => !completedSummaryId || (get().byChat[chatId]?.received[completedSummaryId] ?? 0) > startSeq;
      if (received()) return release();
      const unsubscribe = useChatNotifications.subscribe(() => {
        if (!received()) return;
        unsubscribe();
        release();
      });
    };
  },
  setGenerating: (chatId) => set((state) => {
    const previous = state.byChat[chatId] ?? EMPTY;
    return { byChat: { ...state.byChat, [chatId]: { ...previous, status: "generating", ready: null, pending: previous.pending + 1 } } };
  }),
  setReady: (chatId, summaryId, label) => set((state) => {
    const previous = state.byChat[chatId] ?? EMPTY;
    const pending = Math.max(0, previous.pending - 1);
    const seq = previous.seq + 1;
    return { byChat: { ...state.byChat, [chatId]: { status: pending > 0 ? "generating" : "ready", pending, seq, received: { ...previous.received, [summaryId]: seq }, ready: { summaryId, label, seq } } } };
  }),
  settle: (chatId) => set((state) => {
    const previous = state.byChat[chatId] ?? EMPTY;
    const pending = Math.max(0, previous.pending - 1);
    return { byChat: { ...state.byChat, [chatId]: { ...previous, pending, status: pending > 0 ? "generating" : "idle", ready: null } } };
  }),
  setIdle: (chatId, expectedSeq) => set((state) => {
    const previous = state.byChat[chatId];
    if (previous?.status !== "ready" || (expectedSeq !== undefined && previous.ready?.seq !== expectedSeq)) return state;
    return { byChat: { ...state.byChat, [chatId]: { ...previous, status: "idle", ready: null } } };
  }),
}));
