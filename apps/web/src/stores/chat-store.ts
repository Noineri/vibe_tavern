import { create } from "zustand";
import type { ChatId } from "@rp-platform/domain";

export interface ChatState {
  activeChatId: ChatId | null;
  selectedCharacterId: string | null;
  draft: string;
  isSending: boolean;
  generationStatus: import("../app-client.js").ChatGenerationStatus;
  selectedTraceId: string | null;
  editingMessageId: string | null;
  editingDraft: string;
  messageActionId: string | null;
  pendingUserMessageContent: string | null;
  streamingText: string;
  streamingReasoningText: string;
}

export interface ChatActions {
  setActiveChatId: (id: ChatId | null) => void;
  setSelectedCharacterId: (id: string | null) => void;
  setDraft: (draft: string) => void;
  setIsSending: (sending: boolean) => void;
  setSelectedTraceId: (id: string | null) => void;
  setEditingMessageId: (id: string | null) => void;
  setEditingDraft: (draft: string) => void;
  setMessageActionId: (id: string | null) => void;
  setPendingUserMessageContent: (content: string | null) => void;
  setGenerationStatus: (status: import("../app-client.js").ChatGenerationStatus) => void;
  setStreamingText: (text: string) => void;
  setStreamingReasoningText: (text: string) => void;
}

export type ChatStore = ChatState & ChatActions;

export const useChatStore = create<ChatStore>()((set) => ({
  activeChatId: null,
  selectedCharacterId: null,
  draft: "",
  isSending: false,
  generationStatus: "idle" as import("../app-client.js").ChatGenerationStatus,
  selectedTraceId: null,
  editingMessageId: null,
  editingDraft: "",
  messageActionId: null,
  pendingUserMessageContent: null,
  streamingText: "",
  streamingReasoningText: "",

  setActiveChatId: (id) => set({ activeChatId: id, selectedCharacterId: null }),
  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),
  setDraft: (draft) => set({ draft }),
  setIsSending: (sending) => set({ isSending: sending }),
  setSelectedTraceId: (id) => set({ selectedTraceId: id }),
  setEditingMessageId: (id) => set({ editingMessageId: id }),
  setEditingDraft: (draft) => set({ editingDraft: draft }),
  setMessageActionId: (id) => set({ messageActionId: id }),
  setPendingUserMessageContent: (content) => set({ pendingUserMessageContent: content }),
  setGenerationStatus: (status) => set({ generationStatus: status }),
  setStreamingText: (text) => set({ streamingText: text }),
  setStreamingReasoningText: (text) => set({ streamingReasoningText: text }),
}));
