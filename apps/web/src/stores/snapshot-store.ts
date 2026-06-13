import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import type {
  AppSnapshot,
  AppMessage,
  ChatListItem,
} from "../app-client.js";
import type { ChatBranch, PromptTraceRecordDto, AssemblePromptResponse } from "@vibe-tavern/domain";

// ── Macro context (derived from character + persona) ──────────────────

export interface MacroContext {
  characterName: string;
  personaName: string | null;
  personaDescription: string | null;
}

// ── Store shape ────────────────────────────────────────────────────────

interface SnapshotState {
  /** All known chats keyed by id. Immer preserves refs on identical data. */
  chatsById: Record<string, ChatListItem>;
  /** Ordered chat IDs (most recently updated first). */
  chatIds: string[];

  /** Messages keyed by ID. Immer preserves refs for unchanged messages. */
  messagesById: Record<string, AppMessage>;
  /** Ordered message IDs for the currently active chat. */
  messageOrder: string[];

  /** Active character for the current chat. */
  character: AppSnapshot["character"] | null;
  /** Active persona for the current chat. */
  persona: AppSnapshot["persona"] | null;
  /** Active chat metadata. */
  activeChat: AppSnapshot["activeChat"] | null;
  /** Active branch. */
  activeBranch: ChatBranch | null;
  /** All branches for the current chat. */
  branches: ChatBranch[];
  /** Summaries for the current chat. */
  summaries: AppSnapshot["summaries"];

  /** Prompt trace from last generation. */
  promptTrace: PromptTraceRecordDto | null;
  /** Prompt trace history. */
  promptTraceHistory: PromptTraceRecordDto[];
  /** Context preview (shown when no traces exist). */
  contextPreview: AssemblePromptResponse | null;

  /** Swipe direction for variant animation (1 = forward, -1 = back). */
  swipeDirection: 1 | -1;

  /** Flat list of all available characters (for sidebar, etc). */
  allCharacters: AppSnapshot["allCharacters"];
}

interface SnapshotActions {
  /**
   * Ingest a monolithic AppSnapshot into the store.
   * Immer's structural sharing preserves object references for unchanged
   * data — components only re-render when their specific values change.
   */
  ingestSnapshot(snapshot: AppSnapshot): void;

  /**
   * Clear all chat data (used before switching chats or on logout).
   */
  clear(): void;

  /**
   * Clear only message data (used before switching chats).
   */
  clearMessages(): void;

  /** Update a single message in messagesById. */
  updateMessage(id: string, partial: Partial<AppMessage>): void;

  /** Optimistically select a message variant and record swipe direction. */
  selectVariant(messageId: string, variantIndex: number, direction: 1 | -1): void;

  /** Set swipe direction for variant animation. */
  setSwipeDirection(dir: 1 | -1): void;
}

export type SnapshotStore = SnapshotState & SnapshotActions;

// ── Initial state ──────────────────────────────────────────────────────

const initialState: SnapshotState = {
  chatsById: {},
  chatIds: [],
  messagesById: {},
  messageOrder: [],
  character: null,
  persona: null,
  activeChat: null,
  activeBranch: null,
  branches: [],
  summaries: [],
  promptTrace: null,
  promptTraceHistory: [],
  contextPreview: null,
  swipeDirection: 1 as const,
  allCharacters: [],
};

// ── Helpers ────────────────────────────────────────────────────────────

function toIso(ts: string): string {
  // Normalize timestamps: handle ISO strings, Unix ms, or empty
  if (!ts) return "0";
  // If it's an ISO string, return as-is. If it's a number, convert.
  return isNaN(Number(ts)) ? ts : new Date(Number(ts)).toISOString();
}

function sameJson<T>(a: T, b: T): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

// ── Store ──────────────────────────────────────────────────────────────

export const useSnapshotStore = create<SnapshotStore>()(
  immer((set) => ({
    ...initialState,

    ingestSnapshot: (snapshot) =>
      set((draft) => {
        // ── Chats: dictionary + sorted order ──
        if (Array.isArray(snapshot.chats)) {
          const nextChatIds = new Set<string>(snapshot.chats.map((chat) => chat.id));
          for (const id of Object.keys(draft.chatsById)) {
            if (!nextChatIds.has(id)) delete draft.chatsById[id];
          }
          for (const chat of snapshot.chats) {
            if (!sameJson(draft.chatsById[chat.id], chat)) {
              draft.chatsById[chat.id] = chat;
            }
          }
          const sortedChatIds = snapshot.chats
            .map((c) => c.id)
            .sort((a, b) => {
              const chatA = draft.chatsById[a];
              const chatB = draft.chatsById[b];
              if (!chatA || !chatB) return 0;
              return toIso(chatB.updatedAt ?? "").localeCompare(toIso(chatA.updatedAt ?? ""));
            });
          if (!sameStringArray(draft.chatIds, sortedChatIds)) {
            draft.chatIds = sortedChatIds;
          }
        }

        // ── Messages: dictionary (keyed by id) + order ──
        // NOTE: an absent `messages` field WIPES existing messages. This is
        // load-bearing for chat switching (clearMessages() is never called
        // directly). When moving to endpoint-scoped responses (Phase 3.4),
        // chat-switching must call clearMessages() explicitly so that
        // non-message mutations can safely omit `messages`.
        if (Array.isArray(snapshot.messages)) {
          const nextMessageIds = new Set<string>(snapshot.messages.map((msg) => msg.id));
          for (const id of Object.keys(draft.messagesById)) {
            if (!nextMessageIds.has(id)) delete draft.messagesById[id];
          }
          for (const msg of snapshot.messages) {
            if (!sameJson(draft.messagesById[msg.id], msg)) {
              draft.messagesById[msg.id] = msg;
            }
          }
          const nextOrder = snapshot.messages.map((m) => m.id);
          if (!sameStringArray(draft.messageOrder, nextOrder)) {
            draft.messageOrder = nextOrder;
          }
        } else if (Object.keys(draft.messagesById).length > 0 || draft.messageOrder.length > 0) {
          draft.messagesById = {};
          draft.messageOrder = [];
        }

        // ── Character, persona, branch ──
        const nextCharacter = snapshot.character ?? null;
        const nextPersona = snapshot.persona ?? null;
        const nextActiveChat = snapshot.activeChat ?? null;
        const nextActiveBranch = snapshot.activeBranch ?? null;
        const nextBranches = Array.isArray(snapshot.branches) ? snapshot.branches : [];
        const nextSummaries = Array.isArray(snapshot.summaries) ? snapshot.summaries : [];

        if (!sameJson(draft.character, nextCharacter)) draft.character = nextCharacter;
        if (!sameJson(draft.persona, nextPersona)) draft.persona = nextPersona;
        if (!sameJson(draft.activeChat, nextActiveChat)) draft.activeChat = nextActiveChat;
        if (!sameJson(draft.activeBranch, nextActiveBranch)) draft.activeBranch = nextActiveBranch;
        if (!sameJson(draft.branches, nextBranches)) draft.branches = nextBranches;
        if (!sameJson(draft.summaries, nextSummaries)) draft.summaries = nextSummaries;

        // ── Traces ──
        const nextPromptTrace = snapshot.promptTrace ?? null;
        const nextPromptTraceHistory = Array.isArray(snapshot.promptTraceHistory)
          ? snapshot.promptTraceHistory
          : [];
        const nextContextPreview = snapshot.contextPreview ?? null;

        if (!sameJson(draft.promptTrace, nextPromptTrace)) draft.promptTrace = nextPromptTrace;
        if (!sameJson(draft.promptTraceHistory, nextPromptTraceHistory)) {
          draft.promptTraceHistory = nextPromptTraceHistory;
        }
        if (!sameJson(draft.contextPreview, nextContextPreview)) draft.contextPreview = nextContextPreview;

        // ── All characters (global list) ──
        const nextAllCharacters = Array.isArray(snapshot.allCharacters)
          ? snapshot.allCharacters
          : [];
        if (!sameJson(draft.allCharacters, nextAllCharacters)) {
          draft.allCharacters = nextAllCharacters;
        }
      }),

    clear: () =>
      set((draft) => {
        Object.assign(draft, initialState);
      }),

    clearMessages: () =>
      set((draft) => {
        draft.messagesById = {};
        draft.messageOrder = [];
      }),

    updateMessage: (id, partial) =>
      set((draft) => {
        const existing = draft.messagesById[id];
        if (existing) Object.assign(existing, partial);
      }),

    selectVariant: (messageId, variantIndex, direction) =>
      set((draft) => {
        const existing = draft.messagesById[messageId];
        if (existing) {
          const variant =
            existing.variants.find((item) => item.variantIndex === variantIndex) ??
            existing.variants[variantIndex];
          const resolvedVariantIndex = variant?.variantIndex ?? variantIndex;
          existing.selectedVariantIndex = resolvedVariantIndex;
          for (const item of existing.variants) {
            item.isSelected = item.variantIndex === resolvedVariantIndex;
          }
          if (variant) {
            existing.content = variant.content;
            existing.modelId = variant.modelId ?? null;
          }
        }
        draft.swipeDirection = direction;
      }),

    setSwipeDirection: (dir) =>
      set((draft) => {
        draft.swipeDirection = dir;
      }),
  }))
);

// ── Selectors ──────────────────────────────────────────────────────────

/** Subscribe to the ordered chat list (most recently updated first). */
export function useChatList() {
  return useSnapshotStore(
    useShallow((s) => {
      return s.chatIds.map((id) => s.chatsById[id]).filter(Boolean);
    }),
  );
}

/** Subscribe to a single chat's metadata. */
export function useChatMeta(chatId: string) {
  return useSnapshotStore((s) => s.chatsById[chatId] ?? null);
}

/** Subscribe to the ordered list of messages for the active chat. */
export function useOrderedMessages() {
  return useSnapshotStore(
    useShallow((s) => {
      return s.messageOrder
        .map((id) => s.messagesById[id])
        .filter((msg): msg is AppMessage => Boolean(msg));
    }),
  );
}

/** Subscribe to a single message by ID. Returns null if not found. */
export function useMessage(id: string) {
  return useSnapshotStore((s) => s.messagesById[id] ?? null);
}

/** Subscribe to macro context (character name, persona name/description). */
export function useMacroContext(): MacroContext | null {
  return useSnapshotStore(
    useShallow((s) => {
      if (!s.character) return null;
      return {
        characterName: s.character.name,
        personaName: s.persona?.name ?? null,
        personaDescription: s.persona?.description ?? null,
      };
    }),
  );
}

/** Subscribe to the active character. */
export function useActiveCharacter() {
  return useSnapshotStore((s) => s.character);
}

/** Subscribe to the active persona. */
export function useActivePersona() {
  return useSnapshotStore((s) => s.persona);
}

/** Subscribe to the active branch. */
export function useActiveBranch() {
  return useSnapshotStore((s) => s.activeBranch);
}

/** Subscribe to branches for the active chat. */
export function useBranches() {
  return useSnapshotStore((s) => s.branches);
}

/** Subscribe to all characters list. */
export function useAllCharacters() {
  return useSnapshotStore((s) => s.allCharacters);
}

/** Subscribe to prompt trace data. */
export function usePromptTrace() {
  return useSnapshotStore(
    useShallow((s) => ({
      promptTrace: s.promptTrace,
      promptTraceHistory: s.promptTraceHistory,
      contextPreview: s.contextPreview,
    })),
  );
}

// Debug helper
if (typeof window !== "undefined") {
  window.__useSnapshotStore = useSnapshotStore;
}
