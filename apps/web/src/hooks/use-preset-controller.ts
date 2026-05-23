import { toast } from "sonner";
import type { PromptPresetDto } from "@rp-platform/domain";
import { getT } from "../i18n/context.js";
import {
  loadPromptPresetsAction,
  createPromptPresetAction,
  updatePromptPresetAction,
  deletePromptPresetAction,
  setChatPromptPresetAction,
} from "../stores/api-actions/preset-actions.js";
import { useChatStore } from "../stores/index.js";


export interface PresetControllerActions {
  loadPromptPresets: () => Promise<PromptPresetDto[]>;
  handleSetActivePromptPresetId: (presetId: string | null) => Promise<void>;
  handleCreatePromptPreset: (input: { name: string; bindModel?: string; system?: string; jailbreak?: string; prefill?: string; authorsNote?: string; authorsNoteDepth?: number; summary?: string; tools?: string }) => Promise<{ id: string } | null>;
  handleUpdatePromptPreset: (presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>) => Promise<boolean>;
  handleDeletePromptPreset: (presetId: string) => Promise<boolean>;
}

export function usePresetController(): PresetControllerActions {

  async function loadPresetsFromServer(): Promise<PromptPresetDto[]> {
    return await loadPromptPresetsAction();
  }

  async function handleSetActivePromptPresetId(presetId: string | null): Promise<void> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId || !presetId) return;
    try {
      await setChatPromptPresetAction(chatId, presetId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("preset_set_failed"));
    }
  }

  async function handleCreatePromptPreset(input: { name: string; bindModel?: string; system?: string; jailbreak?: string; prefill?: string; authorsNote?: string; authorsNoteDepth?: number; summary?: string; tools?: string }): Promise<{ id: string } | null> {
    try {
      const created = await createPromptPresetAction(input);
      await handleSetActivePromptPresetId(created.id);
      return { id: created.id };
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("preset_create_failed"));
      return null;
    }
  }

  async function handleUpdatePromptPreset(presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>): Promise<boolean> {
    try {
      await updatePromptPresetAction(presetId, patch);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("preset_save_failed"));
      return false;
    }
  }

  async function handleDeletePromptPreset(presetId: string): Promise<boolean> {
    try {
      await deletePromptPresetAction(presetId);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("preset_delete_failed"));
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
