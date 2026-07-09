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
import type { AutoSummaryConfig, ChatSummaryRecord } from "../../app-client.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { useChatStore } from "../chat-store.js";
import { useNavigationStore } from "../navigation-store.js";
import { fetchBootstrapAction, reconcileNavModeFromChat } from "./bootstrap-actions.js";

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
  // Flip nav mode to match the new chat (co-author chat → co-author shell).
  // See reconcileNavModeFromChat in bootstrap-actions (CA-8b.2).
  reconcileNavModeFromChat(snapshot.activeChat);
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
  // Flip nav mode to match the switched-to chat: a co-author chat enters the
  // co-author shell, and switching from co-author back to an RP chat exits it.
  // See reconcileNavModeFromChat in bootstrap-actions (CA-8b.2).
  reconcileNavModeFromChat(snapshot.activeChat);
}

/**
 * User-initiated navigation-mode switch (the forward direction of the
 * mode↔activeChat coupling — `reconcileNavModeFromChat` is the inverse).
 *
 * Today every nav `setMode` site either stays inside the RP bucket (play↔build:
 * TopBar toggle, Rail build-panel, MediaMenu/MediaModal, import) or crosses the
 * coauthor↔RP boundary (CoauthorTopBar "back to editor"). The within-bucket
 * case is a plain mode flip with the active chat untouched. The boundary case
 * is the F-5 fix: flipping mode alone left `activeChatId` on the co-author
 * chat, so the RP surface mounted a co-author chat indefinitely. Now the
 * boundary crossing also reselects a chat of the new bucket for the active
 * character (most-recent first), so mode and activeChat always agree.
 *
 * Ping-pong safety: `switchChatAction` calls `reconcileNavModeFromChat`, but
 * that only flips mode ACROSS the boundary — after the reselection we are
 * in-bucket, so it is a no-op and the two reconcile directions cannot loop.
 *
 * Anchors the reselection on the active chat's `characterId` (falling back to
 * `selectedCharacterId`), not on `selectedCharacterId` alone, so the result is
 * robust against a stale selection. When no chat of the new bucket exists for
 * the character, clears `activeChatId` to the placeholder rather than leaving
 * the cross-bucket chat mounted.
 */
export async function switchModeAction(
  newMode: AppMode,
  deps: { switchChat?: (chatId: ChatId) => Promise<void> } = {},
): Promise<void> {
  const switchChat = deps.switchChat ?? switchChatAction;
  const nav = useNavigationStore.getState();
  const prevMode = nav.mode;
  if (prevMode === newMode) return;

  const crossingBoundary = (prevMode === "coauthor") !== (newMode === "coauthor");
  // Within-bucket switch (play↔build): keep the active RP chat, just flip mode.
  if (!crossingBoundary) {
    nav.setMode(newMode);
    return;
  }

  // Crossing coauthor↔RP: reselect a chat of the new bucket for the active
  // character before flipping mode, so the new surface never mounts the old
  // bucket's chat.
  const snap = useSnapshotStore.getState();
  const characterId = snap.activeChat?.characterId ?? useChatStore.getState().selectedCharacterId;
  nav.setMode(newMode);
  if (!characterId) return;

  const wantCoauthor = newMode === "coauthor";
  const candidate = snap.chatIds
    .map((id) => snap.chatsById[id])
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .find((c) =>
      c.characterId === characterId &&
      (wantCoauthor ? c.mode === "coauthor" : c.mode !== "coauthor"),
    );

  const chat = useChatStore.getState();
  if (!candidate) {
    // No chat of the new bucket for this character → placeholder.
    if (chat.activeChatId) chat.setActiveChatId(null);
    return;
  }
  if (candidate.id === chat.activeChatId) return;
  // Load the target chat's snapshot. switchChatAction runs
  // reconcileNavModeFromChat internally; it is an in-bucket no-op here.
  await switchChat(candidate.id);
  chat.setActiveChatId(candidate.id);
  // switchChatAction's reconcile may have chosen 'play' for an RP chat; pin the
  // user's exact requested mode (e.g. 'build' from "back to editor").
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
