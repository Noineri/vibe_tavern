import { create } from "zustand";
import type { ChatId } from "@rp-platform/domain";
import type { AppSnapshot } from "../app-client.js";

export interface ChatState {
  activeChatId: ChatId | null;
  snapshot: AppSnapshot | null;
  draft: string;
  isSending: boolean;
  selectedTraceId: string | null;
  editingMessageId: string | null;
  editingDraft: string;
  messageActionId: string | null;
  pendingUserMessageContent: string | null;
  chatNotice: string;
}

export interface ChatActions {
  setActiveChatId: (id: ChatId | null) => void;
  setSnapshot: (snapshot: AppSnapshot | null) => void;
  setSnapshotForChat: (chatId: ChatId, snapshot: AppSnapshot) => void;
  setDraft: (draft: string) => void;
  setIsSending: (sending: boolean) => void;
  setSelectedTraceId: (id: string | null) => void;
  setEditingMessageId: (id: string | null) => void;
  setEditingDraft: (draft: string) => void;
  setMessageActionId: (id: string | null) => void;
  setPendingUserMessageContent: (content: string | null) => void;
  setChatNotice: (notice: string) => void;
}

export type ChatStore = ChatState & ChatActions;

export const useChatStore = create<ChatStore>()((set) => ({
  activeChatId: null,
  snapshot: null,
  draft: "",
  isSending: false,
  selectedTraceId: null,
  editingMessageId: null,
  editingDraft: "",
  messageActionId: null,
  pendingUserMessageContent: null,
  chatNotice: "",

  setActiveChatId: (id) => set({ activeChatId: id }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setSnapshotForChat: (chatId, snapshot) => set({ activeChatId: chatId, snapshot }),
  setDraft: (draft) => set({ draft }),
  setIsSending: (sending) => set({ isSending: sending }),
  setSelectedTraceId: (id) => set({ selectedTraceId: id }),
  setEditingMessageId: (id) => set({ editingMessageId: id }),
  setEditingDraft: (draft) => set({ editingDraft: draft }),
  setMessageActionId: (id) => set({ messageActionId: id }),
  setPendingUserMessageContent: (content) => set({ pendingUserMessageContent: content }),
  setChatNotice: (notice) => set({ chatNotice: notice }),
}));
