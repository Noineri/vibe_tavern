import type { ChatBranchId, ChatId } from "@rp-platform/domain";
import {
  activateBranch,
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
} from "../../app-client.js";
import { useChatDataStore } from "../chat-data-store.js";
import { fetchBootstrapAction } from "./bootstrap-actions.js";

// Helper to sync snapshot to zustand
function syncSnapshot(snapshot: AppSnapshot) {
  useChatDataStore.getState().setSnapshot(snapshot);
}

// ---------------------------------------------------------------------------
// Chat Actions
// ---------------------------------------------------------------------------

export async function fetchChatAction(chatId: ChatId): Promise<void> {
  const snapshot = await fetchChat(chatId);
  syncSnapshot(snapshot);
}

export async function setChatPersonaAction(chatId: ChatId, personaId: string): Promise<void> {
  const snapshot = await setChatPersona(chatId, personaId);
  syncSnapshot(snapshot);
  void fetchBootstrapAction();
}

export async function createChatAction(characterId?: string): Promise<void> {
  const snapshot = await createChat(characterId);
  syncSnapshot(snapshot);
  void fetchBootstrapAction();
}

export async function deleteChatAction(chatId: ChatId): Promise<void> {
  await deleteChat(chatId);
  void fetchBootstrapAction();
}

export async function renameChatAction(chatId: ChatId, title: string): Promise<void> {
  await renameChat(chatId, title);
  void fetchBootstrapAction();
}

export async function sendChatMessageAction(chatId: ChatId, content: string, signal?: AbortSignal): Promise<void> {
  const snapshot = await sendChatMessage(chatId, { content }, { signal });
  syncSnapshot(snapshot);
}

export async function regenerateMessageAction(chatId: ChatId, messageId: string, signal?: AbortSignal): Promise<void> {
  const snapshot = await regenerateChatMessage(chatId, messageId, { signal });
  syncSnapshot(snapshot);
}

export async function editMessageAction(chatId: ChatId, messageId: string, content: string): Promise<void> {
  const snapshot = await editChatMessage(chatId, messageId, content);
  syncSnapshot(snapshot);
}

export async function deleteMessageAction(chatId: ChatId, messageId: string): Promise<void> {
  const snapshot = await deleteChatMessage(chatId, messageId);
  syncSnapshot(snapshot);
}

export async function switchChatAction(chatId: ChatId): Promise<void> {
  useChatDataStore.getState().clear();
  const snapshot = await fetchChat(chatId);
  syncSnapshot(snapshot);
}

export async function selectVariantAction(chatId: ChatId, messageId: string, variantIndex: number): Promise<void> {
  // No syncSnapshot — handleSelectMessageVariant already did the optimistic update.
  // syncSnapshot would replace the entire messagesById with fresh JSON objects,
  // breaking reselect memoization and causing all MessageBlocks to re-render.
  await selectMessageVariant(chatId, messageId, variantIndex);
}

export async function forkBranchAction(chatId: ChatId, fromMessageId?: string): Promise<void> {
  const snapshot = await forkBranch(chatId, fromMessageId);
  syncSnapshot(snapshot);
}

export async function activateBranchAction(chatId: ChatId, branchId: ChatBranchId): Promise<void> {
  const snapshot = await activateBranch(chatId, branchId);
  syncSnapshot(snapshot);
}

export async function deleteBranchAction(chatId: ChatId, branchId: ChatBranchId): Promise<void> {
  const snapshot = await deleteBranch(chatId, branchId);
  syncSnapshot(snapshot);
}

export async function generateReplyAction(chatId: ChatId, signal?: AbortSignal): Promise<void> {
  const snapshot = await generateReply(chatId, { signal });
  syncSnapshot(snapshot);
}

export async function summarizeChatAction(chatId: ChatId, input: Parameters<typeof summarizeChat>[1]): Promise<{ summary: string }> {
  const result = await summarizeChat(chatId, input);
  syncSnapshot(result.snapshot);
  return { summary: result.summary };
}

export async function saveChatSummaryAction(chatId: ChatId, summary: string): Promise<{ summary: string }> {
  const result = await saveChatSummary(chatId, summary);
  syncSnapshot(result.snapshot);
  return { summary: result.summary };
}
