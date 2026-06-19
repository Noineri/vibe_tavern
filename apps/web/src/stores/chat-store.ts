import { create } from "zustand";
import type { ChatId, Attachment } from "@vibe-tavern/domain";
import type { ChatGenerationStatus } from "../app-client.js";

// ── Per-chat generation state ──────────────────────────────────────────

export interface ChatGenerationState {
  isSending: boolean;
  /**
   * Explicit identity of the message currently being streamed into (the
   * streaming-target seam). Set only when a generation streams into an
   * EXISTING message (regenerate); null for fresh sends (which stream into
   * the __pending-assistant singleton) and whenever no generation is active.
   *
   * Single source of truth for "which message is streaming right now". Read
   * via useIsStreamingTarget / useStreamingRevealedFor (chat-selectors),
   * NOT by overloading messageActionId (which tracks action spinners:
   * edit/delete/regenerate pending). The two concerns are deliberately
   * separate so a future sequential queue can hold long-lived streaming
   * state without it rendering as a transient action spinner.
   */
  streamingMessageId: string | null;
  streamingText: string;
  streamingRevealedText: string;
  streamingReasoningText: string;
  generationStatus: ChatGenerationStatus;
  pendingUserMessageContent: string | null;
  pendingUserMessageAttachments: Attachment[];
  abortController: AbortController | null;
}

function defaultGenState(): ChatGenerationState {
  return {
    isSending: false,
    streamingMessageId: null,
    streamingText: "",
    streamingRevealedText: "",
    streamingReasoningText: "",
    generationStatus: "idle" as ChatGenerationStatus,
    pendingUserMessageContent: null,
    pendingUserMessageAttachments: [],
    abortController: null,
  };
}

// ── UI State (ephemeral, non-persisted) ────────────────────────────────

export interface ChatState {
  activeChatId: ChatId | null;
  selectedCharacterId: string | null;
  draft: string;
  editingMessageId: string | null;
  editingDraft: string;
  messageActionId: string | null;
  selectedTraceId: string | null;

  /** Per-chat generation state — allows parallel generations across chats. */
  generations: Record<string, ChatGenerationState>;

  draftAttachments: Attachment[];
}

export interface ChatActions {
  setActiveChatId: (id: ChatId | null) => void;
  setSelectedCharacterId: (id: string | null) => void;
  setDraft: (draft: string) => void;
  setSelectedTraceId: (id: string | null) => void;
  setEditingMessageId: (id: string | null) => void;
  setEditingDraft: (draft: string) => void;
  setMessageActionId: (id: string | null) => void;

  addDraftAttachment: (att: Attachment) => void;
  removeDraftAttachment: (id: string) => void;
  clearDraftAttachments: () => void;

  // ── Per-chat generation actions ──

  /** Initialize (or get) generation state for a chat. */
  getOrCreateGen: (chatId: string) => ChatGenerationState;

  /**
   * Start generation: creates AbortController, sets isSending. Returns the controller.
   * `streamingMessageId` (optional) identifies an EXISTING message the stream
   * targets (regenerate path); omit/null for fresh sends that stream into the
   * __pending-assistant singleton. See ChatGenerationState.streamingMessageId.
   */
  startGeneration: (chatId: string, pendingUserContent?: string | null, pendingAttachments?: Attachment[], streamingMessageId?: string | null) => AbortController;

  /** Set the revealed streaming text (throttled by StreamingReveal). Also updates streamingText. */
  setStreamingRevealed: (chatId: string, revealedText: string) => void;

  /** Append a reasoning delta. */
  appendReasoningText: (chatId: string, delta: string) => void;

  /** Set the generation status string. */
  setGenerationStatus: (chatId: string, status: ChatGenerationStatus) => void;

  /** Set or clear the pending user message content. */
  setPendingContent: (chatId: string, content: string | null) => void;

  /** Finish generation: clears streaming text, isSending, controller. */
  finishGeneration: (chatId: string) => void;

  /** Abort and clean up generation for a chat. */
  abortGeneration: (chatId: string) => void;

  /** Remove generation state entirely (called on chat delete). */
  removeGeneration: (chatId: string) => void;
}

export type ChatStore = ChatState & ChatActions;

// ── Store ──────────────────────────────────────────────────────────────

export const useChatStore = create<ChatStore>()((set, get) => ({
  activeChatId: null,
  selectedCharacterId: null,
  draft: "",
  editingMessageId: null,
  editingDraft: "",
  messageActionId: null,
  selectedTraceId: null,
  generations: {},
  draftAttachments: [],

  setActiveChatId: (id) => set({ activeChatId: id }),
  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),
  setDraft: (draft) => set({ draft }),
  setSelectedTraceId: (id) => set({ selectedTraceId: id }),
  setEditingMessageId: (id) => set({ editingMessageId: id }),
  setEditingDraft: (draft) => set({ editingDraft: draft }),
  setMessageActionId: (id) => set({ messageActionId: id }),

  addDraftAttachment: (att) => set((s) => ({ draftAttachments: [...s.draftAttachments, att] })),
  removeDraftAttachment: (id) => set((s) => ({ draftAttachments: s.draftAttachments.filter((a) => a.id !== id) })),
  clearDraftAttachments: () => set({ draftAttachments: [] }),

  // ── Per-chat generation ──

  getOrCreateGen: (chatId) => {
    const state = get();
    const existing = state.generations[chatId];
    if (existing) return existing;
    const newGen = defaultGenState();
    set((s) => ({
      generations: { ...s.generations, [chatId]: newGen },
    }));
    return newGen;
  },

  startGeneration: (chatId, pendingContent, pendingAttachments, streamingMessageId = null) => {
    const controller = new AbortController();
    set((s) => ({
      generations: {
        ...s.generations,
        [chatId]: {
          ...defaultGenState(),
          isSending: true,
          streamingMessageId,
          pendingUserMessageContent: pendingContent ?? null,
          pendingUserMessageAttachments: pendingAttachments ?? [],
          abortController: controller,
        },
      },
    }));
    return controller;
  },

  setStreamingRevealed: (chatId, revealedText) => {
    set((s) => {
      const gen = s.generations[chatId];
      if (!gen) return s;
      return {
        generations: {
          ...s.generations,
          [chatId]: { ...gen, streamingRevealedText: revealedText, streamingText: revealedText },
        },
      };
    });
  },

  appendReasoningText: (chatId, delta) => {
    set((s) => {
      const gen = s.generations[chatId];
      return {
        generations: {
          ...s.generations,
          [chatId]: gen
            ? { ...gen, streamingReasoningText: gen.streamingReasoningText + delta }
            : { ...defaultGenState(), streamingReasoningText: delta },
        },
      };
    });
  },

  setGenerationStatus: (chatId, status) => {
    set((s) => {
      const gen = s.generations[chatId];
      if (!gen) return {};
      return {
        generations: { ...s.generations, [chatId]: { ...gen, generationStatus: status } },
      };
    });
  },

  setPendingContent: (chatId, content) => {
    set((s) => {
      const gen = s.generations[chatId];
      if (!gen) return {};
      return {
        generations: { ...s.generations, [chatId]: { ...gen, pendingUserMessageContent: content } },
      };
    });
  },

  finishGeneration: (chatId) => {
    set((s) => {
      const gen = s.generations[chatId];
      if (!gen) return {};
      return {
        generations: {
          ...s.generations,
          [chatId]: {
            ...gen,
            isSending: false,
            streamingMessageId: null,
            streamingText: "",
            streamingRevealedText: "",
            streamingReasoningText: "",
            pendingUserMessageContent: null,
            pendingUserMessageAttachments: [],
            abortController: null,
          },
        },
      };
    });
  },

  abortGeneration: (chatId) => {
    const gen = get().generations[chatId];
    if (gen?.abortController) {
      gen.abortController.abort();
    }
    set((s) => {
      const g = s.generations[chatId];
      if (!g) return {};
      return {
        generations: {
          ...s.generations,
          [chatId]: {
            ...g,
            isSending: false,
            streamingMessageId: null,
            streamingText: "",
            streamingRevealedText: "",
            streamingReasoningText: "",
            pendingUserMessageContent: null,
            abortController: null,
          },
        },
      };
    });
  },

  removeGeneration: (chatId) => {
    set((s) => {
      const { [chatId]: _removed, ...rest } = s.generations;
      return { generations: rest };
    });
  },
}));

// ── Convenience selectors ──────────────────────────────────────────────

/**
 * Returns the generation state for the currently active chat.
 * Returns null if no chat is active or no generation in progress.
 */
export function useActiveGeneration(): ChatGenerationState | null {
  return useChatStore((s) => {
    if (!s.activeChatId) return null;
    return s.generations[s.activeChatId] ?? null;
  });
}

/** Returns whether the active chat is currently sending/generating. */
export function useIsSending(): boolean {
  return useChatStore((s) => {
    if (!s.activeChatId) return false;
    return s.generations[s.activeChatId]?.isSending ?? false;
  });
}

// ── Legacy aliases for gradual migration ──────────────────────────────
// Components can keep using `abortGeneration()` without arguments for the
// active chat. Remove after full migration.

/** Abort generation on the currently active chat. */
export function abortActiveGeneration(): void {
  const chatId = useChatStore.getState().activeChatId;
  if (chatId) {
    useChatStore.getState().abortGeneration(chatId);
  }
}

if (typeof window !== "undefined") {
  window.__useChatStore = useChatStore;
}
