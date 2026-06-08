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
  updateCharacterAvatar,
  uploadAsset,
  type AppSnapshot,
  type ImportJsonResponse,
} from "../../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";
import { useSnapshotStore } from "../snapshot-store.js";
import { fetchBootstrapAction } from "./bootstrap-actions.js";

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
  void fetchBootstrapAction({ silent: true });
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
  void fetchBootstrapAction({ silent: true });
}

export async function avatarUploadAction(input: {
  file: File;
  originalFile?: File | null;
  avatarCropJson?: string | null;
  characterId: string;
  chatId: ChatId;
}): Promise<void> {
  const originalAsset = await uploadAsset(input.originalFile ?? input.file);
  const snapshot = await updateCharacterAvatar(
    input.characterId,
    input.chatId,
    originalAsset.assetId,
    undefined,
    input.avatarCropJson,
  );
  useSnapshotStore.getState().ingestSnapshot(snapshot);
  void fetchBootstrapAction({ silent: true });
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
  void fetchBootstrapAction({ silent: true });
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

export async function exportChatJsonlAction(chatId: ChatId): Promise<string> {
  return await exportChatJsonl(chatId);
}

export async function exportPromptTraceAction(traceId: string): Promise<Record<string, unknown>> {
  return await exportPromptTrace(traceId);
}
