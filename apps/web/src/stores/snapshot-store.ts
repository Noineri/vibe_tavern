import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import type {
  AppSnapshot,
  AppMessage,
  AppCharacter,
  AppPersona,
  AppCharacterEntry,
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
  character: AppCharacter | null;
  /** Active persona for the current chat. */
  persona: AppPersona | null;
  /** Active chat metadata. */
  activeChat: NonNullable<AppSnapshot["activeChat"]> | null;
  /** Active branch. */
  activeBranch: ChatBranch | null;
  /** All branches for the current chat. */
  branches: ChatBranch[];
  /** Summaries for the current chat. */
  summaries: NonNullable<AppSnapshot["summaries"]>;

  /** Prompt trace from last generation. */
  promptTrace: PromptTraceRecordDto | null;
  /** Prompt trace history. */
  promptTraceHistory: PromptTraceRecordDto[];
  /** Context preview (shown when no traces exist). */
  contextPreview: AssemblePromptResponse | null;

  /** Swipe direction for variant animation (1 = forward, -1 = back). */
  swipeDirection: 1 | -1;

  /*
   * The store is the canonical MERGED state — once a field is ingested it is
   * a concrete value or null, never "absent". Absence exists only on the
   * wire (AppSnapshot, all-optional). Store element types therefore use the
   * named shapes (AppCharacter / AppPersona / AppCharacterEntry) or
   * NonNullable<AppSnapshot["…"]> for fields that augment domain types
   * (activeChat, summaries), NOT bare AppSnapshot["…"] (which would drag in
   * the wire-level `| undefined`).
   */
  /** Flat list of all available characters (for sidebar, etc). */
  allCharacters: AppCharacterEntry[];
}

interface SnapshotActions {
  /**
   * Ingest a (possibly partial) AppSnapshot into the store.
   *
   * Each field is written only when present in the snapshot — absence
   * preserves the existing store value (Phase 3.4.1 absence pipeline).
   * Chat switching clears messages explicitly via clearMessages() before
   * ingesting, so non-message mutations can safely omit `messages`.
   *
   * Immer's structural sharing preserves object references for unchanged
   * data — components only re-render when their specific values change.
   */
  ingestSnapshot(snapshot: AppSnapshot): void;

  /**
   * Clear all chat data (used before switching chats or on logout).
   */
  clear(): void;

  /**
   * Clear only message data. Called explicitly before ingesting a snapshot
   * for a different chat (switchChatAction, createChatAction) so that an
   * endpoint which omits `messages` does not leave the previous chat's
   * messages visible.
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

/**
 * Structural deep equality for JSON-compatible data — the dedup comparator
 * used by ingestSnapshot to decide whether a wire object differs from the
 * stored copy. Skipping the assignment preserves the store's object
 * reference, which is what keeps subscribers (MessageBlock, chat list) from
 * re-rendering on unchanged data — the Wave A render-isolation invariant
 * leans on this.
 *
 * Reproduces `JSON.stringify(a) === JSON.stringify(b)` decisions exactly for
 * JSON-compatible data, but WITHOUT allocating any string (Wave B2): a
 * double `JSON.stringify` of a 100-message chat per ingest was the hot
 * path, and the allocation dominated. This recurses structurally and exits
 * on the first differing field.
 *
 * Matches JSON.stringify semantics for the cases that occur on the wire:
 *  - `undefined` values are treated as absent (stringify omits them), so
 *    `{a:1,b:undefined}` and `{a:1}` compare equal.
 *  - object key order is irrelevant (compared by key set), as two parses of
 *    structurally-equal JSON may differ in insertion order.
 *  - arrays are order-sensitive (as stringify is).
 * ingestSnapshot data is always parsed-from-JSON, so non-JSON edge cases
 * (NaN, functions, symbols, Date objects) never reach here.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // After the === check: if either side is a primitive (or null/undefined),
  // they cannot be equal unless both were the same primitive (handled).
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    // Arrays are order-sensitive; a non-array vs array is a mismatch.
    if (!aIsArray || !bIsArray || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  // Plain objects: compare defined keys (undefined treated as absent).
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec).filter((k) => aRec[k] !== undefined);
  const bKeys = Object.keys(bRec).filter((k) => bRec[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual(aRec[k], bRec[k])) return false;
  }
  return true;
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
        // ── Absence pipeline (Phase 3.4.1) ──
        // Every field is written ONLY when present in the snapshot. Absence
        // means "this endpoint did not touch this data" and preserves the
        // existing store value. An explicit `null` or `[]` still replaces.
        // Chat switching clears messages explicitly via clearMessages()
        // (see switchChatAction / createChatAction), so a non-message
        // mutation can safely omit `messages` without wiping the chat.

        // ── Chats: dictionary + sorted order (present only) ──
        if (Array.isArray(snapshot.chats)) {
          const nextChatIds = new Set<string>(snapshot.chats.map((chat) => chat.id));
          for (const id of Object.keys(draft.chatsById)) {
            if (!nextChatIds.has(id)) delete draft.chatsById[id];
          }
          for (const chat of snapshot.chats) {
            if (!deepEqual(draft.chatsById[chat.id], chat)) {
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

        // ── Messages: dictionary (keyed by id) + order (present only) ──
        // Absence is preserved — chat switching clears via clearMessages().
        if (Array.isArray(snapshot.messages)) {
          const nextMessageIds = new Set<string>(snapshot.messages.map((msg) => msg.id));
          for (const id of Object.keys(draft.messagesById)) {
            if (!nextMessageIds.has(id)) delete draft.messagesById[id];
          }
          for (const msg of snapshot.messages) {
            if (!deepEqual(draft.messagesById[msg.id], msg)) {
              draft.messagesById[msg.id] = msg;
            }
          }
          const nextOrder = snapshot.messages.map((m) => m.id);
          if (!sameStringArray(draft.messageOrder, nextOrder)) {
            draft.messageOrder = nextOrder;
          }
        }

        // ── Nullable objects: set only when the key is present ──
        // An absent key preserves the existing store value; a present key
        // writes the value (persona may be an explicit null when unset).
        if ("character" in snapshot) {
          const next = snapshot.character ?? null;
          if (!deepEqual(draft.character, next)) draft.character = next;
        }
        if ("persona" in snapshot) {
          const next = snapshot.persona ?? null;
          if (!deepEqual(draft.persona, next)) draft.persona = next;
        }
        if ("activeChat" in snapshot) {
          const next = snapshot.activeChat ?? null;
          if (!deepEqual(draft.activeChat, next)) draft.activeChat = next;
        }
        if ("activeBranch" in snapshot) {
          const next = snapshot.activeBranch ?? null;
          if (!deepEqual(draft.activeBranch, next)) draft.activeBranch = next;
        }

        // ── Arrays: replace only when present; absence preserves ──
        if (Array.isArray(snapshot.branches)) {
          if (!deepEqual(draft.branches, snapshot.branches)) draft.branches = snapshot.branches;
        }
        if (Array.isArray(snapshot.summaries)) {
          if (!deepEqual(draft.summaries, snapshot.summaries)) draft.summaries = snapshot.summaries;
        }

        // ── Traces / preview ──
        if ("promptTrace" in snapshot) {
          const next = snapshot.promptTrace ?? null;
          if (!deepEqual(draft.promptTrace, next)) draft.promptTrace = next;
        }
        if (Array.isArray(snapshot.promptTraceHistory)) {
          if (!deepEqual(draft.promptTraceHistory, snapshot.promptTraceHistory)) {
            draft.promptTraceHistory = snapshot.promptTraceHistory;
          }
        }
        if ("contextPreview" in snapshot) {
          const next = snapshot.contextPreview ?? null;
          if (!deepEqual(draft.contextPreview, next)) draft.contextPreview = next;
        }

        // ── All characters (global list) ──
        if (Array.isArray(snapshot.allCharacters)) {
          if (!deepEqual(draft.allCharacters, snapshot.allCharacters)) {
            draft.allCharacters = snapshot.allCharacters;
          }
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
