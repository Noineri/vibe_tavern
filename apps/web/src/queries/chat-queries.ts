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
  deleteBranch,
  deleteChatMessage,
  editChatMessage,
  fetchChat,
  forkBranch,
  regenerateChatMessage,
  selectMessageVariant,
  sendChatMessage,
  type AppSnapshot,
} from "../app-client.js";
import { chatKeys } from "./query-keys.js";

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useChatSnapshot(chatId: ChatId | null) {
  return useQuery({
    queryKey: chatKeys.snapshot(chatId ?? ("" as ChatId)),
    queryFn: () => fetchChat(chatId!),
    enabled: Boolean(chatId),
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks — simple mutations
// ---------------------------------------------------------------------------

/** Send a message (non-streaming path). Returns new snapshot. */
export function useSendMessageMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { chatId: ChatId; content: string; signal?: AbortSignal }) =>
      sendChatMessage(args.chatId, { content: args.content }, { signal: args.signal }),
    onSuccess: (snapshot: AppSnapshot, variables) => {
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(variables.chatId) });
      // Also write directly to cache so downstream reads are instant
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(variables.chatId) });
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(variables.chatId) });
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(variables.chatId) });
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(chatId) });
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(variables.chatId) });
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(chatId) });
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(variables.chatId) });
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
      void qc.invalidateQueries({ queryKey: chatKeys.snapshot(variables.chatId) });
      qc.setQueryData(chatKeys.snapshot(variables.chatId), snapshot);
    },
  });
}
