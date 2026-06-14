import type { SettingsRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";

export class SettingsAdapter implements SettingsRuntimeApi {
	constructor(private readonly stores: StoreContainer) {}

	getUiSettings = () => this.stores.uiSettings.get();

	updateUiSettings = (body: Record<string, unknown>) => this.stores.uiSettings.update({
		...(typeof body.theme === "string" ? { theme: body.theme } : {}),
		...(typeof body.chatFontSize === "number" ? { chatFontSize: body.chatFontSize } : {}),
		...(typeof body.uiFontSize === "number" ? { uiFontSize: body.uiFontSize } : {}),
		...(typeof body.messageWidth === "number" ? { messageWidth: body.messageWidth } : {}),
		...(typeof body.language === "string" ? { language: body.language } : {}),
		...(typeof body.activePromptPresetId === "string" || body.activePromptPresetId === null ? { activePromptPresetId: body.activePromptPresetId } : {}),
		...(typeof body.aiAssistantProviderId === "string" || body.aiAssistantProviderId === null ? { aiAssistantProviderId: body.aiAssistantProviderId } : {}),
		...(typeof body.aiAssistantModelName === "string" || body.aiAssistantModelName === null ? { aiAssistantModelName: body.aiAssistantModelName } : {}),
	});
}
