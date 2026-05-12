import type { ChangeEvent, DragEvent } from "react";
import type { ChatId } from "@rp-platform/domain";
import { toast } from "sonner";
import { getT } from "../i18n/context.js";
import {
  setPersonalLorebookEnabled,
  uploadAsset,
  updateCharacterAvatar,
  type AppSnapshot,
  type ImportJsonResponse,
} from "../app-client.js";
import type { AppMode } from "../components/app-shell-types.js";
import type { BuildCharacterDraft } from "../components/BuildMode.js";
import type { CharacterImportOptions } from "./use-character-import.js";
import {
  useSaveCharacterMutation,
  useCreateCharacterMutation,
  useArchiveCharacterMutation,
  useUnarchiveCharacterMutation,
  useDeleteCharacterMutation,
  useAvatarUploadMutation,
  useExportCharacterMutation,
  useExportChatJsonlMutation,
  useExportPromptTraceMutation,
  useCreatePersonaMutation,
  useUpdatePersonaMutation,
  useDeletePersonaMutation,
  useSetChatPersonaMutation,
  useCreateChatMutation,
  useDeleteChatMutation as useDeleteChatTqMutation,
  useRenameChatMutation,
} from "../queries/index.js";
import { useQueryClient } from "@tanstack/react-query";
import { bootstrapKeys, personaKeys } from "../queries/query-keys.js";

export interface CharacterControllerDeps {
  // read state (getter functions — Zustand-compatible)
  getActiveChatId: () => ChatId | null;
  getSnapshot: () => AppSnapshot | null;
  // write / mutate
  writeSnapshot: (chatId: ChatId, next: AppSnapshot) => void;
  patchSnapshot: (updater: (snapshot: AppSnapshot) => AppSnapshot) => void;
  setMode: (mode: AppMode) => void;
  setIsImportDragActive: (active: boolean) => void;
  // action callbacks
  importFile: (file: File, options?: CharacterImportOptions) => Promise<ImportJsonResponse>;
}

export interface CharacterControllerActions {
  handleSaveCharacter: (draftInput: BuildCharacterDraft) => Promise<void>;
  handleAvatarUpload: (file: File) => Promise<void>;
  handleSavePersona: (personaId: string, draftInput: { name: string; description: string; pronouns?: string | null; avatarAssetId?: string | null }) => Promise<void>;
  handleSetChatPersona: (personaId: string) => Promise<void>;
  handleCreatePersona: (input: { name: string; description: string; pronouns?: string | null }) => Promise<{ id: string } | null>;
  handleDeletePersona: (personaId: string) => Promise<{ ok: boolean; error?: string }>;
  handleSetPersonalLorebook: (personaId: string, enabled: boolean) => Promise<{ enabled: boolean; lorebookId: string | null } | null>;
  handleImportFiles: (files: FileList | File[]) => Promise<void>;
  handleImportDragOver: (event: DragEvent<HTMLLabelElement>) => void;
  handleImportDragLeave: () => void;
  handleImportDrop: (event: DragEvent<HTMLLabelElement>) => void;
  handleImportInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleArchiveCharacter: (characterId: string) => Promise<void>;
  handleUnarchiveCharacter: (characterId: string) => Promise<void>;
  handleDeleteCharacter: (characterId: string) => Promise<void>;
  handleDeleteChat: (chatId: ChatId) => Promise<void>;
  handleRenameChat: (chatId: ChatId, title: string) => Promise<void>;
  handleCreateChat: (characterId?: string) => Promise<void>;
  handleCreateCharacter: (input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string }, avatarFile?: File | null) => Promise<{ characterId: string; chatId: string } | null>;
  handleFreeChat: () => Promise<void>;
  handleExportCharacter: (characterId: string) => Promise<void>;
  handleExportChatJsonl: (chatId: ChatId) => Promise<void>;
  handleExportPromptTrace: (traceId: string) => Promise<void>;
  /** Derived from TQ mutation pending state — wire to store isSavingCharacter */
  isSavingCharacter: boolean;
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

export function useCharacterController(deps: CharacterControllerDeps): CharacterControllerActions {
  const {
    getActiveChatId,
    getSnapshot,
    writeSnapshot,
    patchSnapshot,
    setMode,
    setIsImportDragActive,
    importFile,
  } = deps;

  // --- TQ mutations ---
  const saveCharacterMut = useSaveCharacterMutation();
  const createCharacterMut = useCreateCharacterMutation();
  const archiveCharacterMut = useArchiveCharacterMutation();
  const unarchiveCharacterMut = useUnarchiveCharacterMutation();
  const deleteCharacterMut = useDeleteCharacterMutation();
  const avatarUploadMut = useAvatarUploadMutation();
  const exportCharacterMut = useExportCharacterMutation();
  const exportChatJsonlMut = useExportChatJsonlMutation();
  const exportPromptTraceMut = useExportPromptTraceMutation();
  const createPersonaMut = useCreatePersonaMutation();
  const updatePersonaMut = useUpdatePersonaMutation();
  const deletePersonaMut = useDeletePersonaMutation();
  const setChatPersonaMut = useSetChatPersonaMutation();
  const createChatMut = useCreateChatMutation();
  const deleteChatMut = useDeleteChatTqMutation();
  const renameChatMut = useRenameChatMutation();
  const qc = useQueryClient();

  // Sync mutation pending state → store isSavingCharacter
  const isSavingCharacter =
    saveCharacterMut.isPending ||
    avatarUploadMut.isPending ||
    updatePersonaMut.isPending ||
    createCharacterMut.isPending;

  async function handleSaveCharacter(draftInput: BuildCharacterDraft): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = getSnapshot();
    if (!activeChatId || !snapshot) return;

    try {
      const nextSnapshot = await saveCharacterMut.mutateAsync({
        characterId: snapshot.character.id,
        patch: {
          chatId: activeChatId,
          name: draftInput.name,
          description: draftInput.description,
          subtitle: draftInput.personalitySummary,
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
      writeSnapshot(activeChatId, nextSnapshot);
      toast.success(getT()("char_card_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("char_save_failed"));
      throw error;
    }
  }

  async function handleAvatarUpload(file: File): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = getSnapshot();
    if (!activeChatId || !snapshot) return;

    try {
      const nextSnapshot = await avatarUploadMut.mutateAsync({
        file,
        characterId: snapshot.character.id,
        chatId: activeChatId,
      });
      writeSnapshot(activeChatId, nextSnapshot);
      toast.success(getT()("char_avatar_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("char_avatar_save_failed"));
      throw error;
    }
  }

  async function handleSavePersona(personaId: string, draftInput: { name: string; description: string; pronouns?: string | null; avatarAssetId?: string | null }): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    try {
      const nextSnapshot = await updatePersonaMut.mutateAsync({
        personaId,
        patch: {
          chatId: activeChatId,
          name: draftInput.name,
          description: draftInput.description,
          pronouns: draftInput.pronouns,
          avatarAssetId: draftInput.avatarAssetId,
        },
      });
      void qc.invalidateQueries({ queryKey: personaKeys.list() });
      writeSnapshot(activeChatId, nextSnapshot);
      toast.success(getT()("persona_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("persona_save_failed"));
      throw error;
    }
  }

  async function handleSetChatPersona(personaId: string): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;
    // No-op when the persona is already active — avoids unnecessary snapshot refresh
    // that could reset transient UI state like swipe position.
    const currentPersonaId = getSnapshot()?.persona?.id ?? null;
    if (currentPersonaId === personaId) return;
    try {
      writeSnapshot(activeChatId, await setChatPersonaMut.mutateAsync({ chatId: activeChatId, personaId }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : getT()("persona_switch_failed"));
    }
  }

  async function handleCreatePersona(input: { name: string; description: string; pronouns?: string | null }): Promise<{ id: string } | null> {
    try {
      const created = await createPersonaMut.mutateAsync({
        name: input.name.trim(),
        description: input.description.trim(),
        pronouns: input.pronouns,
      });
      void qc.invalidateQueries({ queryKey: personaKeys.list() });
      return { id: created.id };
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("persona_create_failed"));
      return null;
    }
  }

  async function handleDeletePersona(personaId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await deletePersonaMut.mutateAsync(personaId);
      void qc.invalidateQueries({ queryKey: personaKeys.list() });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : getT()("persona_delete_failed") };
    }
  }

  async function handleSetPersonalLorebook(personaId: string, enabled: boolean): Promise<{ enabled: boolean; lorebookId: string | null } | null> {
    try {
      return await setPersonalLorebookEnabled(personaId, enabled);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_update_lorebook"));
      return null;
    }
  }

  async function handleImportFiles(files: FileList | File[]): Promise<void> {
    const firstFile = Array.from(files)[0];
    if (!firstFile) return;

    try {
      const imported = await importFile(firstFile, { chatId: getActiveChatId() ?? undefined });

      writeSnapshot(imported.activeChatId, imported.snapshot);
      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });

      if (imported.imported.kind === "character") {
        setMode("play");
        toast.success(`${getT()("imported_character").replace("{name}", imported.imported.name)}${formatImportWarnings(imported.imported.warningCount)}`);
      } else if (imported.imported.kind === "chat") {
        setMode("play");
        toast.success(`${getT()("imported_chat").replace("{name}", imported.imported.name)}${formatImportWarnings(imported.imported.warningCount)}`);
      } else {
        toast.success(`${getT()("attached_lorebook").replace("{name}", imported.imported.name).replace("{char}", imported.imported.attachedToCharacterName ?? "current character")}${formatImportWarnings(imported.imported.warningCount)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("import_failed_notice"));
    } finally {
      setIsImportDragActive(false);
    }
  }

  function handleImportDragOver(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setIsImportDragActive(true);
  }

  function handleImportDragLeave(): void {
    setIsImportDragActive(false);
  }

  function handleImportDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setIsImportDragActive(false);
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
    await archiveCharacterMut.mutateAsync(characterId);
  }

  async function handleUnarchiveCharacter(characterId: string): Promise<void> {
    await unarchiveCharacterMut.mutateAsync(characterId);
  }

  async function handleDeleteCharacter(characterId: string): Promise<void> {
    await deleteCharacterMut.mutateAsync(characterId);
  }

  async function handleDeleteChat(chatId: ChatId): Promise<void> {
    await deleteChatMut.mutateAsync(chatId);
  }

  async function handleRenameChat(chatId: ChatId, title: string): Promise<void> {
    const nextTitle = title.trim();
    if (!nextTitle) return;

    const snapshot = getSnapshot();
    const chat = snapshot?.chats.find((item) => item.id === chatId);
    const previousTitle = chat?.title ?? (snapshot?.activeChat.id === chatId ? snapshot.activeChat.title : null);

    const applyTitle = (value: string) => {
      patchSnapshot((current) => ({
        ...current,
        chats: current.chats.map((item) => item.id === chatId ? { ...item, title: value } : item),
        activeChat: current.activeChat.id === chatId ? { ...current.activeChat, title: value } : current.activeChat,
      }));
    };

    if (previousTitle === nextTitle) return;

    if (snapshot) applyTitle(nextTitle);
    try {
      const result = await renameChatMut.mutateAsync({ chatId, title: nextTitle });
      if (result.title !== nextTitle) applyTitle(result.title);

    } catch (error) {
      if (previousTitle) applyTitle(previousTitle);
      toast.error(error instanceof Error ? error.message : getT()("chat_rename_failed"));
    }
  }

  async function handleCreateChat(characterId?: string): Promise<void> {
    const resolvedId = characterId ?? getSnapshot()?.character.id;
    if (!resolvedId) return;
    try {
      const next = await createChatMut.mutateAsync({ characterId: resolvedId });
      writeSnapshot(next.activeChat.id, next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("chat_create_failed"));
    }
  }

  async function handleCreateCharacter(input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string }, avatarFile?: File | null): Promise<{ characterId: string; chatId: string } | null> {
    try {
      const result = await createCharacterMut.mutateAsync(input);

      const characterId = result.snapshot?.character?.id;

      // Upload avatar if provided
      if (avatarFile && characterId) {
        try {
          const asset = await uploadAsset(avatarFile);
          const updatedSnapshot = await updateCharacterAvatar(characterId, result.activeChatId, asset.assetId);
          writeSnapshot(result.activeChatId, updatedSnapshot);
        } catch (err) {
          console.warn("Failed to upload avatar during character creation:", err);
          writeSnapshot(result.activeChatId, result.snapshot);
        }
      } else {
        writeSnapshot(result.activeChatId, result.snapshot);
      }

      void qc.invalidateQueries({ queryKey: bootstrapKeys.all() });
      if (characterId) {
        return { characterId, chatId: result.activeChatId };
      }
      return null;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_create_character"));
      return null;
    }
  }

  async function handleFreeChat(): Promise<void> {
    try {
      const next = await createChatMut.mutateAsync({});
      writeSnapshot(next.activeChat.id, next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_create_free_chat"));
    }
  }

  async function handleExportCharacter(characterId: string): Promise<void> {
    try {
      const data = await exportCharacterMut.mutateAsync(characterId);
      const name = getSnapshot()?.character.name ?? "character";
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeName}.chara_card_v3.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_export_character"));
    }
  }

  async function handleExportChatJsonl(chatId: ChatId): Promise<void> {
    try {
      const text = await exportChatJsonlMut.mutateAsync(chatId);
      const chatItem = getSnapshot()?.chats.find((c) => c.id === chatId);
      const safeTitle = (chatItem?.title ?? "chat").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeTitle}.jsonl`, text, "application/x-ndjson");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("failed_to_export_chat"));
    }
  }

  async function handleExportPromptTrace(traceId: string): Promise<void> {
    try {
      const data = await exportPromptTraceMut.mutateAsync(traceId);
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
    handleSetPersonalLorebook,
    handleImportFiles,
    handleImportDragOver,
    handleImportDragLeave,
    handleImportDrop,
    handleImportInputChange,
    handleArchiveCharacter,
    handleUnarchiveCharacter,
    handleDeleteCharacter,
    handleDeleteChat,
    handleRenameChat,
    handleCreateChat,
    handleCreateCharacter,
    handleFreeChat,
    handleExportCharacter,
    handleExportChatJsonl,
    handleExportPromptTrace,
    isSavingCharacter,
  };
}
