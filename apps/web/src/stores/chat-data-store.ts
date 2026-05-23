import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { AppMessage, AppSnapshot } from "../app-client.js";
import type { ChatId } from "@rp-platform/domain";

export interface MacroContext {
  characterName: string;
  personaName: string | null;
  personaDescription: string | null;
}

export interface ChatDataState {
  /** Character + persona + branches for current chat */
  chatMeta: {
    character: AppSnapshot["character"];
    persona: AppSnapshot["persona"];
    activeChat: AppSnapshot["activeChat"];
    activeBranch: AppSnapshot["activeBranch"];
    branches: AppSnapshot["branches"];
    summaries: AppSnapshot["summaries"];
    chats: AppSnapshot["chats"];
    allCharacters: AppSnapshot["allCharacters"];
  } | null;
  /** Messages keyed by ID — raw, no macro resolution */
  messagesById: Record<string, AppMessage>;
  /** ordered message IDs — corresponds to display order */
  messageOrder: string[];
  /** Whether the chat has older messages to load */
  hasMore: boolean;
  /** Macro resolution context derived from character+persona */
  macroContext: MacroContext | null;
  /** Prompt trace data */
  promptTrace: AppSnapshot["promptTrace"];
  promptTraceHistory: AppSnapshot["promptTraceHistory"];
  contextPreview: AppSnapshot["contextPreview"];
}

export interface ChatDataActions {
  /** Normalize a full snapshot into the store */
  setSnapshot: (snapshot: AppSnapshot) => void;
  /** Add older messages to the beginning of the list */
  prependMessages: (messages: AppMessage[], hasMore: boolean) => void;
  /** Update a single message in messagesById */
  updateMessage: (id: string, partial: Partial<AppMessage>) => void;
  /** Clear all data (chat switch, logout) */
  clear: () => void;
}

export type ChatDataStore = ChatDataState & ChatDataActions;

const initialState: ChatDataState = {
  chatMeta: null,
  messagesById: {},
  messageOrder: [],
  hasMore: false,
  macroContext: null,
  promptTrace: null,
  promptTraceHistory: [],
  contextPreview: null,
};

export const useChatDataStore = create<ChatDataStore>()(
  immer((set) => ({
    ...initialState,

    setSnapshot: (snapshot) =>
      set((state) => {
        // Chat meta
        const isSameBranch = state.chatMeta?.activeBranch.id === snapshot.activeBranch.id;

        state.chatMeta = {
          character: snapshot.character,
          persona: snapshot.persona,
          activeChat: snapshot.activeChat,
          activeBranch: snapshot.activeBranch,
          branches: snapshot.branches,
          summaries: snapshot.summaries,
          chats: snapshot.chats,
          allCharacters: snapshot.allCharacters,
        };

        // Messages: normalize into byId + order
        const byId: Record<string, AppMessage> = isSameBranch ? { ...state.messagesById } : {};
        const incomingIds: string[] = [];
        for (const msg of snapshot.messages) {
          byId[msg.id] = msg;
          incomingIds.push(msg.id);
        }

        if (isSameBranch && snapshot.messages.length > 0) {
          const oldestIncomingPos = snapshot.messages[0].position;
          // Keep existing messages that are OLDER than the incoming snapshot window
          const olderIds = state.messageOrder.filter(id => {
            const m = state.messagesById[id];
            // If message is in snapshot, it's already in incomingIds
            // If message is older than oldest in snapshot, keep it
            return m && m.position < oldestIncomingPos && !incomingIds.includes(id);
          });
          state.messageOrder = [...olderIds, ...incomingIds];
        } else {
          state.messageOrder = incomingIds;
        }

        state.messagesById = byId;
        state.hasMore = snapshot.hasMore;

        // Macro context (character name + persona name/description)
        state.macroContext = {
          characterName: snapshot.character.name,
          personaName: snapshot.persona?.name ?? null,
          personaDescription: snapshot.persona?.description ?? null,
        };

        // Trace data
        state.promptTrace = snapshot.promptTrace;
        state.promptTraceHistory = snapshot.promptTraceHistory;
        state.contextPreview = snapshot.contextPreview;
      }),

    prependMessages: (messages, hasMore) =>
      set((state) => {
        const newIds: string[] = [];
        for (const msg of messages) {
          state.messagesById[msg.id] = msg;
          newIds.push(msg.id);
        }
        state.messageOrder = [...newIds, ...state.messageOrder];
        state.hasMore = hasMore;
      }),

    updateMessage: (id, partial) =>
      set((state) => {
        const existing = state.messagesById[id];
        if (existing) {
          Object.assign(existing, partial);
        }
      }),

    clear: () => set((state) => {
      Object.assign(state, initialState);
    }),
  }))
);
