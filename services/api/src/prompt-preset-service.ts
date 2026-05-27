import type { PresetStore } from "@vibe-tavern/db";
import type { PromptPresetDto } from "@vibe-tavern/domain";
import {
  listPromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
  type PresetModuleDeps,
} from "./session-runtime-presets.js";

export class PromptPresetService {
  constructor(private readonly presets: PresetStore) {}

  private get deps(): PresetModuleDeps {
    return { presets: this.presets };
  }

  async listPromptPresets(): Promise<PromptPresetDto[]> {
    return listPromptPresets(this.deps);
  }

  async createPromptPreset(input: {
    name: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    summary?: string;
    tools?: string;
  }): Promise<PromptPresetDto> {
    return createPromptPreset(this.deps, input);
  }

  async updatePromptPreset(presetId: string, patch: {
    name?: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    summary?: string;
    tools?: string;
  }): Promise<PromptPresetDto> {
    return updatePromptPreset(this.deps, presetId, patch);
  }

  async deletePromptPreset(presetId: string): Promise<void> {
    return deletePromptPreset(this.deps, presetId);
  }
}
