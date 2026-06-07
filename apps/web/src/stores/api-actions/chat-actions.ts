import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import {
  activateBranch,
  createChat,
  deleteBranch,
  renameBranch,
  deleteChat,
  deleteChatMessage,
  deleteMessageVariant,
  editChatMessage,
  fetchChat,
  forkBranch,
  generateReply,
  generateChatSummary,
  listChatSummaries,
  createChatSummary,
  updateChatSummary,
  deleteChatSummary,
  updateMemorySettings,
  saveChatSummary,
  summarizeChat,
  regenerateChatMessage,
  renameChat,
  setGreetingIndex,
  selectMessageVariant,
  sendChatMessage,
  setChatPersona,
  type AppSnapshot,
} from "../../app-client.js";
import type { AutoSummaryConfig, ChatSummaryRecord } from "../../app-client.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { useChatStore } from "../chat-store.js";
import { fetchBootstrapAction } from "./bootstrap-actions.js";

// Single canonical backend snapshot cache.
function syncSnapshot(snapshot: AppSnapshot) {
  useSnapshotStore.getState().ingestSnapshot(snapshot);
}

const pendingVariantSelectionsByChat = new Map<string, Set<Promise<void>>>();

export async function waitForPendingVariantSelections(chatId: ChatId): Promise<void> {
  const pending = pendingVariantSelectionsByChat.get(chatId);
  if (!pending || pending.size === 0) return;
  await Promise.allSettled([...pending]);
}

// ---------------------------------------------------------------------------
// Chat Actions
// ---------------------------------------------------------------------------

export async function fetchChatAction(chatId: ChatId): Promise<void> {
  await waitForPendingVariantSelections(chatId);
  const snapshot = await fetchChat(chatId);
  syncSnapshot(snapshot);
}

export async function setChatPersonaAction(chatId: ChatId, personaId: string): Promise<void> {
  const snapshot = await setChatPersona(chatId, personaId);
  syncSnapshot(snapshot);
  void fetchBootstrapAction({ silent: true });
}

export async function createChatAction(characterId?: string): Promise<void> {
  const snapshot = await createChat(characterId);
  syncSnapshot(snapshot);
  // Auto-select the new chat
  const newChatId = snapshot.chats?.[0]?.id;
  if (newChatId) {
    useChatStore.getState().setActiveChatId(newChatId);
  }
  void fetchBootstrapAction({ silent: true });
}

export async function deleteChatAction(chatId: ChatId): Promise<void> {
  await deleteChat(chatId);
  // Clear deleted chat from active
  const current = useChatStore.getState().activeChatId;
  if (current === chatId) {
    useChatStore.getState().setActiveChatId(null);
  }
  void fetchBootstrapAction({ silent: true });
}

export async function renameChatAction(chatId: ChatId, title: string): Promise<void> {
  await renameChat(chatId, title);
  void fetchBootstrapAction({ silent: true });
}

export async function setGreetingIndexAction(chatId: ChatId, greetingIndex: number): Promise<void> {
  const snapshot = await setGreetingIndex(chatId, greetingIndex);
  syncSnapshot(snapshot);
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

export async function deleteVariantAction(chatId: ChatId, messageId: string, variantIndex: number): Promise<void> {
  const snapshot = await deleteMessageVariant(chatId, messageId, variantIndex);
  syncSnapshot(snapshot);
}

export async function switchChatAction(chatId: ChatId): Promise<void> {
  await waitForPendingVariantSelections(chatId);
  const snapshot = await fetchChat(chatId);
  syncSnapshot(snapshot);
}

export async function selectVariantAction(chatId: ChatId, messageId: string, variantIndex: number): Promise<void> {
  // No syncSnapshot — handleSelectMessageVariant already did the optimistic update.
  // syncSnapshot would replace the entire messagesById with fresh JSON objects,
  // breaking reselect memoization and causing all MessageBlocks to re-render.
  const promise = selectMessageVariant(chatId, messageId, variantIndex).then(() => undefined);
  let pending = pendingVariantSelectionsByChat.get(chatId);
  if (!pending) {
    pending = new Set();
    pendingVariantSelectionsByChat.set(chatId, pending);
  }
  pending.add(promise);
  try {
    await promise;
  } finally {
    pending.delete(promise);
    if (pending.size === 0) pendingVariantSelectionsByChat.delete(chatId);
  }
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

export async function renameBranchAction(chatId: ChatId, branchId: ChatBranchId, label: string): Promise<void> {
  const snapshot = await renameBranch(chatId, branchId, label);
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

export async function listChatSummariesAction(chatId: ChatId): Promise<ChatSummaryRecord[]> {
  return listChatSummaries(chatId);
}

export async function createChatSummaryAction(chatId: ChatId, input: Parameters<typeof createChatSummary>[1]): Promise<ChatSummaryRecord> {
  const result = await createChatSummary(chatId, input);
  syncSnapshot(result.snapshot);
  return result.summary;
}

export async function updateChatSummaryAction(chatId: ChatId, summaryId: string, input: Parameters<typeof updateChatSummary>[2]): Promise<ChatSummaryRecord> {
  const result = await updateChatSummary(chatId, summaryId, input);
  syncSnapshot(result.snapshot);
  return result.summary;
}

export async function deleteChatSummaryAction(chatId: ChatId, summaryId: string): Promise<void> {
  const result = await deleteChatSummary(chatId, summaryId);
  syncSnapshot(result.snapshot);
}

export async function generateChatSummaryAction(chatId: ChatId, input: Parameters<typeof generateChatSummary>[1], signal?: AbortSignal): Promise<ChatSummaryRecord> {
  const result = await generateChatSummary(chatId, input, { signal });
  syncSnapshot(result.snapshot);
  return result.chatSummary;
}

export async function updateMemorySettingsAction(chatId: ChatId, input: { messageHistoryLimit?: number; autoSummaryConfig?: Partial<AutoSummaryConfig> }): Promise<void> {
  const snapshot = await updateMemorySettings(chatId, input);
  syncSnapshot(snapshot);
}
