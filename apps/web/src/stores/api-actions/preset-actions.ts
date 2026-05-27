import {
  createPromptPreset,
  deletePromptPreset,
  listPromptPresets,
  setChatPromptPreset,
  updatePromptPreset,
} from "../../app-client.js";
import type { ChatId, PromptPresetDto } from "@vibe-tavern/domain";
import { useBootstrapStore } from "./bootstrap-actions.js";
import { useChatDataStore } from "../chat-data-store.js";

async function refreshPresetsInBootstrap(): Promise<void> {
  const list = await listPromptPresets();
  const current = useBootstrapStore.getState().data;
  if (current) {
    useBootstrapStore.setState({ data: { ...current, promptPresets: list } });
  }
}

export async function loadPromptPresetsAction(): Promise<PromptPresetDto[]> {
  const list = await listPromptPresets();
  const current = useBootstrapStore.getState().data;
  if (current) {
    useBootstrapStore.setState({ data: { ...current, promptPresets: list } });
  }
  return list;
}

export async function createPromptPresetAction(
  input: Parameters<typeof createPromptPreset>[0],
): Promise<{ id: string }> {
  const created = await createPromptPreset(input);
  await refreshPresetsInBootstrap();
  return { id: created.id };
}

export async function updatePromptPresetAction(
  presetId: string,
  patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>,
): Promise<void> {
  await updatePromptPreset(presetId, patch);
  await refreshPresetsInBootstrap();
}

export async function deletePromptPresetAction(presetId: string): Promise<void> {
  await deletePromptPreset(presetId);
  await refreshPresetsInBootstrap();
}

export async function setChatPromptPresetAction(chatId: ChatId, presetId: string): Promise<void> {
  const snapshot = await setChatPromptPreset(chatId, presetId);
  useChatDataStore.getState().setSnapshot(snapshot);
}
