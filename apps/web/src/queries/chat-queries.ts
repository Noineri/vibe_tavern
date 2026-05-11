/**
 * TanStack Query hooks for chat operations.
 * Queries wrap fetchChat; mutations wrap all chat mutations with cache invalidation.
 * Streaming paths are NOT managed by TQ — they remain manual in use-chat-controller.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ChatBranchId, ChatId } from "@rp-platform/domain";
import {
  activateBranch,
  cloneChat,
  createChat,
  deleteBranch,
  deleteChat,
  deleteChatMessage,
  editChatMessage,
  fetchChat,
  forkBranch,
  generateReply,
  saveChatSummary,
  summarizeChat,
  regenerateChatMessage,
  renameChat,
  selectMessageVariant,
  sendChatMessage,
  setChatPersona,
  type AppSnapshot,
} from "../app-client.js";
import { bootstrapKeys, chatKeys } from "./query-keys.js";

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useChatSnapshot(chatId: ChatId | null) {
  return useQuery({
    queryKey: chatId ? chatKeys.snapshot(chatId) : chatKeys.none(),
    queryFn: () => fetchChat(chatId!),
    enabled: Boolean(chatId),
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks — simple mutations
// ---------------------------------------------------------------------------

/** Set the active persona for a chat. Returns new snapshot. */
export function useSetChatPersonaMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; personaId: string }) =>
      setChatPersona(args.chatId, args.personaId),
    onSuccess: (snapshot: AppSnapshot) => {
      qc.setQueryData(chatKeys.snapshot(snapshot.activeChat.id), snapshot);
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

/** Create a chat, optionally for a character. Returns new snapshot. */
export function useCreateChatMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { characterId?: string }) => createChat(args.characterId),
    onSuccess: (snapshot: AppSnapshot) => {
      qc.setQueryData(chatKeys.snapshot(snapshot.activeChat.id), snapshot);
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

/** Clone a chat. Returns new snapshot. */
export function useCloneChatMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: ChatId) => cloneChat(chatId),
    onSuccess: (snapshot: AppSnapshot) => {
      qc.setQueryData(chatKeys.snapshot(snapshot.activeChat.id), snapshot);
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

/** Delete a chat. */
export function useDeleteChatMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: ChatId) => deleteChat(chatId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

/** Rename a chat. */
export function useRenameChatMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; title: string }) =>
      renameChat(args.chatId, args.title),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
    },
  });
}

/** Send a message (non-streaming path). Returns new snapshot. */
export function useSendMessageMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; content: string; signal?: AbortSignal }) =>
      sendChatMessage(args.chatId, { content: args.content }, { signal: args.signal }),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}

/** Regenerate a message (non-streaming path). Returns new snapshot. */
export function useRegenerateMessageMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; messageId: string; signal?: AbortSignal }) =>
      regenerateChatMessage(args.chatId, args.messageId, { signal: args.signal }),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}

/** Edit a message. Returns new snapshot. */
export function useEditMessageMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; messageId: string; content: string }) =>
      editChatMessage(args.chatId, args.messageId, args.content),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}

/** Delete a message. Returns new snapshot. */
export function useDeleteMessageMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; messageId: string }) =>
      deleteChatMessage(args.chatId, args.messageId),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}

/** Switch to a different chat. Fetches the snapshot for the new chat. */
export function useSwitchChatMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: ChatId) => fetchChat(chatId),
    onSuccess: (snapshot: AppSnapshot, chatId) => {
      qc.setQueryData(chatKeys.snapshot(chatId), snapshot);
    },
  });
}

/** Select a message variant. Returns new snapshot. */
export function useSelectVariantMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; messageId: string; variantIndex: number }) =>
      selectMessageVariant(args.chatId, args.messageId, args.variantIndex),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}

/** Fork the current branch. Returns new snapshot. */
export function useForkMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: ChatId) => forkBranch(chatId),
    onSuccess: (snapshot: AppSnapshot, chatId) => {
      qc.setQueryData(chatKeys.snapshot(chatId), snapshot);
    },
  });
}

/** Activate a branch. Returns new snapshot. */
export function useActivateBranchMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; branchId: ChatBranchId }) =>
      activateBranch(args.chatId, args.branchId),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}

/** Delete a branch. Returns new snapshot. */
export function useDeleteBranchMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; branchId: ChatBranchId }) =>
      deleteBranch(args.chatId, args.branchId),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}


/** Generate a reply without sending a new user message (non-streaming resend path). */
export function useGenerateReplyMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; signal?: AbortSignal }) =>
      generateReply(args.chatId, { signal: args.signal }),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}

/** Summarize a chat. Returns summary text and the updated snapshot. */
export function useSummarizeChatMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; input: Parameters<typeof summarizeChat>[1] }) =>
      summarizeChat(args.chatId, args.input),
    onSuccess: (result, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), result.snapshot);
    },
  });
}

/** Save a chat summary. Returns summary text and the updated snapshot. */
export function useSaveChatSummaryMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; summary: string }) =>
      saveChatSummary(args.chatId, args.summary),
    onSuccess: (result, variables) => {
      qc.setQueryData(chatKeys.snapshot(variables.chatId), result.snapshot);
    },
  });
}
