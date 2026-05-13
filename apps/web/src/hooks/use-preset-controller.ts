import { toast } from "sonner";
import type { PromptPresetDto } from "@rp-platform/domain";
import { getT } from "../i18n/context.js";
import {
  useCreatePromptPresetMutation,
  useDeletePromptPresetMutation,
  useLoadPromptPresetsMutation,
  useSetChatPromptPresetMutation,
  useUpdatePromptPresetMutation,
} from "../queries/index.js";
import { useChatStore } from "../stores/index.js";


export interface PresetControllerActions {
  loadPromptPresets: () => Promise<PromptPresetDto[]>;
  handleSetActivePromptPresetId: (presetId: string | null) => Promise<void>;
  handleCreatePromptPreset: (input: { name: string; bindModel?: string; system?: string; jailbreak?: string; prefill?: string; authorsNote?: string; authorsNoteDepth?: number; summary?: string; tools?: string }) => Promise<{ id: string } | null>;
  handleUpdatePromptPreset: (presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>) => Promise<boolean>;
  handleDeletePromptPreset: (presetId: string) => Promise<boolean>;
}

export function usePresetController(): PresetControllerActions {
  const loadPromptPresetsMut = useLoadPromptPresetsMutation();
  const createPromptPresetMut = useCreatePromptPresetMutation();
  const updatePromptPresetMut = useUpdatePromptPresetMutation();
  const deletePromptPresetMut = useDeletePromptPresetMutation();
  const setChatPromptPresetMut = useSetChatPromptPresetMutation();

  async function loadPresetsFromServer(): Promise<PromptPresetDto[]> {
    return await loadPromptPresetsMut.mutateAsync();
  }

  async function handleSetActivePromptPresetId(presetId: string | null): Promise<void> {
    const chatId = useChatStore.getState().activeChatId;
    if (!chatId || !presetId) return;
    try {
      await setChatPromptPresetMut.mutateAsync({ chatId, presetId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("preset_set_failed"));
    }
  }

  async function handleCreatePromptPreset(input: { name: string; bindModel?: string; system?: string; jailbreak?: string; prefill?: string; authorsNote?: string; authorsNoteDepth?: number; summary?: string; tools?: string }): Promise<{ id: string } | null> {
    try {
      const created = await createPromptPresetMut.mutateAsync(input);
      await handleSetActivePromptPresetId(created.id);
      return { id: created.id };
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("preset_create_failed"));
      return null;
    }
  }

  async function handleUpdatePromptPreset(presetId: string, patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>): Promise<boolean> {
    try {
      await updatePromptPresetMut.mutateAsync({ presetId, patch });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : getT()("preset_save_failed"));
      return false;
    }
  }

  async function handleDeletePromptPreset(presetId: string): Promise<boolean> {
    try {
      await deletePromptPresetMut.mutateAsync(presetId);
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
