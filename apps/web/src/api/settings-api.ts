import type { UiSettingsRecord, AppSnapshot, AppCharacterEntry } from "./types.js";
import type { ChatId, PromptPresetDto } from "@vibe-tavern/domain";
import type { ScriptSafetySettings } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

export async function bootstrapApp(): Promise<{
  initialChatId: ChatId | null;
  snapshot: AppSnapshot | null;
  isFirstRun: boolean;
  allCharacters: AppCharacterEntry[];
  promptPresets: PromptPresetDto[];
  uiSettings: UiSettingsRecord;
  isArmServer: boolean;
}> {
  return unwrapRpc(await client.api.bootstrap.$get());
}

export async function updateUiSettings(input: Partial<Pick<UiSettingsRecord, "theme" | "chatFontSize" | "uiFontSize" | "messageWidth" | "language" | "activePromptPresetId" | "aiAssistantProviderId" | "aiAssistantModelName" | "chatImpersonateEnhanceDraft" | "summaryProviderId" | "summaryModelName" | "messageEditorProviderId" | "messageEditorModelName" | "coauthorProviderId" | "coauthorLoreProviderId" | "coauthorLoreModelName" | "copilotProviderId" | "copilotModelName" | "githubStarred" | "nextStarPromptAt" | "starPromptDeferrals" | "activeDictationProfileId">>): Promise<UiSettingsRecord> {
  const response = await client.api.settings.ui.$patch({ json: input });
  return unwrapRpc(response);
}

/** GET /api/settings/script-safety — the server-side singleton suppressing the
 *  imported-script warning flow (SCRIPT_SAFETY_PLAN decision 3, SS-6). */
export async function getScriptSafetySettings(): Promise<ScriptSafetySettings> {
  const response = await client.api.settings["script-safety"].$get();
  return unwrapRpc(response);
}

/** PUT /api/settings/script-safety — flip the suppress flag back on/off. */
export async function updateScriptSafetySettings(input: { suppressImportWarnings: boolean }): Promise<ScriptSafetySettings> {
  const response = await client.api.settings["script-safety"].$put({ json: input });
  return unwrapRpc(response);
}
