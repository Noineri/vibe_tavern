import type { ChatId } from "@vibe-tavern/domain";
import type { OpenAiModelOption } from "../../openai-compatible.js";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
export type AppMode = "play" | "build";
export type ThemeMode = "dark" | "light";

export interface ConnectionState {
  providerLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
  activeProviderProfileId: string | null;
  hasStoredApiKey: boolean;
  status: ConnectionStatus;
  error: string;
  models: OpenAiModelOption[];
  providerType: string;
  providerPreset: string;
  temperature: number;
  topP: number;
  minP: number;
  topK: number;
  topA: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  maxTokens: number;
  stopSequences: string[];
  seed: string | null;
  reasoningEffort: string;
  showReasoning: boolean;
  streamResponse: boolean;
  customSamplers: boolean;
}

export interface CharacterTab {
  id: string;
  name: string;
  subtitle: string;
  chatId: ChatId | null;
  avatarAssetId: string | null;
  avatarCropJson: string | null;
  avatarExt: string | null;
}
