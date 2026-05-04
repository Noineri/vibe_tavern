import type { PresetStore } from "@rp-platform/db";
import type { PromptPresetId, PromptPresetDto } from "@rp-platform/domain";
import { validation, notFound, conflict, isDomainError } from "./errors.js";

export interface PresetModuleDeps {
  presets: PresetStore;
}

export async function listPromptPresets(deps: PresetModuleDeps): Promise<PromptPresetDto[]> {
  const presets = await deps.presets.listAll();
  return presets.map((p) => ({
    id: p.id,
    name: p.name,
    bindModel: p.bindProviderPresetId ?? "",
    system: p.systemPrompt,
    jailbreak: p.postHistoryInstructions,
    summary: p.summaryPrompt,
    tools: p.toolsPrompt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export async function createPromptPreset(deps: PresetModuleDeps, input: {
  name: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  summary?: string;
  tools?: string;
}): Promise<PromptPresetDto> {
  const trimmed = (input.name ?? "").trim();
  if (!trimmed) {
    throw validation("Preset name is required.");
  }
  const created = await deps.presets.create({
    name: trimmed,
    bindProviderPresetId: input.bindModel ?? "",
    systemPrompt: input.system ?? "",
    postHistoryInstructions: input.jailbreak ?? "",
    summaryPrompt: input.summary ?? "",
    toolsPrompt: input.tools ?? "",
  });
  return {
    id: created.id,
    name: created.name,
    bindModel: created.bindProviderPresetId ?? "",
    system: created.systemPrompt,
    jailbreak: created.postHistoryInstructions,
    summary: created.summaryPrompt,
    tools: created.toolsPrompt,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

export async function updatePromptPreset(deps: PresetModuleDeps, presetId: string, patch: {
  name?: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  summary?: string;
  tools?: string;
}): Promise<PromptPresetDto> {
  try {
    const updated = await deps.presets.update(presetId as PromptPresetId, {
      name: patch.name,
      bindProviderPresetId: patch.bindModel,
      systemPrompt: patch.system,
      postHistoryInstructions: patch.jailbreak,
      summaryPrompt: patch.summary,
      toolsPrompt: patch.tools,
    });
    return {
      id: updated.id,
      name: updated.name,
      bindModel: updated.bindProviderPresetId ?? "",
      system: updated.systemPrompt,
      jailbreak: updated.postHistoryInstructions,
      summary: updated.summaryPrompt,
      tools: updated.toolsPrompt,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  } catch (error) {
    if (isDomainError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      throw notFound("PromptPreset", message);
    }
    throw error;
  }
}

export async function deletePromptPreset(deps: PresetModuleDeps, presetId: string): Promise<void> {
  try {
    await deps.presets.delete(presetId as PromptPresetId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/used by a chat/i.test(message)) {
      throw conflict(message);
    }
    if (/not found/i.test(message)) {
      throw notFound("PromptPreset", message);
    }
    throw error;
  }
}
