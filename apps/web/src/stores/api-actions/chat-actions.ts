import type { ChatBranchId, ChatId, ChatMode } from "@vibe-tavern/domain";
import type { AppMode } from "../../components/layout/app-shell-types.js";
import {
  activateBranch,
  createChat,
  deleteBranch,
  renameBranch,
  deleteChat,
  clearChat,
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
  updateInsightsConfig,
  saveChatSummary,
  summarizeChat,
  regenerateChatMessage,
  renameChat,
  setGreetingIndex,
  setCoauthorLorebooks,
  listCoauthorModules,
  setCoauthorModule,
  createCoauthorModule,
  updateCoauthorModule,
  deleteCoauthorModule,
  selectMessageVariant,
  sendChatMessage,
  setChatPersona,
  type AppSnapshot,
} from "../../app-client.js";
import type { AutoSummaryConfig, ChatSummaryRecord, InsightsConfig } from "../../app-client.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { useChatStore } from "../chat-store.js";
import { useNavigationStore } from "../navigation-store.js";
import { fetchBootstrapAction } from "./bootstrap-actions.js";

// Single canonical backend snapshot cache.
function syncSnapshot(snapshot: AppSnapshot) {
  useSnapshotStore.getState().ingestSnapshot(snapshot);
}

function syncSelectedCharacterFromSnapshot(snapshot: AppSnapshot): void {
  const characterId = snapshot.character?.id ?? snapshot.activeChat?.characterId ?? null;
  if (characterId) {
    useChatStore.getState().setSelectedCharacterId(characterId);
  }
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
  syncSelectedCharacterFromSnapshot(snapshot);
}

export async function setChatPersonaAction(chatId: ChatId, personaId: string): Promise<void> {
  const snapshot = await setChatPersona(chatId, personaId);
  syncSnapshot(snapshot);
  void fetchBootstrapAction({ silent: true });
}

export async function createChatAction(characterId: string, mode?: ChatMode): Promise<void> {
  const snapshot = await createChat(characterId, mode);
  // Creating a chat switches the active chat to the new one. Clear the
  // previous chat's messages first so a snapshot that omits `messages`
  // (Phase 3.4.2) cannot leave stale messages visible.
  useSnapshotStore.getState().clearMessages();
  syncSnapshot(snapshot);
  syncSelectedCharacterFromSnapshot(snapshot);
  // Auto-select the new chat
  const newChatId = snapshot.chats?.[0]?.id;
  if (newChatId) {
    useChatStore.getState().setActiveChatId(newChatId);
  }
  void fetchBootstrapAction({ silent: true });
}

export async function deleteChatAction(chatId: ChatId): Promise<void> {
  // The backend returns the refreshed chats list (ChatListResponse) on delete.
  // Sync it directly so the sidebar drops the deleted chat deterministically.
  // Previously the route returned 204 with no body, so the list refresh relied
  // on a fire-and-forget bootstrap that raced against switchChatAction's
  // chats-less ingest and could leave a "ghost" chat until page reload.
  const snapshot = await deleteChat(chatId);
  syncSnapshot(snapshot);
  // Clear deleted chat from active
  const current = useChatStore.getState().activeChatId;
  if (current === chatId) {
    useChatStore.getState().setActiveChatId(null);
  }
  void fetchBootstrapAction({ silent: true });
}

export async function clearChatAction(chatId: ChatId): Promise<AppSnapshot> {
  const snapshot = await clearChat(chatId);
  syncSnapshot(snapshot);
  syncSelectedCharacterFromSnapshot(snapshot);
  void fetchBootstrapAction({ silent: true });
  return snapshot;
}

export async function renameChatAction(chatId: ChatId, title: string): Promise<void> {
  const snapshot = await renameChat(chatId, title);
  // The backend returns { chats } (ChatListResponse). The sidebar renders chat
  // titles from the chats list (Sidebar.tsx / Rail.tsx), so syncing chats alone
  // updates every visible title immediately. A silent bootstrap refresh is
  // kept as a fire-and-forget guard for fields the chats list doesn't carry —
  // notably activeChat.title, which handleExportChatJsonl reads for the export
  // filename. Dropping the bootstrap would leave that one read stale until the
  // next chat switch; keeping it preserves store consistency at no UX cost.
  syncSnapshot(snapshot);
  void fetchBootstrapAction({ silent: true });
}

export async function setGreetingIndexAction(chatId: ChatId, greetingIndex: number): Promise<void> {
  const snapshot = await setGreetingIndex(chatId, greetingIndex);
  syncSnapshot(snapshot);
}

export async function setCoauthorLorebooksAction(chatId: ChatId, lorebookIds: string[]): Promise<void> {
  const snapshot = await setCoauthorLorebooks(chatId, lorebookIds);
  syncSnapshot(snapshot);
}

export async function listCoauthorModulesAction(): Promise<import("@vibe-tavern/api-contracts").CoauthorModule[]> {
  return listCoauthorModules();
}

export async function createCoauthorModuleAction(
  input: import("@vibe-tavern/api-contracts").CoauthorModuleCreate,
): Promise<import("@vibe-tavern/api-contracts").CoauthorModule> {
  return createCoauthorModule(input);
}

export async function updateCoauthorModuleAction(
  moduleId: string,
  input: import("@vibe-tavern/api-contracts").CoauthorModuleUpdate,
): Promise<import("@vibe-tavern/api-contracts").CoauthorModule> {
  return updateCoauthorModule(moduleId, input);
}

export async function deleteCoauthorModuleAction(moduleId: string): Promise<void> {
  await deleteCoauthorModule(moduleId);
}

export async function setCoauthorModuleAction(chatId: ChatId, moduleId: string | null): Promise<void> {
  const snapshot = await setCoauthorModule(chatId, moduleId);
  syncSnapshot(snapshot);
}

export async function sendChatMessageAction(chatId: ChatId, content: string, attachments?: { id: string; name: string; type: "image" | "file" | "video"; assetId: string; mimeType: string; sizeBytes: number; }[], signal?: AbortSignal): Promise<void> {
  const snapshot = await sendChatMessage(chatId, { content, attachments }, { signal });
  syncSnapshot(snapshot);
}

export async function regenerateMessageAction(chatId: ChatId, messageId: string, signal?: AbortSignal, override?: { model?: string; promptPresetId?: string }): Promise<void> {
  const snapshot = await regenerateChatMessage(chatId, messageId, { signal, override });
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
  // Switching chats must clear the previous chat's messages explicitly.
  // ingestSnapshot preserves absent fields, so without this a snapshot that
  // omits `messages` would leave the old chat's messages visible.
  useSnapshotStore.getState().clearMessages();
  const snapshot = await fetchChat(chatId);
  syncSnapshot(snapshot);
  syncSelectedCharacterFromSnapshot(snapshot);
}

/**
 * User-initiated editing-mode switch. navMode (AppMode) carries only the
 * play/build editing axis — the rp/coauthor split lives on the chat itself
 * (chatMode = activeChat.mode), read directly by the shell registry hook. So
 * this function never inspects or sets a "coauthor" navMode.
 *
 * Two cases, keyed on the ACTIVE CHAT's mode (not navMode):
 * - Active chat is RP (or absent): a plain play↔build flip, active chat untouched.
 * - Active chat is coauthor: the user is leaving coauthor for the RP editor
 *   (sole caller: CoauthorTopBar "back to editor" → newMode "build"). Reselect
 *   an RP chat for the same character first so the RP surface never mounts the
 *   coauthor chat (F-5 fix, preserved). When no RP chat exists for the
 *   character, clears activeChatId to the placeholder.
 *
 * Anchors the reselection on the active chat's characterId (falling back to
 * selectedCharacterId) for robustness against a stale selection.
 */
export async function switchModeAction(
  newMode: AppMode,
  deps: { switchChat?: (chatId: ChatId) => Promise<void> } = {},
): Promise<void> {
  const switchChat = deps.switchChat ?? switchChatAction;
  const nav = useNavigationStore.getState();
  const snap = useSnapshotStore.getState();
  const activeChat = snap.activeChat;

  // RP bucket (active chat is RP or absent): plain play↔build flip. navMode has
  // no "coauthor" value anymore; the registry reads chatMode for rp/coauthor.
  if (!activeChat || activeChat.mode !== "coauthor") {
    if (nav.mode !== newMode) nav.setMode(newMode);
    return;
  }

  // Active chat is coauthor but the user wants the RP editor. Reselect an RP
  // chat for the same character before flipping mode, so the RP surface never
  // mounts the coauthor chat (F-5).
  const characterId = activeChat.characterId ?? useChatStore.getState().selectedCharacterId;
  if (nav.mode !== newMode) nav.setMode(newMode);
  if (!characterId) return;

  const candidate = snap.chatIds
    .map((id) => snap.chatsById[id])
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .find((c) => c.characterId === characterId && c.mode !== "coauthor");

  const chat = useChatStore.getState();
  if (!candidate) {
    // No RP chat for this character → placeholder.
    if (chat.activeChatId) chat.setActiveChatId(null);
    return;
  }
  if (candidate.id === chat.activeChatId) return;
  // Load the target RP chat's snapshot; the registry renders its RP surface.
  await switchChat(candidate.id);
  chat.setActiveChatId(candidate.id);
  // Pin the user's exact requested mode (e.g. 'build' from "back to editor").
  if (useNavigationStore.getState().mode !== newMode) {
    useNavigationStore.getState().setMode(newMode);
  }
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

const pendingForks = new Map<string, Promise<void>>();

function forkRequestKey(chatId: ChatId, fromMessageId?: string): string {
  return `${chatId}::${fromMessageId ?? "head"}`;
}

export async function forkBranchAction(chatId: ChatId, fromMessageId?: string): Promise<void> {
  const key = forkRequestKey(chatId, fromMessageId);
  const pending = pendingForks.get(key);
  if (pending) return pending;

  const request = (async () => {
    const snapshot = await forkBranch(chatId, fromMessageId);
    syncSnapshot(snapshot);
  })();
  pendingForks.set(key, request);

  try {
    await request;
  } finally {
    if (pendingForks.get(key) === request) pendingForks.delete(key);
  }
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

export async function updateInsightsConfigAction(chatId: ChatId, input: { insightsConfig?: Partial<InsightsConfig> }): Promise<void> {
  const snapshot = await updateInsightsConfig(chatId, input);
  syncSnapshot(snapshot);
}
