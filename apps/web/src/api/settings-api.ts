import type { UiSettingsRecord, AppSnapshot } from "./types.js";
import type { ChatId, PromptPresetDto } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import { getGatewayBaseUrl, getMobileToken } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";
import { normalizeSnapshot } from "./normalize.js";

export async function bootstrapApp(): Promise<{
  initialChatId: ChatId | null;
  snapshot: AppSnapshot | null;
  isFirstRun: boolean;
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarCropJson: string | null; avatarExt: string | null }>;
  promptPresets: PromptPresetDto[];
  uiSettings: UiSettingsRecord;
  isArmServer: boolean;
}> {
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/bootstrap`), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const data = await unwrapRpc<{
    initialChatId: ChatId | null;
    snapshot: AppSnapshot | null;
    isFirstRun?: boolean;
    allCharacters?: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null; avatarCropJson?: string | null; avatarExt?: string | null }>;
    promptPresets?: PromptPresetDto[];
    uiSettings?: UiSettingsRecord;
    isArmServer?: boolean;
  }>(response);

  return {
    initialChatId: data.initialChatId,
    snapshot: data.snapshot ? normalizeSnapshot(data.snapshot) : null,
    isFirstRun: data.isFirstRun ?? false,
    allCharacters: (data.allCharacters ?? []).map(c => ({ ...c, avatarCropJson: c.avatarCropJson ?? null, avatarExt: c.avatarExt ?? null })),
    promptPresets: data.promptPresets ?? [],
    uiSettings: data.uiSettings ?? {
      id: "default",
      theme: "coffee",
      chatFontSize: 15,
      uiFontSize: 14,
      messageWidth: 700,
      language: "en",
      activePromptPresetId: null,
      aiAssistantProviderId: null,
      aiAssistantModelName: null,
      updatedAt: "",
    },
    isArmServer: data.isArmServer ?? false,
  };
}

export async function fetchUiSettings(): Promise<UiSettingsRecord> {
  const response = await client.api.settings.ui.$get();
  return unwrapRpc<UiSettingsRecord>(response);
}

export async function updateUiSettings(input: Partial<Pick<UiSettingsRecord, "theme" | "chatFontSize" | "uiFontSize" | "messageWidth" | "language" | "activePromptPresetId" | "aiAssistantProviderId" | "aiAssistantModelName">>): Promise<UiSettingsRecord> {
  const response = await client.api.settings.ui.$patch({ json: input });
  return unwrapRpc<UiSettingsRecord>(response);
}
