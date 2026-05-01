import type { ChatSessionStore } from "@rp-platform/db";
import type { PromptPresetDto } from "@rp-platform/domain";
import {
  listPromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
  type PresetModuleDeps,
} from "./session-runtime-presets.js";

export class PromptPresetService {
  constructor(private readonly store: ChatSessionStore) {}

  private get deps(): PresetModuleDeps {
    return { store: this.store };
  }

  listPromptPresets(): PromptPresetDto[] {
    return listPromptPresets(this.deps);
  }

  createPromptPreset(input: {
    name: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    summary?: string;
    tools?: string;
  }): PromptPresetDto {
    return createPromptPreset(this.deps, input);
  }

  updatePromptPreset(presetId: string, patch: {
    name?: string;
    bindModel?: string;
    system?: string;
    jailbreak?: string;
    summary?: string;
    tools?: string;
  }): PromptPresetDto {
    return updatePromptPreset(this.deps, presetId, patch);
  }

  deletePromptPreset(presetId: string): void {
    deletePromptPreset(this.deps, presetId);
  }
}
