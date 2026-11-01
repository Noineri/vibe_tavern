import { create } from "zustand";
import { isRecord } from "@vibe-tavern/domain";

export const CHAT_READY_STORAGE_KEY = "vt.chat-ready.v1";

/** Browser-local unread markers, not canonical message/read-receipt state. */
export function readReadyChats(): Record<string, true> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CHAT_READY_STORAGE_KEY) ?? "{}");
    return isRecord(value) ? Object.fromEntries(Object.entries(value)
      .filter(([id, ready]) => id.length > 0 && ready === true).map(([id]) => [id, true as const])) : {};
  } catch {
    return {}; // Disabled storage or malformed old data must not block navigation.
  }
}

function writeReadyChats(ready: Record<string, true>): void {
  try { localStorage.setItem(CHAT_READY_STORAGE_KEY, JSON.stringify(ready)); }
  catch { /* Disabled storage/quota: keep the current session's markers in memory. */ }
}

/** Native chat runs only; agent sidechats must not make the character look busy. */
export function nativeRunChatId(value: unknown): string | null {
  if (!isRecord(value) || (value.kind !== "rp" && value.kind !== "coauthor")) return null;
  const owner = value.owner;
  return isRecord(owner) && owner.kind === "chat" && owner.mode === value.kind
    && typeof owner.chatId === "string" && owner.chatId.length > 0 && value.threadId === `chat:${owner.chatId}`
    ? owner.chatId : null;
}

interface ChatRunActivityStore {
  running: Record<string, true>;
  ready: Record<string, true>;
  setRunning: (chatId: string, running: boolean) => void;
  replaceRunning: (running: Record<string, true>) => void;
  markReady: (chatId: string) => void;
  markRead: (chatId: string) => void;
}

/** Lifecycle-only state: token deltas never rerender the navigation badges. */
export const useChatRunActivityStore = create<ChatRunActivityStore>()((set) => ({
  running: {},
  ready: readReadyChats(),
  setRunning: (chatId, running) => set((state) => {
    if (Boolean(state.running[chatId]) === running) return state;
    const next = { ...state.running };
    if (running) next[chatId] = true;
    else delete next[chatId];
    return { running: next };
  }),
  replaceRunning: (running) => set({ running }),
  markReady: (chatId) => set((state) => {
    if (state.ready[chatId] || state.running[chatId]) return state;
    const ready = { ...state.ready, [chatId]: true as const };
    writeReadyChats(ready);
    return { ready };
  }),
  markRead: (chatId) => set((state) => {
    if (!state.ready[chatId]) return state;
    const ready = { ...state.ready };
    delete ready[chatId];
    writeReadyChats(ready);
    return { ready };
  }),
}));
