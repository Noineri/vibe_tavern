import type { ChatId, ChatMode } from "@vibe-tavern/domain";
import type { OpenAiModelOption } from "../../openai-compatible.js";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";
export type AppMode = "play" | "build";

/** Which AppShell surface to render when an active snapshot exists. */
export type ShellSurface = "coauthor" | AppMode;

/**
 * Derive the AppShell surface from the active chat's mode + the navigation mode.
 * Co-author keys off `activeChat.mode` (a property of the chat), NOT off AppMode
 * (which is user-toggleable play/build navigation). A co-author chat renders the
 * CoauthorMode surface regardless of whether the user was last in play or build
 * view — co-author composes its own chat shell. RP chats (mode 'rp' or any
 * non-coauthor value) fall back to the play/build navigation mode.
 */
export function resolveShellSurface(
	activeChatMode: ChatMode | undefined,
	navMode: AppMode,
): ShellSurface {
	if (activeChatMode === "coauthor") return "coauthor";
	return navMode;
}
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
