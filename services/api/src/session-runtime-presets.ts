import type { PresetStore } from "@rp-platform/db";
import type { PromptPresetId, PromptPresetDto } from "@rp-platform/domain";
import { validation, notFound, conflict, isDomainError } from "./errors.js";

function safeParseJson<T>(json: string, fallback: T): T {
  try { return JSON.parse(json); } catch { return fallback; }
}

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
    prefill: p.assistantPrefix,
    authorsNote: p.authorsNote,
    authorsNoteDepth: p.authorsNoteDepth,
    summary: p.summaryPrompt,
    tools: p.toolsPrompt,
    customInjections: safeParseJson(p.customInjectionsJson, []),
    scriptAiSystemPrompt: p.scriptAiSystemPrompt ?? "",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export async function createPromptPreset(deps: PresetModuleDeps, input: {
  name: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  prefill?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  summary?: string;
  tools?: string;
  customInjections?: unknown[];
  scriptAiSystemPrompt?: string;
}): Promise<PromptPresetDto> {
  const trimmed = (input.name ?? "").trim();
  if (!trimmed) {
    throw validation("Preset name is required.");
  }
  const created = await deps.presets.create({
    name: trimmed,
    bindProviderPresetId: normalizeBindModel(input.bindModel),
    systemPrompt: input.system ?? "",
    postHistoryInstructions: input.jailbreak ?? "",
    assistantPrefix: input.prefill ?? "",
    authorsNote: input.authorsNote ?? "",
    authorsNoteDepth: input.authorsNoteDepth ?? 4,
    summaryPrompt: input.summary ?? "",
    toolsPrompt: input.tools ?? "",
    customInjectionsJson: input.customInjections != null ? JSON.stringify(input.customInjections) : undefined,
    scriptAiSystemPrompt: input.scriptAiSystemPrompt ?? "",
  });
  return {
    id: created.id,
    name: created.name,
    bindModel: created.bindProviderPresetId ?? "",
    system: created.systemPrompt,
    jailbreak: created.postHistoryInstructions,
    prefill: created.assistantPrefix,
    authorsNote: created.authorsNote,
    authorsNoteDepth: created.authorsNoteDepth,
    summary: created.summaryPrompt,
    tools: created.toolsPrompt,
    customInjections: safeParseJson(created.customInjectionsJson, []),
    scriptAiSystemPrompt: created.scriptAiSystemPrompt ?? "",
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };
}

export async function updatePromptPreset(deps: PresetModuleDeps, presetId: string, patch: {
  name?: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  prefill?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  summary?: string;
  tools?: string;
  customInjections?: unknown[];
  scriptAiSystemPrompt?: string;
}): Promise<PromptPresetDto> {
  try {
    const updated = await deps.presets.update(presetId as PromptPresetId, {
      name: patch.name,
      bindProviderPresetId: patch.bindModel === undefined ? undefined : normalizeBindModel(patch.bindModel),
      systemPrompt: patch.system,
      postHistoryInstructions: patch.jailbreak,
      assistantPrefix: patch.prefill,
      authorsNote: patch.authorsNote,
      authorsNoteDepth: patch.authorsNoteDepth,
      summaryPrompt: patch.summary,
      toolsPrompt: patch.tools,
      customInjectionsJson: patch.customInjections != null ? JSON.stringify(patch.customInjections) : undefined,
      scriptAiSystemPrompt: patch.scriptAiSystemPrompt,
    });
    return {
      id: updated.id,
      name: updated.name,
      bindModel: updated.bindProviderPresetId ?? "",
      system: updated.systemPrompt,
      jailbreak: updated.postHistoryInstructions,
      prefill: updated.assistantPrefix,
      authorsNote: updated.authorsNote,
      authorsNoteDepth: updated.authorsNoteDepth,
      summary: updated.summaryPrompt,
      tools: updated.toolsPrompt,
      customInjections: safeParseJson(updated.customInjectionsJson, []),
      scriptAiSystemPrompt: updated.scriptAiSystemPrompt ?? "",
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

function normalizeBindModel(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
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
