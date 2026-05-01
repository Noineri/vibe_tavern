import type { ChatSessionStore } from "@rp-platform/db";
import type { PromptPresetId, PromptPresetDto } from "@rp-platform/domain";
import { validation, notFound, conflict, isDomainError } from "./errors.js";

export interface PresetModuleDeps {
  store: ChatSessionStore;
}

export function listPromptPresets(deps: PresetModuleDeps): PromptPresetDto[] {
  return deps.store.listPromptPresets().map((p) => ({
    id: p.id,
    name: p.name,
    bindModel: p.bindModel,
    system: p.system,
    jailbreak: p.jailbreak,
    summary: p.summary,
    tools: p.tools,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export function createPromptPreset(deps: PresetModuleDeps, input: {
  name: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  summary?: string;
  tools?: string;
}): PromptPresetDto {
  const trimmed = (input.name ?? "").trim();
  if (!trimmed) {
    throw validation("Preset name is required.");
  }
  const created = deps.store.createPromptPreset({
    name: trimmed,
    bindModel: input.bindModel ?? "",
    system: input.system ?? "",
    jailbreak: input.jailbreak ?? "",
    summary: input.summary ?? "",
    tools: input.tools ?? "",
  });
  return { ...created };
}

export function updatePromptPreset(deps: PresetModuleDeps, presetId: string, patch: {
  name?: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  summary?: string;
  tools?: string;
}): PromptPresetDto {
  try {
    const next = deps.store.updatePromptPreset(
      presetId as PromptPresetId,
      patch,
    );
    return { ...next };
  } catch (error) {
    if (isDomainError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      throw notFound("PromptPreset", message);
    }
    throw error;
  }
}

export function deletePromptPreset(deps: PresetModuleDeps, presetId: string): void {
  try {
    deps.store.deletePromptPreset(presetId as PromptPresetId);
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
