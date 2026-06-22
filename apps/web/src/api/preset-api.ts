import type { PromptPresetDto } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

export async function listPromptPresets(): Promise<PromptPresetDto[]> {
  const response = await client.api["prompt-presets"].$get();
  return unwrapRpc<PromptPresetDto[]>(response);
}

export async function createPromptPreset(input: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">> & { name: string }): Promise<PromptPresetDto> {
  const response = await client.api["prompt-presets"].$post({ json: input });
  return unwrapRpc<PromptPresetDto>(response);
}

export async function updatePromptPreset(
  presetId: string,
  patch: Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">>,
): Promise<PromptPresetDto> {
  const response = await client.api["prompt-presets"][":presetId"].$patch({ param: { presetId }, json: patch });
  return unwrapRpc<PromptPresetDto>(response);
}

export async function deletePromptPreset(presetId: string): Promise<void> {
  const response = await client.api["prompt-presets"][":presetId"].$delete({ param: { presetId } });
  if (!response.ok) throw await unwrapError(response);
}
