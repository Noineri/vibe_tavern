import { useState, type ChangeEvent, type DragEvent } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import type { VtfCharacterContent } from "@vibe-tavern/db/codecs";
import { toast } from "sonner";
import { getT } from "../i18n/locale-helpers.js";
import {
  uploadCharacterAvatar,
  type AppSnapshot,
  type AppCharacter,
  type AppPersona,
  type AppMessage,
  type ChatListItem,
} from "../app-client.js";
import type { BuildCharacterDraft } from "../components/build/BuildMode.js";
import { useCharacterImport } from "./use-character-import.js";
import { useChatStore } from "../stores/chat-store.js";
import { useNavigationStore } from "../stores/navigation-store.js";
import { useCharacterStore } from "../stores/character-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { exportCharaCardPng } from "../lib/png-writer.js";
import { resolveEntityAvatarUrl } from "../lib/avatar.js";
import {
  saveCharacterAction,
  createCharacterAction,
  archiveCharacterAction,
  unarchiveCharacterAction,
  deleteCharacterAction,
  duplicateCharacterAction,
  avatarUploadAction,
  exportCharacterAction,
  exportChatJsonlAction,
  exportPromptTraceAction,
} from "../stores/api-actions/character-actions.js";
import { fetchBootstrapAction } from "../stores/api-actions/bootstrap-actions.js";
import {
  createPersonaAction,
  updatePersonaAction,
  deletePersonaAction,
  duplicatePersonaAction,
  setDefaultPersonaAction,
} from "../stores/api-actions/persona-actions.js";
import {
  setChatPersonaAction,
  createChatAction,
  deleteChatAction,
  clearChatAction,
  renameChatAction,
  switchChatAction,
} from "../stores/api-actions/chat-actions.js";

export type ChatRemovalMode = "delete" | "clear";

export interface CharacterControllerActions {
  handleSaveCharacter: (draftInput: BuildCharacterDraft) => Promise<void>;
  handleAvatarUpload: (file: File, originalFile?: File | null) => Promise<void>;
  handleSavePersona: (personaId: string, draftInput: { name: string; description: string; pronouns?: string | null; avatarAssetId?: string | null; avatarFullAssetId?: string | null; avatarCropJson?: string | null }) => Promise<void>;
  handleSetChatPersona: (personaId: string) => Promise<void>;
  handleCreatePersona: (input: { name: string; description: string; pronouns?: string | null }) => Promise<{ id: string } | null>;
  handleDeletePersona: (personaId: string) => Promise<{ ok: boolean; error?: string }>;
  handleDuplicatePersona: (personaId: string) => Promise<void>;
  handleSetDefaultPersona: (personaId: string) => Promise<void>;
  handleImportFiles: (files: FileList | File[]) => Promise<void>;
  handleImportDragOver: (event: DragEvent<HTMLLabelElement>) => void;
  handleImportDragLeave: () => void;
  handleImportDrop: (event: DragEvent<HTMLLabelElement>) => void;
  handleImportInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleArchiveCharacter: (characterId: string) => Promise<void>;
  handleUnarchiveCharacter: (characterId: string) => Promise<void>;
  handleDeleteCharacter: (characterId: string) => Promise<void>;
  handleDuplicateCharacter: (characterId: string) => Promise<void>;
  getChatRemovalMode: (chatId: ChatId) => ChatRemovalMode;
  handleRemoveChat: (chatId: ChatId) => Promise<void>;
  handleDeleteChat: (chatId: ChatId) => Promise<void>;
  handleClearChat: (chatId: ChatId) => Promise<void>;
  handleRenameChat: (chatId: ChatId, title: string) => Promise<void>;
  handleCreateChat: (characterId?: string) => Promise<void>;
  handleCreateCharacter: (input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string; mesExample?: string; alternateGreetings?: string[]; postHistoryInstructions?: string; creatorNotes?: string; systemPrompt?: string; depthPrompt?: string; depthPromptDepth?: number; depthPromptRole?: string; tags?: string[] }, avatarFile?: File | null, avatarOriginalFile?: File | null) => Promise<{ characterId: string; chatId: string } | null>;
  handleExportCharacter: (characterId: string) => Promise<void>;
  handleExportPng: (characterId: string) => Promise<void>;
  handleExportChatJsonl: (chatId: ChatId) => Promise<void>;
  handleExportPromptTrace: (traceId: string) => Promise<void>;
  isSavingCharacter: boolean;
  isImporting: boolean;
}

function formatImportWarnings(count: number): string {
  return count > 0 ? ` (${count} warning${count === 1 ? "" : "s"})` : "";
}

function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function useCharacterController(): CharacterControllerActions {
  const [isSavingCharacter, setIsSavingCharacter] = useState(false);

  // --- Store helpers ---
  function getActiveChatId(): ChatId | null { return useChatStore.getState().activeChatId; }

  /*
   * A snapshot reconstructed from the store: every populated field is present
   * (required, not optional) and character is non-null. getSnapshot() returns
   * null entirely when there is no active character, so callers can read
   * character/chats/etc. without presence guards. Distinct from the wire type
   * AppSnapshot (all-optional, character may be null) because the store is the
   * canonical MERGED state.
   */
  type StoreSnapshot = Required<Omit<AppSnapshot, "character" | "persona">> & {
    character: AppCharacter;
    persona: AppPersona | null;
  };

  function getSnapshot(): StoreSnapshot | null {
    const state = useSnapshotStore.getState();
    if (!state.character || !state.activeChat) return null;

    return {
      character: state.character,
      persona: state.persona,
      activeChat: state.activeChat,
      activeBranch: state.activeBranch,
      branches: state.branches,
      summaries: state.summaries,
      messages: state.messageOrder
        .map((id) => state.messagesById[id])
        .filter((message): message is AppMessage => Boolean(message)),
      chats: state.chatIds
        .map((id) => state.chatsById[id])
        .filter((chat): chat is ChatListItem => Boolean(chat)),
      allCharacters: state.allCharacters,
      promptTrace: state.promptTrace,
      contextPreview: state.contextPreview,
    } as StoreSnapshot;
  }

  function writeSnapshot(chatId: ChatId, next: AppSnapshot): void {
    useSnapshotStore.getState().ingestSnapshot(next);
    if (useChatStore.getState().activeChatId !== chatId) {
      useChatStore.getState().setActiveChatId(chatId);
    }
  }

  // --- Import hook ---
  const { importFile, isImporting } = useCharacterImport();

  async function handleSaveCharacter(draftInput: BuildCharacterDraft): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = getSnapshot();
    if (!activeChatId || !snapshot) return;

    setIsSavingCharacter(true);
    try {
      await saveCharacterAction({
        characterId: snapshot.character.id,
        patch: {
          chatId: activeChatId,
          name: draftInput.name,
          description: draftInput.description,
          personalitySummary: draftInput.personalitySummary,
          firstMessage: draftInput.firstMessage,
          scenario: draftInput.scenario,
          systemPrompt: draftInput.systemPrompt,
          mesExample: draftInput.mesExample,
          alternateGreetings: draftInput.alternateGreetings,
          postHistoryInstructions: draftInput.postHistoryInstructions,
          creatorNotes: draftInput.creatorNotes,
          depthPrompt: draftInput.depthPrompt,
          depthPromptDepth: draftInput.depthPromptDepth,
          depthPromptRole: draftInput.depthPromptRole,
          tags: draftInput.tags,
        },
      });
      toast.success(getT()("char_card_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("char_save_failed"));
      throw error;
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleAvatarUpload(file: File, originalFile?: File | null): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = getSnapshot();
    if (!activeChatId || !snapshot) return;

    setIsSavingCharacter(true);
    try {
      await avatarUploadAction({
        file,
        originalFile,
        characterId: snapshot.character.id,
        chatId: activeChatId,
      });
      toast.success(getT()("char_avatar_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("char_avatar_save_failed"));
      throw error;
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleSavePersona(personaId: string, draftInput: { name: string; description: string; pronouns?: string | null; avatarAssetId?: string | null; avatarFullAssetId?: string | null; avatarCropJson?: string | null }): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    setIsSavingCharacter(true);
    try {
      await updatePersonaAction({
        personaId,
        patch: {
          chatId: activeChatId,
          name: draftInput.name,
          description: draftInput.description,
          pronouns: draftInput.pronouns,
          avatarAssetId: draftInput.avatarAssetId,
          avatarFullAssetId: draftInput.avatarFullAssetId,
          avatarCropJson: draftInput.avatarCropJson,
        },
      });
      toast.success(getT()("persona_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("persona_save_failed"));
      throw error;
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleSetChatPersona(personaId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;
    const currentPersonaId = getSnapshot()?.persona?.id ?? null;
    if (currentPersonaId === personaId) return;
    try {
      await setChatPersonaAction(activeChatId, personaId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : getT()("persona_switch_failed"));
    }
  }

  async function handleCreatePersona(input: { name: string; description: string; pronouns?: string | null }): Promise<{ id: string } | null> {
    try {
      const created = await createPersonaAction({
        name: input.name.trim(),
        description: input.description.trim(),
        pronouns: input.pronouns,
      });
      return { id: created.id };
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("persona_create_failed"));
      return null;
    }
  }

  async function handleDeletePersona(personaId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await deletePersonaAction(personaId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : getT()("persona_delete_failed") };
    }
  }

  async function handleDuplicatePersona(personaId: string): Promise<void> {
    try {
      await duplicatePersonaAction(personaId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_duplicate"));
    }
  }

  async function handleSetDefaultPersona(personaId: string): Promise<void> {
    try {
      await setDefaultPersonaAction(personaId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_set_default_persona"));
    }
  }

  async function handleImportFiles(files: FileList | File[]): Promise<void> {
    const firstFile = Array.from(files)[0];
    if (!firstFile) return;

    try {
      const imported = await importFile(firstFile, { chatId: getActiveChatId() ?? undefined });

      writeSnapshot(imported.activeChatId, imported.snapshot);

      if (imported.imported.kind === "character") {
        useNavigationStore.getState().setMode("play");
        toast.success(`${getT()("imported_character").replace("{name}", imported.imported.name)}${formatImportWarnings(imported.imported.warningCount)}`);
      } else if (imported.imported.kind === "chat") {
        useNavigationStore.getState().setMode("play");
        toast.success(`${getT()("imported_chat").replace("{name}", imported.imported.name)}${formatImportWarnings(imported.imported.warningCount)}`);
      } else {
        toast.success(`${getT()("attached_lorebook").replace("{name}", imported.imported.name).replace("{char}", imported.imported.attachedToCharacterName ?? "current character")}${formatImportWarnings(imported.imported.warningCount)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("import_failed_notice"));
    } finally {
      useCharacterStore.getState().setIsImportDragActive(false);
    }
  }

  function handleImportDragOver(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    useCharacterStore.getState().setIsImportDragActive(true);
  }

  function handleImportDragLeave(): void {
    useCharacterStore.getState().setIsImportDragActive(false);
  }

  function handleImportDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    useCharacterStore.getState().setIsImportDragActive(false);
    if (event.dataTransfer.files.length > 0) {
      void handleImportFiles(event.dataTransfer.files);
    }
  }

  function handleImportInputChange(event: ChangeEvent<HTMLInputElement>): void {
    if (event.target.files && event.target.files.length > 0) {
      void handleImportFiles(event.target.files);
      event.target.value = "";
    }
  }

  async function handleArchiveCharacter(characterId: string): Promise<void> {
    await archiveCharacterAction(characterId);
  }

  async function handleUnarchiveCharacter(characterId: string): Promise<void> {
    await unarchiveCharacterAction(characterId);
  }

  async function handleDeleteCharacter(characterId: string): Promise<void> {
    await deleteCharacterAction(characterId);
  }

  async function handleDuplicateCharacter(characterId: string): Promise<void> {
    try {
      const result = await duplicateCharacterAction(characterId);
      if (result.snapshot) {
        writeSnapshot(result.activeChatId, result.snapshot);
      }
      toast.success(getT()("character_duplicated"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_duplicate"));
    }
  }

  function getChatRemovalMode(chatId: ChatId): ChatRemovalMode {
    const snapshot = getSnapshot();
    const targetChat = snapshot?.chats.find((c) => c.id === chatId);
    const characterId = targetChat?.characterId ?? snapshot?.character.id;
    if (!snapshot || !characterId) return "delete";

    const characterChatCount = snapshot.chats.filter((c) => c.characterId === characterId).length;
    return characterChatCount <= 1 ? "clear" : "delete";
  }

  async function handleRemoveChat(chatId: ChatId): Promise<void> {
    if (getChatRemovalMode(chatId) === "clear") {
      await handleClearChat(chatId);
      return;
    }
    await handleDeleteChat(chatId);
  }

  async function handleDeleteChat(chatId: ChatId): Promise<void> {
    if (getChatRemovalMode(chatId) === "clear") {
      await handleClearChat(chatId);
      return;
    }

    const snapshot = getSnapshot();
    const targetChat = snapshot?.chats.find((c) => c.id === chatId);
    const characterId = targetChat?.characterId ?? snapshot?.character.id;

    // Find next chat for the same character before deleting
    let nextChatId: string | null = null;
    if (snapshot && characterId) {
      const remaining = snapshot.chats
        .filter(c => c.id !== chatId && c.characterId === characterId)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      nextChatId = remaining[0]?.id ?? null;
    }
    await deleteChatAction(chatId);
    // Switch to next chat or clear
    if (nextChatId) {
      await switchChatAction(nextChatId as ChatId);
    }
  }

  async function handleClearChat(chatId: ChatId): Promise<void> {
    const snapshot = await clearChatAction(chatId);
    if (snapshot.activeChat?.id) {
      useChatStore.getState().setActiveChatId(snapshot.activeChat.id as ChatId);
    }
  }

  async function handleRenameChat(chatId: ChatId, title: string): Promise<void> {
    const nextTitle = title.trim();
    if (!nextTitle) return;

    try {
      await renameChatAction(chatId, nextTitle);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("chat_rename_failed"));
    }
  }

  async function handleCreateChat(characterId?: string): Promise<void> {
    const resolvedId = characterId ?? getSnapshot()?.character.id;
    if (!resolvedId) return;
    try {
      await createChatAction(resolvedId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("chat_create_failed"));
    }
  }

  async function handleCreateCharacter(input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string; mesExample?: string; alternateGreetings?: string[]; postHistoryInstructions?: string; creatorNotes?: string; systemPrompt?: string; depthPrompt?: string; depthPromptDepth?: number; depthPromptRole?: string; tags?: string[] }, avatarFile?: File | null, avatarOriginalFile?: File | null): Promise<{ characterId: string; chatId: string } | null> {
    setIsSavingCharacter(true);
    try {
      const result = await createCharacterAction(input);

      const characterId = result.snapshot?.character?.id;

      // Upload avatar if provided (folder-resident route: crop → {id}/avatar.{ext},
      // original → {id}/avatar-full.{ext}). Sets avatarExt, clears legacy
      // avatarAssetId.
      if (avatarFile && characterId) {
        try {
          await uploadCharacterAvatar(characterId, avatarFile, avatarOriginalFile ?? undefined);
          await fetchBootstrapAction({ silent: true });
        } catch (err) {
          console.warn("Failed to upload avatar during character creation:", err);
          // createCharacterAction already synced the base snapshot
        }
      } else {
        // createCharacterAction already synced the snapshot
      }

      if (characterId) {
        return { characterId, chatId: result.activeChatId };
      }
      return null;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_create_character"));
      return null;
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleExportCharacter(characterId: string): Promise<void> {
    try {
      const data = await exportCharacterAction(characterId);
      const name = getSnapshot()?.character.name ?? "character";
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeName}.chara_card_v3.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_export_character"));
    }
  }

  async function handleExportPng(characterId: string): Promise<void> {
    try {
      const data = await exportCharacterAction(characterId);
      const name = getSnapshot()?.character.name ?? "character";
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const json = JSON.stringify(data);

      const char = getSnapshot()?.character;
      const avatarUrl = char
        ? resolveEntityAvatarUrl({ kind: "characters", id: char.id, avatarExt: char.avatarExt, avatarAssetId: char.avatarAssetId, avatarFullAssetId: char.avatarFullAssetId, updatedAt: char.updatedAt, preferFull: true })
        : null;
      if (!avatarUrl) throw new Error("No avatar");

      const resp = await fetch(avatarUrl);
      if (!resp.ok) throw new Error(`Avatar fetch failed: ${resp.status}`);

      const imageBytes = new Uint8Array(await resp.arrayBuffer());
      const outputPng = await exportCharaCardPng(imageBytes, json, char ? appCharacterToVtfContent(char, data) : undefined);

      const blob = new Blob([outputPng.buffer.slice(outputPng.byteOffset, outputPng.byteOffset + outputPng.byteLength) as ArrayBuffer], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeName}.chara_card_v3.png`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_export_png"));
    }
  }

  async function handleExportChatJsonl(chatId: ChatId): Promise<void> {
    try {
      const text = await exportChatJsonlAction(chatId);
      const title = useSnapshotStore.getState().activeChat?.title ?? "chat";
      const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeTitle}.jsonl`, text, "application/x-ndjson");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_export_chat"));
    }
  }

  async function handleExportPromptTrace(traceId: string): Promise<void> {
    try {
      const data = await exportPromptTraceAction(traceId);
      downloadTextFile(`prompt-trace-${traceId}.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_export_trace"));
    }
  }

  return {
    handleSaveCharacter,
    handleAvatarUpload,
    handleSavePersona,
    handleSetChatPersona,
    handleCreatePersona,
    handleDeletePersona,
    handleDuplicatePersona,
    handleSetDefaultPersona,
    handleImportFiles,
    handleImportDragOver,
    handleImportDragLeave,
    handleImportDrop,
    handleImportInputChange,
    handleArchiveCharacter,
    handleUnarchiveCharacter,
    handleDeleteCharacter,
    handleDuplicateCharacter,
    getChatRemovalMode,
    handleRemoveChat,
    handleDeleteChat,
    handleClearChat,
    handleRenameChat,
    handleCreateChat,
    handleCreateCharacter,
    handleExportCharacter,
    handleExportPng,
    handleExportChatJsonl,
    handleExportPromptTrace,
    isSavingCharacter,
    isImporting,
  };
}

/**
 * Map an `AppCharacter` (frontend snapshot type) + the V3 export JSON to a
 * `VtfCharacterContent` (the db storage/exchange type `packMonolith` consumes).
 * Used by PNG export to embed the lossless `vtmd` monolith chunk alongside the
 * ST-compatible `chara`/`ccv3` chunks. `scenario` → `defaultScenario` is the one
 * field rename; `extensions` is lifted out of the V3 `data.extensions` block.
 * Tolerant: a missing/malformed extensions block yields `{}` rather than throwing.
 */
function appCharacterToVtfContent(char: AppCharacter, v3Export: Record<string, unknown>): VtfCharacterContent {
  const dataBlock = v3Export.data;
  const ext = dataBlock && typeof dataBlock === "object" && !Array.isArray(dataBlock)
    ? (dataBlock as Record<string, unknown>).extensions
    : undefined;
  const extensions = ext && typeof ext === "object" && !Array.isArray(ext)
    ? (ext as Record<string, unknown>)
    : {};
  return {
    name: char.name,
    description: char.description,
    personalitySummary: char.personalitySummary,
    defaultScenario: char.scenario ?? null,
    firstMessage: char.firstMessage ?? "",
    mesExample: char.mesExample,
    mesExampleMode: char.mesExampleMode,
    mesExampleDepth: char.mesExampleDepth,
    alternateGreetings: char.alternateGreetings,
    postHistoryInstructions: char.postHistoryInstructions,
    creatorNotes: char.creatorNotes,
    depthPrompt: char.depthPrompt,
    depthPromptDepth: char.depthPromptDepth,
    depthPromptRole: char.depthPromptRole,
    systemPrompt: char.systemPrompt,
    tags: char.tags,
    extensions,
  };
}
