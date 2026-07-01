import type { ChatId } from "@vibe-tavern/domain";
import type { OpenAiModelOption } from "../../openai-compatible.js";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Which AppShell navigation surface is active. Co-author is a first-class
 * navigation mode (CA-8b), not a central-panel overlay layered on build: it
 * changes the Sidebar (the play structure, but listing co-author chats only),
 * the TopBar (an explicit "Back to editor" button replaces the play/build
 * toggle), and the central surface, exactly like play/build. `mode` is
 * reconciled to the active chat's mode on every active-chat transition
 * (create / switch / bootstrap) by `reconcileNavModeFromChat`, so it stays
 * consistent with the persisted chat row even though NavigationStore itself is
 * not persisted. See CA-8b in VTF_COAUTHOR_PLAN.md.
 */
export type AppMode = "play" | "build" | "coauthor";
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
