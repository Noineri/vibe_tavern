import type { UiSettingsRecord, AppSnapshot, AppCharacterEntry } from "./types.js";
import type { ChatId, PromptPresetDto } from "@vibe-tavern/domain";
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

export async function updateUiSettings(input: Partial<Pick<UiSettingsRecord, "theme" | "chatFontSize" | "uiFontSize" | "messageWidth" | "language" | "activePromptPresetId" | "aiAssistantProviderId" | "aiAssistantModelName" | "summaryProviderId" | "summaryModelName" | "messageEditorProviderId" | "messageEditorModelName" | "coauthorProviderId" | "coauthorModelName" | "coauthorMaxTokens" | "coauthorContextBudget" | "copilotProviderId" | "copilotModelName" | "githubStarred" | "nextStarPromptAt" | "starPromptDeferrals" | "activeDictationProfileId">>): Promise<UiSettingsRecord> {
  const response = await client.api.settings.ui.$patch({ json: input });
  return unwrapRpc(response);
}
