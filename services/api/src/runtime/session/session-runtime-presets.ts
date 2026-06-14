import type { PresetStore } from "@vibe-tavern/db";
import type { CustomInjection, PromptOrderEntry, PromptPresetId, PromptPresetDto } from "@vibe-tavern/domain";
import { validation, notFound, conflict, isDomainError } from "../../shared/errors.js";

type AuthorsNotePosition = "in_prompt" | "in_chat" | "after_chat";
type AuthorsNoteRole = "system" | "user" | "assistant";

function mapPresetToDto(p: { id: string; name: string; bindProviderPresetId: string | null; systemPrompt: string; postHistoryInstructions: string; assistantPrefix: string; authorsNote: string; authorsNoteDepth: number; authorsNotePosition: string; authorsNoteRole: string; summaryPrompt: string; toolsPrompt: string; nsfwPrompt: string; enhanceDefinitionsPrompt: string; customInjections: CustomInjection[]; promptOrder: PromptOrderEntry[]; advancedMode?: boolean | number | null; scriptAiSystemPrompt: string | null; aiAssistantPrompts?: string | null; createdAt: string; updatedAt: string; }): PromptPresetDto {
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
    authorsNoteRole: (p.authorsNoteRole as AuthorsNoteRole) ?? "system",
    summary: p.summaryPrompt,
    tools: p.toolsPrompt,
    nsfw: p.nsfwPrompt ?? "",
    enhanceDefinitions: p.enhanceDefinitionsPrompt ?? "",
    customInjections: p.customInjections,
    promptOrder: p.promptOrder,
    advancedMode: Boolean(p.advancedMode),
    scriptAiSystemPrompt: p.scriptAiSystemPrompt ?? "",
    aiAssistantPrompts: p.aiAssistantPrompts ?? "{}",
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export interface PresetModuleDeps {
  presets: PresetStore;
  chats: { listByPreset(promptPresetId: string): Promise<{ id: string }[]>; setPromptPreset(chatId: string, promptPresetId: string): Promise<unknown> };
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
  authorsNoteRole?: AuthorsNoteRole;
  summary?: string;
  tools?: string;
  nsfw?: string;
  enhanceDefinitions?: string;
  customInjections?: CustomInjection[];
  promptOrder?: PromptOrderEntry[];
  advancedMode?: boolean;
  scriptAiSystemPrompt?: string;
  aiAssistantPrompts?: string;
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
    authorsNoteRole: input.authorsNoteRole ?? "system",
    summaryPrompt: input.summary ?? "",
    toolsPrompt: input.tools ?? "",
    nsfwPrompt: input.nsfw ?? "",
    enhanceDefinitionsPrompt: input.enhanceDefinitions ?? "",
    customInjections: input.customInjections,
    promptOrder: input.promptOrder,
    advancedMode: input.advancedMode ?? false,
    scriptAiSystemPrompt: input.scriptAiSystemPrompt ?? "",
    aiAssistantPrompts: input.aiAssistantPrompts ?? "{}",
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
  authorsNoteRole?: AuthorsNoteRole;
  summary?: string;
  tools?: string;
  nsfw?: string;
  enhanceDefinitions?: string;
  customInjections?: CustomInjection[];
  promptOrder?: PromptOrderEntry[];
  advancedMode?: boolean;
  scriptAiSystemPrompt?: string;
  aiAssistantPrompts?: string;
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
      authorsNoteRole: patch.authorsNoteRole,
      summaryPrompt: patch.summary,
      toolsPrompt: patch.tools,
      nsfwPrompt: patch.nsfw,
      enhanceDefinitionsPrompt: patch.enhanceDefinitions,
      customInjections: patch.customInjections,
      promptOrder: patch.promptOrder,
      advancedMode: patch.advancedMode,
      scriptAiSystemPrompt: patch.scriptAiSystemPrompt,
      aiAssistantPrompts: patch.aiAssistantPrompts,
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
  // Only block if this is the sole global preset (no bindProviderPresetId)
  // and there's no other global preset to fall back to
  const presets = await deps.presets.listAll();
  const globalPresets = presets.filter(p => !p.bindProviderPresetId);
  const isLastGlobal = globalPresets.length === 1 && globalPresets[0].id === presetId;
  if (isLastGlobal) {
    throw conflict("Cannot delete the last default preset.");
  }

  // Reassign chats that reference this preset to the default preset
  const chats = await deps.chats.listByPreset?.(presetId);
  if (chats && chats.length > 0) {
    const fallback = presets.find((p) => p.id !== presetId && !p.bindProviderPresetId) ?? presets.find((p) => p.id !== presetId);
    if (fallback) {
      for (const chat of chats) {
        await deps.chats.setPromptPreset(chat.id, fallback.id);
      }
    }
  }

  try {
    await deps.presets.delete(presetId as PromptPresetId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      throw notFound("PromptPreset", message);
    }
    throw error;
  }
}
