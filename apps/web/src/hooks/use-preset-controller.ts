import type { PromptPresetDto } from "@rp-platform/domain";
import { getT } from "../i18n/context.js";
import {
  createPromptPreset,
  deletePromptPreset,
  listPromptPresets,
  setChatPromptPreset,
  updatePromptPreset,
} from "../app-client.js";
import { useQueryClient } from "@tanstack/react-query";
import { useChatStore } from "../stores/index.js";
import { bootstrapKeys, chatKeys } from "../queries/query-keys.js";

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

export function usePresetController(): PresetControllerActions {
  const qc = useQueryClient();

  function writePromptPresetsToBootstrap(list: PromptPresetDto[]): void {
    qc.setQueryData(bootstrapKeys.snapshot(), (current: unknown) => current ? { ...current as object, promptPresets: list } : current);
  }

  async function loadPresetsFromServer(): Promise<PromptPresetDto[]> {
    const list = await listPromptPresets();
    writePromptPresetsToBootstrap(list);
    return list;
  }

  async function handleSetActivePromptPresetId(presetId: string | null): Promise<void> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId || !presetId) return;
    try {
      const nextSnapshot = await setChatPromptPreset(chatId, presetId);
      qc.setQueryData(chatKeys.snapshot(chatId), nextSnapshot);
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : getT()("preset_set_failed"));
    }
  }

  async function handleCreatePromptPreset(input: { name: string; bindModel?: string; system?: string; jailbreak?: string; prefill?: string; authorsNote?: string; authorsNoteDepth?: number; summary?: string; tools?: string }): Promise<{ id: string } | null> {
    try {
      const created = await createPromptPreset(input);
      await loadPresetsFromServer();
      await handleSetActivePromptPresetId(created.id);
      return { id: created.id };
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : getT()("preset_create_failed"));
      return null;
    }
  }

  async function handleUpdatePromptPreset(presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>): Promise<boolean> {
    try {
      await updatePromptPreset(presetId, patch);
      await loadPresetsFromServer();
      return true;
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : getT()("preset_save_failed"));
      return false;
    }
  }

  async function handleDeletePromptPreset(presetId: string): Promise<boolean> {
    try {
      await deletePromptPreset(presetId);
      await loadPresetsFromServer();
      return true;
    } catch (error) {
      useChatStore.getState().setChatNotice(error instanceof Error ? error.message : getT()("preset_delete_failed"));
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
