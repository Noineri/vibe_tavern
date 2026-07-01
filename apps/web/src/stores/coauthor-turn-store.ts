import { create } from "zustand";
import type { CoauthorTarget } from "@vibe-tavern/api-contracts";

/**
 * Co-Author turn store (CA-9.2) — ephemeral, per-chat accumulation of the
 * active co-author turn's tool calls, fed by the tool SSE events parsed in
 * `sse-parser.ts` (CA-9.1) and wired in `use-chat-controller.executeStreamAction`.
 *
 * WHY A SEPARATE STORE (not chat-store generation state): the backend does NOT
 * persist tool calls onto the message record in V1 (the plan's "draft model —
 * no separate draft store" decision: each turn starts fresh from canonical,
 * cross-session persistence is deferred to CA-15). Reasoning survives the
 * turn-end snapshot refresh only because it IS persisted on the message; tool
 * activity has no persisted counterpart, so it would be wiped by the snapshot
 * ingest that fires at turn end. Keeping it here — outside snapshot-store /
 * chat-store — lets the activity (and CA-11's Apply, which aggregates it)
 * survive across the turn-end refresh within the session.
 *
 * Lifecycle: keyed by chatId → the LATEST turn's activities only (each turn
 * starts fresh). `clearTurn` is called at turn start (controller), on chat
 * switch, and on Apply/Reject (CA-11). Not persisted (no `persist` middleware).
 */

/** Lifecycle of a single tool call within a co-author turn. */
export type CoauthorToolStatus = "streaming" | "done" | "error";

/**
 * One tool call's accumulated state. The `tool-result` event finalizes the
 * entry with the proposal fields (summary/proposed/target/...); earlier events
 * (tool-call/tool-input-start) populate a `streaming` placeholder so the card
 * can render "AI is editing…" while args stream.
 */
export interface CoauthorToolActivity {
  toolCallId: string;
  toolName: string;
  status: CoauthorToolStatus;
  /** From CoauthorToolOutput — populated on tool-result. */
  summary?: string;
  target?: CoauthorTarget;
  proposed?: string;
  greetingIndex?: number;
  isAdd?: boolean;
}

interface CoauthorTurnState {
  turnsByChat: Record<string, CoauthorToolActivity[]>;
  /** Insert or merge (by toolCallId) an activity for a chat. */
  upsertActivity: (chatId: string, activity: CoauthorToolActivity) => void;
  /** Drop the active turn's activities for a chat (turn start / switch / Apply / Reject). */
  clearTurn: (chatId: string) => void;
  /** Read the activities for a chat (empty array if none). */
  getActivities: (chatId: string) => CoauthorToolActivity[];
}

export const useCoauthorTurnStore = create<CoauthorTurnState>((set, get) => ({
  turnsByChat: {},
  upsertActivity: (chatId, activity) =>
    set((s) => {
      const list = s.turnsByChat[chatId] ?? [];
      const idx = list.findIndex((a) => a.toolCallId === activity.toolCallId);
      // Merge by index so a streaming placeholder is finalized in place by the
      // later tool-result event (preserves order; later fields win on conflict).
      const next =
        idx === -1
          ? [...list, activity]
          : list.map((a, i) => (i === idx ? { ...a, ...activity } : a));
      return { turnsByChat: { ...s.turnsByChat, [chatId]: next } };
    }),
  clearTurn: (chatId) =>
    set((s) => {
      if (!s.turnsByChat[chatId]) return s;
      const next = { ...s.turnsByChat };
      delete next[chatId];
      return { turnsByChat: next };
    }),
  getActivities: (chatId) => get().turnsByChat[chatId] ?? [],
}));
