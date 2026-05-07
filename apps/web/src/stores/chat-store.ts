import { create } from "zustand";
import type { ChatId } from "@rp-platform/domain";
import type { AppSnapshot } from "../app-client.js";

export interface ChatState {
  activeChatId: ChatId | null;
  selectedCharacterId: string | null;
  snapshot: AppSnapshot | null;
  draft: string;
  isSending: boolean;
  generationStatus: import("../app-client.js").ChatGenerationStatus;
  selectedTraceId: string | null;
  editingMessageId: string | null;
  editingDraft: string;
  messageActionId: string | null;
  pendingUserMessageContent: string | null;
  chatNotice: string;
}

export interface ChatActions {
  setActiveChatId: (id: ChatId | null) => void;
  setSelectedCharacterId: (id: string | null) => void;
  setSnapshot: (snapshot: AppSnapshot | null) => void;
  setSnapshotForChat: (chatId: ChatId, snapshot: AppSnapshot) => void;
  setDraft: (draft: string) => void;
  setIsSending: (sending: boolean) => void;
  setSelectedTraceId: (id: string | null) => void;
  setEditingMessageId: (id: string | null) => void;
  setEditingDraft: (draft: string) => void;
  setMessageActionId: (id: string | null) => void;
  setPendingUserMessageContent: (content: string | null) => void;
  setGenerationStatus: (status: import("../app-client.js").ChatGenerationStatus) => void;
  setChatNotice: (notice: string) => void;
}

export type ChatStore = ChatState & ChatActions;

export const useChatStore = create<ChatStore>()((set) => ({
  activeChatId: null,
  selectedCharacterId: null,
  snapshot: null,
  draft: "",
  isSending: false,
  generationStatus: "idle" as import("../app-client.js").ChatGenerationStatus,
  selectedTraceId: null,
  editingMessageId: null,
  editingDraft: "",
  messageActionId: null,
  pendingUserMessageContent: null,
  chatNotice: "",

  setActiveChatId: (id) => set({ activeChatId: id, selectedCharacterId: null }),
  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setSnapshotForChat: (chatId, snapshot) => set({ activeChatId: chatId, snapshot }),
  setDraft: (draft) => set({ draft }),
  setIsSending: (sending) => set({ isSending: sending }),
  setSelectedTraceId: (id) => set({ selectedTraceId: id }),
  setEditingMessageId: (id) => set({ editingMessageId: id }),
  setEditingDraft: (draft) => set({ editingDraft: draft }),
  setMessageActionId: (id) => set({ messageActionId: id }),
  setPendingUserMessageContent: (content) => set({ pendingUserMessageContent: content }),
  setGenerationStatus: (status) => set({ generationStatus: status }),
  setChatNotice: (notice) => set({ chatNotice: notice }),
}));
