import {
  archiveCharacter,
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  exportCharacter,
  exportChatJsonl,
  exportPromptTrace,
  importJson,
  unarchiveCharacter,
  updateCharacter,
  uploadCharacterAvatar,
  activateCharacterVersion,
  createCharacterVersion,
  deleteCharacterVersion,
  listCharacterVersions,
  renameCharacterVersion,
  type AppCharacterVersion,
  type AppSnapshot,
  type ImportJsonResponse,
} from "../../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";
import { useSnapshotStore } from "../snapshot-store.js";
import { useChatStore } from "../chat-store.js";
import { fetchBootstrapAction } from "./bootstrap-actions.js";
import { fetchChat } from "../../app-client.js";

// ---------------------------------------------------------------------------
// Character Actions
// ---------------------------------------------------------------------------

export async function saveCharacterAction(input: {
  characterId: string;
  patch: Parameters<typeof updateCharacter>[1];
}): Promise<void> {
  const snapshot = await updateCharacter(input.characterId, input.patch);
  useSnapshotStore.getState().ingestSnapshot(snapshot);
}

export async function createCharacterAction(
  input: Parameters<typeof createCharacter>[0]
): Promise<{ snapshot: AppSnapshot | null; activeChatId: string }> {
  const result = await createCharacter(input);
  if (result.snapshot) {
    useSnapshotStore.getState().ingestSnapshot(result.snapshot);
  }
  // Refresh global lists only. See importCharacterAction for why the active
  // snapshot sync is skipped: the server moves initialChatId to the new chat,
  // while activeChatId still points at the prior one, so a syncing bootstrap
  // would re-fetch and ingest the OLD chat and clobber this just-written
  // snapshot. The create response already holds the authoritative snapshot.
  await fetchBootstrapAction({ silent: true, skipSnapshotSync: true });
  return result;
}

export async function archiveCharacterAction(characterId: string): Promise<void> {
  await archiveCharacter(characterId);
  void fetchBootstrapAction({ silent: true });
}

export async function unarchiveCharacterAction(characterId: string): Promise<void> {
  await unarchiveCharacter(characterId);
  void fetchBootstrapAction({ silent: true });
}

export async function deleteCharacterAction(characterId: string): Promise<void> {
  await deleteCharacter(characterId);
  // Clear active chat/snapshot so AppShell shows placeholder instead of ghost chat
  useChatStore.getState().setActiveChatId(null);
  useSnapshotStore.getState().clear();
  void fetchBootstrapAction({ silent: true });
}

export async function avatarUploadAction(input: {
  file: File;
  originalFile?: File | null;
  characterId: string;
  chatId: ChatId;
}): Promise<void> {
  // Folder-resident upload (CFS migration): the crop is written to
  // {id}/avatar.{ext} (thumbnail, small slots) and the uncropped original to
  // {id}/avatar-full.{ext} (large slots: preview, editor). When originalFile is
  // absent (single-image upload) only the thumbnail is stored and large slots
  // fall back to it server-side.
  await uploadCharacterAvatar(input.characterId, input.file, input.originalFile ?? undefined);
  // Refresh bootstrap; syncBootstrapSnapshotForActiveChat re-fetches the active
  // chat's snapshot if it differs from bootstrap's initial chat, so the open
  // chat header picks up the new avatarExt.
  await fetchBootstrapAction({ silent: true });
}

export async function importCharacterAction(input: {
  fileName: string;
  jsonText: string;
  chatId?: ChatId;
}): Promise<ImportJsonResponse> {
  const result = await importJson(input);
  if (result.snapshot) {
    useSnapshotStore.getState().ingestSnapshot(result.snapshot);
  }
  // Refresh global lists (allCharacters, promptPresets, personas) WITHOUT
  // syncing the active snapshot: the import response already holds the new
  // chat's authoritative snapshot, and the caller (handleImportFiles) writes
  // it. A fire-and-forget bootstrap here used to race the caller's
  // writeSnapshot — the server had moved initialChatId to the new chat while
  // activeChatId still pointed at the old one, so syncBootstrapSnapshotForActiveChat
  // re-fetched and ingested the OLD chat, corrupting the store.
  await fetchBootstrapAction({ silent: true, skipSnapshotSync: true });
  return result;
}

// ---------------------------------------------------------------------------
// Export Actions
// ---------------------------------------------------------------------------

export async function exportCharacterAction(characterId: string): Promise<Record<string, unknown>> {
  return await exportCharacter(characterId);
}

export async function duplicateCharacterAction(characterId: string): Promise<ImportJsonResponse> {
  const result = await duplicateCharacter(characterId);
  void fetchBootstrapAction({ silent: true });
  return result;
}

// ---------------------------------------------------------------------------
// Character Version Actions (VTF Phase 3)
// ---------------------------------------------------------------------------

/** List versions. Server lazily bootstraps an implicit "Base" if none exist. */
export async function listCharacterVersionsAction(characterId: string): Promise<AppCharacterVersion[]> {
  return await listCharacterVersions(characterId);
}

/** Branch: snapshot current root into the old active version, flip a new one active. */
export async function createCharacterVersionAction(characterId: string, title: string): Promise<AppCharacterVersion> {
  const version = await createCharacterVersion(characterId, title);
  // No snapshot reload — the new version starts as an identical copy of the
  // current root, so the open draft stays valid and editable.
  return version;
}

/** Activate a version: folder swap + flag flip, then reload the active snapshot. */
export async function activateCharacterVersionAction(characterId: string, versionId: string): Promise<AppCharacterVersion> {
  const version = await activateCharacterVersion(characterId, versionId);
  // The active version's content now lives at the root; reload the open chat's
  // snapshot so the editor reflects it. Only ingest if the user hasn't since
  // switched chats (avoids clobbering a different chat's state).
  const activeChatId = useChatStore.getState().activeChatId;
  if (activeChatId) {
    const snapshot = await fetchChat(activeChatId);
    if (useChatStore.getState().activeChatId === activeChatId) {
      useSnapshotStore.getState().ingestSnapshot(snapshot);
    }
  }
  return version;
}

/** Rename a version's title without touching content. */
export async function renameCharacterVersionAction(characterId: string, versionId: string, title: string): Promise<AppCharacterVersion> {
  return await renameCharacterVersion(characterId, versionId, title);
}

/** Delete a non-active version (refuses the active one server-side). */
export async function deleteCharacterVersionAction(characterId: string, versionId: string): Promise<void> {
  await deleteCharacterVersion(characterId, versionId);
}

export async function exportChatJsonlAction(chatId: ChatId): Promise<string> {
  return await exportChatJsonl(chatId);
}

export async function exportPromptTraceAction(traceId: string): Promise<Record<string, unknown>> {
  return await exportPromptTrace(traceId);
}
