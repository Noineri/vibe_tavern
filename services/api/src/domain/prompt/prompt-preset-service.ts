import type { PresetStore } from "@vibe-tavern/db";
import type { PromptPresetDto } from "@vibe-tavern/domain";
import {
  listPromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
  type PresetModuleDeps,
} from "../../session/session-runtime-presets.js";

export class PromptPresetService {
  constructor(
    private readonly presets: PresetStore,
    private readonly chats: { listByPreset(promptPresetId: string): Promise<{ id: string }[]>; setPromptPreset(chatId: string, promptPresetId: string): Promise<unknown> },
  ) {}

  private get deps(): PresetModuleDeps {
    return { presets: this.presets, chats: this.chats };
  }

  async listPromptPresets(): Promise<PromptPresetDto[]> {
    return listPromptPresets(this.deps);
  }

  async createPromptPreset(input: {
    name: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    prefill?: string;
    authorsNote?: string;
    authorsNoteDepth?: number;
    authorsNotePosition?: "in_prompt" | "in_chat" | "after_chat";
    authorsNoteRole?: "system" | "user" | "assistant";
    summary?: string;
    tools?: string;
    nsfw?: string;
    enhanceDefinitions?: string;
    customInjections?: unknown[];
    promptOrder?: unknown[];
    advancedMode?: boolean;
    scriptAiSystemPrompt?: string;
  }): Promise<PromptPresetDto> {
    return createPromptPreset(this.deps, input);
  }

  async updatePromptPreset(presetId: string, patch: {
    name?: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    prefill?: string;
    authorsNote?: string;
    authorsNoteDepth?: number;
    authorsNotePosition?: "in_prompt" | "in_chat" | "after_chat";
    authorsNoteRole?: "system" | "user" | "assistant";
    summary?: string;
    tools?: string;
    nsfw?: string;
    enhanceDefinitions?: string;
    customInjections?: unknown[];
    promptOrder?: unknown[];
    advancedMode?: boolean;
    scriptAiSystemPrompt?: string;
  }): Promise<PromptPresetDto> {
    return updatePromptPreset(this.deps, presetId, patch);
  }

  async deletePromptPreset(presetId: string): Promise<void> {
    return deletePromptPreset(this.deps, presetId);
  }
}
