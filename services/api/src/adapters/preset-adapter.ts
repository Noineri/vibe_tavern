import type { PresetRuntimeApi } from "../api/contract/runtime-api.js";
import type { PromptPresetService } from "../prompt/prompt-preset-service.js";

export class PresetAdapter implements PresetRuntimeApi {
	constructor(private readonly presetService: PromptPresetService) {}

	listPromptPresets = () => this.presetService.listPromptPresets();
	createPromptPreset = (body: Parameters<PromptPresetService["createPromptPreset"]>[0]) => this.presetService.createPromptPreset(body);
	updatePromptPreset = (presetId: string, body: Parameters<PromptPresetService["updatePromptPreset"]>[1]) => this.presetService.updatePromptPreset(presetId, body);
	deletePromptPreset = (presetId: string) => this.presetService.deletePromptPreset(presetId);
}
