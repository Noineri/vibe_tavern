import type { ChatId } from "@rp-platform/domain";
import type { OpenAiModelOption } from "../openai-compatible.js";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
export type AppMode = "play" | "build";
export type SidePanel = "trace" | "closed";
export type ThemeMode = "dark" | "light";

export interface ConnectionState {
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  activeProviderProfileId: string | null;
  hasStoredApiKey: boolean;
  status: ConnectionStatus;
  error: string;
  models: OpenAiModelOption[];
}

export interface SavedConnectionState {
  providerLabel?: string;
  baseUrl?: string;
  model?: string;
}

export interface CharacterTab {
  id: string;
  name: string;
  subtitle: string;
  chatId: ChatId;
}
