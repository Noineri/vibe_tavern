import type { ChatId } from "@vibe-tavern/domain";
import type { OpenAiModelOption } from "../../openai-compatible.js";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

// AppMode (the play/build editing axis) is owned by the chat-mode registry —
// re-exported here for back-compat with the files that import it from this
// module (navigation-store, chat-actions). The registry is the single source
// of truth. AppMode is now JUST play/build: the rp/coauthor split is a ChatMode
// on the chat itself, read by the shell dispatch hook (useShellSurface), NOT a
// navigation mode — NavigationStore no longer carries a "coauthor" value.
// Mirrors the ThemeMode re-export pattern below.
export type { AppMode } from "../../lib/chat-mode-registry.js";
// ThemeMode is owned by the theme registry — re-exported here for back-compat
// with the many files that import it from this module. The registry is the
// single source of truth (adding a theme requires no change here).
export type { ThemeMode } from "../../themes/registry.js";

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
  updatedAt: string;
}
