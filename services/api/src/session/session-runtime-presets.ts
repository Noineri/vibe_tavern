import type { PresetStore } from "@vibe-tavern/db";
import type { PromptPresetId, PromptPresetDto } from "@vibe-tavern/domain";
import { validation, notFound, conflict, isDomainError } from "../errors.js";

type AuthorsNotePosition = "in_prompt" | "in_chat" | "after_chat";

function safeParseJson<T>(json: string, fallback: T): T {
  try { return JSON.parse(json); } catch { return fallback; }
}

function mapPresetToDto(p: { id: string; name: string; bindProviderPresetId: string | null; systemPrompt: string; postHistoryInstructions: string; assistantPrefix: string; authorsNote: string; authorsNoteDepth: number; authorsNotePosition: string; summaryPrompt: string; toolsPrompt: string; nsfwPrompt: string; enhanceDefinitionsPrompt: string; customInjectionsJson: string; promptOrderJson: string; advancedMode?: boolean | number | null; scriptAiSystemPrompt: string | null; createdAt: string; updatedAt: string; }): PromptPresetDto {
  return {
    id: p.id,
    name: p.name,
    bindModel: p.bindProviderPresetId ?? "",
    system: p.systemPrompt,
    jailbreak: p.postHistoryInstructions,
    prefill: p.assistantPrefix,
    authorsNote: p.authorsNote,
    authorsNoteDepth: p.authorsNoteDepth,
    authorsNotePosition: (p.authorsNotePosition as AuthorsNotePosition) ?? "in_chat",
    summary: p.summaryPrompt,
    tools: p.toolsPrompt,
    nsfw: p.nsfwPrompt ?? "",
    enhanceDefinitions: p.enhanceDefinitionsPrompt ?? "",
    customInjections: safeParseJson(p.customInjectionsJson, []),
    promptOrder: safeParseJson(p.promptOrderJson, []),
    advancedMode: Boolean(p.advancedMode),
    scriptAiSystemPrompt: p.scriptAiSystemPrompt ?? "",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export interface PresetModuleDeps {
  presets: PresetStore;
}

export async function listPromptPresets(deps: PresetModuleDeps): Promise<PromptPresetDto[]> {
  const presets = await deps.presets.listAll();
  return presets.map(mapPresetToDto);
}

export async function createPromptPreset(deps: PresetModuleDeps, input: {
  name: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  prefill?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  authorsNotePosition?: AuthorsNotePosition;
  summary?: string;
  tools?: string;
  nsfw?: string;
  enhanceDefinitions?: string;
  customInjections?: unknown[];
  promptOrder?: unknown[];
  advancedMode?: boolean;
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
    authorsNotePosition: input.authorsNotePosition ?? "in_chat",
    summaryPrompt: input.summary ?? "",
    toolsPrompt: input.tools ?? "",
    nsfwPrompt: input.nsfw ?? "",
    enhanceDefinitionsPrompt: input.enhanceDefinitions ?? "",
    customInjectionsJson: input.customInjections != null ? JSON.stringify(input.customInjections) : undefined,
    promptOrderJson: input.promptOrder != null ? JSON.stringify(input.promptOrder) : undefined,
    advancedMode: input.advancedMode ?? false,
    scriptAiSystemPrompt: input.scriptAiSystemPrompt ?? "",
  });
  return mapPresetToDto(created);
}

export async function updatePromptPreset(deps: PresetModuleDeps, presetId: string, patch: {
  name?: string;
  bindModel?: string;
  system?: string;
  jailbreak?: string;
  prefill?: string;
  authorsNote?: string;
  authorsNoteDepth?: number;
  authorsNotePosition?: AuthorsNotePosition;
  summary?: string;
  tools?: string;
  nsfw?: string;
  enhanceDefinitions?: string;
  customInjections?: unknown[];
  promptOrder?: unknown[];
  advancedMode?: boolean;
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
      authorsNotePosition: patch.authorsNotePosition,
      summaryPrompt: patch.summary,
      toolsPrompt: patch.tools,
      nsfwPrompt: patch.nsfw,
      enhanceDefinitionsPrompt: patch.enhanceDefinitions,
      customInjectionsJson: patch.customInjections != null ? JSON.stringify(patch.customInjections) : undefined,
      promptOrderJson: patch.promptOrder != null ? JSON.stringify(patch.promptOrder) : undefined,
      advancedMode: patch.advancedMode,
      scriptAiSystemPrompt: patch.scriptAiSystemPrompt,
    });
    return mapPresetToDto(updated);
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
