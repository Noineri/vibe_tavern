import type { ChangeEvent, DragEvent } from "react";
import type { ChatId } from "@rp-platform/domain";
import {
  archiveCharacter,
  cloneChat,
  createCharacter,
  createChat,
  createPersona,
  deleteCharacter,
  deleteChat,
  deletePersona,
  exportCharacter,
  exportChatJsonl,
  exportPromptTrace,
  renameChat,
  setChatPersona,
  setPersonalLorebookEnabled,
  unarchiveCharacter,
  updateCharacter,
  updatePersona,
  type AppSnapshot,
  type ImportJsonResponse,
  type PersonaRecord,
} from "../app-client.js";
import type { AppMode } from "../components/app-shell-types.js";
import type { BuildCharacterDraft } from "../components/BuildMode.js";
import type { CharacterImportOptions } from "./use-character-import.js";

export interface CharacterControllerDeps {
  // read state (getter functions — Zustand-compatible)
  getActiveChatId: () => ChatId | null;
  getSnapshot: () => AppSnapshot | null;
  // write / mutate
  setSnapshot: (chatId: ChatId, next: AppSnapshot) => void;
  setChatNotice: (notice: string) => void;
  setIsFirstRun: (first: boolean) => void;
  setMode: (mode: AppMode) => void;
  setIsImportDragActive: (active: boolean) => void;
  setImportNotice: (notice: string) => void;
  setIsSavingCharacter: (saving: boolean) => void;
  setCharacterSaveNotice: (notice: string) => void;
  setPersonas: (updater: (personas: PersonaRecord[]) => PersonaRecord[]) => void;
  // action callbacks
  loadBootstrap: () => Promise<void>;
  loadPersonas: () => Promise<void>;
  importFile: (file: File, options?: CharacterImportOptions) => Promise<ImportJsonResponse>;
}

export interface CharacterControllerActions {
  handleSaveCharacter: (draftInput: BuildCharacterDraft) => Promise<void>;
  handleSavePersona: (personaId: string, draftInput: { name: string; description: string; pronouns?: string | null }) => Promise<void>;
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
  handleCreateCharacter: (input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string }) => Promise<void>;
  handleFreeChat: () => Promise<void>;
  handleCloneChat: (chatId: ChatId) => Promise<void>;
  handleExportCharacter: (characterId: string) => Promise<void>;
  handleExportChatJsonl: (chatId: ChatId) => Promise<void>;
  handleExportPromptTrace: (traceId: string) => Promise<void>;
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
    setSnapshot,
    setChatNotice,
    setIsFirstRun,
    setMode,
    setIsImportDragActive,
    setImportNotice,
    setIsSavingCharacter,
    setCharacterSaveNotice,
    setPersonas,
    loadBootstrap,
    loadPersonas,
    importFile,
  } = deps;

  async function handleSaveCharacter(draftInput: BuildCharacterDraft): Promise<void> {
    const activeChatId = getActiveChatId();
    const snapshot = getSnapshot();
    if (!activeChatId || !snapshot) return;

    setIsSavingCharacter(true);
    setCharacterSaveNotice("");
    try {
      const nextSnapshot = await updateCharacter(snapshot.character.id, {
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
        characterBook: draftInput.characterBook,
        depthPrompt: draftInput.depthPrompt,
        depthPromptDepth: draftInput.depthPromptDepth,
        depthPromptRole: draftInput.depthPromptRole,
        extensions: draftInput.extensions,
        tags: draftInput.tags,
      });
      setSnapshot(activeChatId, nextSnapshot);
      setCharacterSaveNotice("Character card saved.");
    } catch (error) {
      setCharacterSaveNotice(error instanceof Error ? error.message : "Could not save character.");
    } finally {
      setIsSavingCharacter(false);
    }
  }

  async function handleSavePersona(personaId: string, draftInput: { name: string; description: string; pronouns?: string | null }): Promise<void> {
    const activeChatId = getActiveChatId();
    if (!activeChatId) return;

    setIsSavingCharacter(true);
    setCharacterSaveNotice("");
    try {
      const nextSnapshot = await updatePersona(personaId, {
        chatId: activeChatId,
        name: draftInput.name,
        description: draftInput.description,
        pronouns: draftInput.pronouns,
      });
      const updatedPersona = nextSnapshot.persona?.id === personaId
        ? nextSnapshot.persona
        : { id: personaId, name: draftInput.name.trim(), description: draftInput.description, pronouns: draftInput.pronouns ?? null, avatarAssetId: null };
      setPersonas((current) => current.map((persona) => persona.id === personaId ? updatedPersona : persona));
      setSnapshot(activeChatId, nextSnapshot);
      await loadPersonas();
      setCharacterSaveNotice("Persona saved.");
    } catch (error) {
      setCharacterSaveNotice(error instanceof Error ? error.message : "Could not save persona.");
    } finally {
      setIsSavingCharacter(false);
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
      setSnapshot(activeChatId, await setChatPersona(activeChatId, personaId));
    } catch (err) {
      setChatNotice(err instanceof Error ? err.message : "Failed to switch persona.");
    }
  }

  async function handleCreatePersona(input: { name: string; description: string; pronouns?: string | null }): Promise<{ id: string } | null> {
    try {
      const created = await createPersona({
        name: input.name.trim(),
        description: input.description.trim(),
        pronouns: input.pronouns,
      });
      setPersonas((current) => current.some((persona) => persona.id === created.id) ? current : [...current, created]);
      await loadPersonas();
      return { id: created.id };
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create persona.");
      return null;
    }
  }

  async function handleDeletePersona(personaId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await deletePersona(personaId);
      await loadPersonas();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Failed to delete persona." };
    }
  }

  async function handleSetPersonalLorebook(personaId: string, enabled: boolean): Promise<{ enabled: boolean; lorebookId: string | null } | null> {
    try {
      return await setPersonalLorebookEnabled(personaId, enabled);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to update personal lorebook.");
      return null;
    }
  }

  async function handleImportFiles(files: FileList | File[]): Promise<void> {
    const firstFile = Array.from(files)[0];
    if (!firstFile) return;

    setImportNotice("");
    try {
      const imported = await importFile(firstFile, { chatId: getActiveChatId() ?? undefined });

      setIsFirstRun(false);
      setSnapshot(imported.activeChatId, imported.snapshot);

      if (imported.imported.kind === "character") {
        setMode("play");
        setImportNotice(
          `Imported character: ${imported.imported.name}${formatImportWarnings(imported.imported.warningCount)}`,
        );
      } else {
        setImportNotice(
          `Attached lorebook: ${imported.imported.name} -> ${imported.imported.attachedToCharacterName ?? "current character"}${formatImportWarnings(imported.imported.warningCount)}`,
        );
      }
    } catch (error) {
      setImportNotice(error instanceof Error ? error.message : "Import failed.");
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
    await archiveCharacter(characterId);
    await loadBootstrap();
  }

  async function handleUnarchiveCharacter(characterId: string): Promise<void> {
    await unarchiveCharacter(characterId);
    await loadBootstrap();
  }

  async function handleDeleteCharacter(characterId: string): Promise<void> {
    await deleteCharacter(characterId);
    await loadBootstrap();
  }

  async function handleDeleteChat(chatId: ChatId): Promise<void> {
    await deleteChat(chatId);
    await loadBootstrap();
  }

  async function handleRenameChat(chatId: ChatId, title: string): Promise<void> {
    await renameChat(chatId, title);
    await loadBootstrap();
  }

  async function handleCreateChat(characterId?: string): Promise<void> {
    const resolvedId = characterId ?? getSnapshot()?.character.id;
    if (!resolvedId) return;
    try {
      const next = await createChat(resolvedId);
      setSnapshot(next.activeChat.id, next);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create chat.");
    }
  }

  async function handleCreateCharacter(input: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string }): Promise<void> {
    try {
      const result = await createCharacter(input);
      setIsFirstRun(false);
      setSnapshot(result.activeChatId, result.snapshot);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create character.");
    }
  }

  async function handleFreeChat(): Promise<void> {
    try {
      const next = await createChat();
      setIsFirstRun(false);
      setSnapshot(next.activeChat.id, next);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to create free chat.");
    }
  }

  async function handleCloneChat(chatId: ChatId): Promise<void> {
    try {
      const next = await cloneChat(chatId);
      setSnapshot(next.activeChat.id, next);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to clone chat.");
    }
  }

  async function handleExportCharacter(characterId: string): Promise<void> {
    try {
      const data = await exportCharacter(characterId);
      const name = getSnapshot()?.character.name ?? "character";
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeName}.chara_card_v3.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to export character.");
    }
  }

  async function handleExportChatJsonl(chatId: ChatId): Promise<void> {
    try {
      const text = await exportChatJsonl(chatId);
      const chatItem = getSnapshot()?.chats.find((c) => c.id === chatId);
      const safeTitle = (chatItem?.title ?? "chat").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadTextFile(`${safeTitle}.jsonl`, text, "application/x-ndjson");
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to export chat.");
    }
  }

  async function handleExportPromptTrace(traceId: string): Promise<void> {
    try {
      const data = await exportPromptTrace(traceId);
      downloadTextFile(`prompt-trace-${traceId}.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "Failed to export prompt trace.");
    }
  }

  return {
    handleSaveCharacter,
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
    handleCloneChat,
    handleExportCharacter,
    handleExportChatJsonl,
    handleExportPromptTrace,
  };
}
