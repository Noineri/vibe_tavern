import type { PromptPresetDto } from "@rp-platform/domain";
import {
  createPromptPreset,
  deletePromptPreset,
  listPromptPresets,
  setChatPromptPreset,
  updatePromptPreset,
} from "../app-client.js";
import { useChatStore, useCharacterStore } from "../stores/index.js";

export interface PresetControllerDeps {
  loadPromptPresets: () => Promise<PromptPresetDto[]>;
}

export interface PresetControllerActions {
  loadPromptPresets: () => Promise<PromptPresetDto[]>;
  handleSetActivePromptPresetId: (presetId: string | null) => Promise<void>;
  handleCreatePromptPreset: (input: { name: string; bindModel?: string; system?: string; jailbreak?: string; prefill?: string; authorsNote?: string; authorsNoteDepth?: number; summary?: string; tools?: string }) => Promise<{ id: string } | null>;
  handleUpdatePromptPreset: (presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>) => Promise<boolean>;
  handleDeletePromptPreset: (presetId: string) => Promise<boolean>;
}

async function loadPresetsFromServer(): Promise<PromptPresetDto[]> {
  const list = await listPromptPresets();
  useCharacterStore.getState().setPromptPresets(list);

  const currentId = useCharacterStore.getState().activePromptPresetId;
  if (list.length > 0 && !list.find((p) => p.id === currentId)) {
    useCharacterStore.getState().setActivePromptPresetId(list[0].id);
  } else if (list.length === 0) {
    useCharacterStore.getState().setActivePromptPresetId(null);
  }

  return list;
}

export function usePresetController(): PresetControllerActions {

  async function handleSetActivePromptPresetId(presetId: string | null): Promise<void> {
    useCharacterStore.getState().setActivePromptPresetId(presetId);
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId || !presetId) return;
    try {
      const nextSnapshot = await setChatPromptPreset(chatId, presetId);
      useChatStore.getState().setSnapshotForChat(chatId, nextSnapshot);
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : "Failed to set prompt preset.");
    }
  }

  async function handleCreatePromptPreset(input: { name: string; bindModel?: string; system?: string; jailbreak?: string; prefill?: string; authorsNote?: string; authorsNoteDepth?: number; summary?: string; tools?: string }): Promise<{ id: string } | null> {
    try {
      const created = await createPromptPreset(input);
      await loadPresetsFromServer();
      await handleSetActivePromptPresetId(created.id);
      return { id: created.id };
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : "Failed to create preset.");
      return null;
    }
  }

  async function handleUpdatePromptPreset(presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>): Promise<boolean> {
    try {
      const updated = await updatePromptPreset(presetId, patch);
      const current = useCharacterStore.getState().promptPresets;
      useCharacterStore.getState().setPromptPresets(current.map((p) => p.id === presetId ? updated : p));
      return true;
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : "Failed to save preset.");
      return false;
    }
  }

  async function handleDeletePromptPreset(presetId: string): Promise<boolean> {
    try {
      await deletePromptPreset(presetId);
      await loadPresetsFromServer();
      return true;
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : "Failed to delete preset.");
      return false;
    }
  }

  return {
    loadPromptPresets: loadPresetsFromServer,
    handleSetActivePromptPresetId,
    handleCreatePromptPreset,
    handleUpdatePromptPreset,
    handleDeletePromptPreset,
  };
}
