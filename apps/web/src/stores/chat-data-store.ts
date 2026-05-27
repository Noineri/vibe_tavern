import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { AppMessage, AppSnapshot } from "../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";

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
  /** Swipe direction for variant animation (1 = forward, -1 = back) */
  swipeDirection: 1 | -1;
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
  /** Update a single message in messagesById */
  updateMessage: (id: string, partial: Partial<AppMessage>) => void;
  /** Atomically update selectedVariantIndex + swipeDirection in a single store write */
  selectVariant: (messageId: string, variantIndex: number, direction: 1 | -1) => void;
  /** Set swipe direction for variant animation */
  setSwipeDirection: (dir: 1 | -1) => void;
  /** Clear all data (chat switch, logout) */
  clear: () => void;
}

export type ChatDataStore = ChatDataState & ChatDataActions;

const initialState: ChatDataState = {
  chatMeta: null,
  messagesById: {},
  messageOrder: [],
  swipeDirection: 1 as const,
  macroContext: null,
  promptTrace: null,
  promptTraceHistory: [],
  contextPreview: null,
};

export const useChatDataStore = create<ChatDataStore>()(
  immer((set) => ({
    ...initialState,

    setSnapshot: (snapshot) => {
      console.log(`[STORE] setSnapshot called with ${snapshot.messages.length} messages`, new Error().stack);
      snapshot.messages.forEach(m => console.log(`[STORE] msg ${m.id} has ${m.variants?.length} variants`));
      set((state) => {
        // Chat meta
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
        const byId: Record<string, AppMessage> = {};
        const order: string[] = [];
        for (const msg of snapshot.messages) {
          byId[msg.id] = msg;
          order.push(msg.id);
        }
        state.messagesById = byId;
        state.messageOrder = order;

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
      });
    },

    updateMessage: (id, partial) =>
      set((state) => {
        const existing = state.messagesById[id];
        if (existing) {
          Object.assign(existing, partial);
        }
      }),

    selectVariant: (messageId, variantIndex, direction) =>
      set((state) => {
        const existing = state.messagesById[messageId];
        if (existing) {
          existing.selectedVariantIndex = variantIndex;
          const variant = existing.variants[variantIndex];
          if (variant) {
            existing.content = variant.content;
            existing.modelId = variant.modelId ?? null;
          }
        }
        state.swipeDirection = direction;
      }),

    setSwipeDirection: (dir) =>
      set((state) => {
        state.swipeDirection = dir;
      }),

    clear: () => set((state) => {
      Object.assign(state, initialState);
    }),
  }))
);

if (typeof window !== "undefined") (window as any).__useChatDataStore = useChatDataStore;
