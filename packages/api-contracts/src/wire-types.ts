/**
 * @module api-contracts/wire-types
 *
 * Wire-format output types shared between the backend (which produces them)
 * and the frontend (which consumes them). These are the single source of
 * truth for the shapes that cross the RPC boundary — defining them here (in a
 * package both sides import) makes drift a **compile error** instead of a
 * silent runtime bug.
 *
 * These are NOT DB types and NOT Zod input schemas. DB/domain types live in
 * `@vibe-tavern/domain`; input validation schemas live alongside in
 * `./schemas/`. The types here are the RESPONSE shapes (output DTOs):
 *
 * - `ClientProviderProfileRecord` — a security **wire projection** of the
 *   stored profile: `apiKey` (stored) → `hasStoredApiKey` (wire). The secret
 *   never crosses the boundary. Importing `StoredProviderProfileRecord`
 *   (domain) here would be a security lie (it would assert `apiKey` exists on
 *   the wire).
 * - `PersonaRecord`, `ChatListItem` — previously each side re-declared its
 *   own copy; the duplication had already drifted once (bindPerModel).
 *
 * Dependency policy: this module imports ONLY from `@vibe-tavern/domain`
 * (zero-dep, browser-safe). It must never import `@vibe-tavern/db` — that
 * would pull `bun:sqlite` into the web graph. Mapper functions that need db
 * row types stay backend-side and import these types back.
 */

import type { CharacterId, ChatId, ModelSettingsOverlay, PronounForms } from "@vibe-tavern/domain";

// ─── Provider ──────────────────────────────────────────────────────────

/**
 * Provider profile as sent to the client. Security projection of
 * `StoredProviderProfileRecord`: the secret `apiKey` is replaced by the
 * boolean `hasStoredApiKey`.
 *
 * NOTE: `bindPerModel` is serialized here (and set by `toClientProviderProfile`)
 * so the frontend's "Bind per model" toggle persists across modal open/close.
 * (Previously omitted — the toggle silently reset to off every time.)
 */
export interface ClientProviderProfileRecord {
	id: string;
	name: string;
	providerPreset: string;
	endpoint: string;
	defaultModel: string | null;
	visionModel: string | null;
	contextBudget: number | null;
	pinContextBudget: boolean;
	bindPerModel: boolean;
	maxTokens: number;
	temperature: number;
	topP: number;
	topK: number;
	minP: number;
	topA: number;
	typicalP: number;
	tfsZ: number;
	repeatLastN: number;
	mirostat: number;
	mirostatTau: number;
	mirostatEta: number;
	dryMultiplier: number;
	dryBase: number;
	dryAllowedLength: number;
	drySequenceBreakers: string[];
	xtcThreshold: number;
	xtcProbability: number;
	frequencyPenalty: number;
	presencePenalty: number;
	repetitionPenalty: number;
	stopSequences: string[];
	logitBias: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
	seed: string | null;
	reasoningEffort: string;
	showReasoning: boolean;
	streamResponse: boolean;
	customSamplers: boolean;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
	hasStoredApiKey: boolean;
	cachedModels?: CachedProviderModelsRecord;
}

export interface CachedProviderModelsRecord {
	models: Array<{
		id: string;
		label: string;
		contextLength?: number;
		capabilities?: { thinking?: boolean; tools?: boolean; vision?: boolean };
	}>;
	cachedAt: string;
}

export interface FavoriteProviderModelRecord {
	id: string;
	providerProfileId: string;
	modelId: string;
	label: string | null;
	contextLength: number | null;
	createdAt: string;
}

/**
 * Per-model sampler/context overlay (DTO mirror of the store row). Absent
 * fields in `settings` = inherit the profile base (see resolveEffectiveSettings).
 */
export interface ProviderModelSettingsRecord {
	id: string;
	providerProfileId: string;
	modelId: string;
	settings: ModelSettingsOverlay;
	createdAt: string;
	updatedAt: string;
}

// ─── Provider errors ──────────────────────────────────────────────────

/**
 * Stable category for a provider/LLM execution failure. Carried on the wire in
 * two places so the UI can show category-appropriate feedback instead of raw
 * HTTP text: (1) the SSE `error` event `{ message, category }` on the streaming
 * endpoints, and (2) the JSON error body `error.details.category` returned by
 * the non-streaming endpoints (`POST /api/chats/:chatId/messages`).
 *
 * The backend classifies via `classifyProviderError` (services/api) at the
 * execution boundary and the SSE/HTTP emit sites; the frontend reads it in
 * `sse-parser.ts` / `use-chat-controller.ts`. `unknown` means "no signal
 * matched — show the raw message".
 */
export type ProviderErrorCategory =
	| "network"
	| "authentication"
	| "rate_limit"
	| "invalid_request"
	| "server_error"
	| "timeout"
	| "aborted"
	| "empty_response"
	| "parse_error"
	| "unknown";

// ─── Persona ───────────────────────────────────────────────────────────

/**
 * Canonical persona shape — the single source of truth for the backend
 * (returned by `PersonaRuntime.list/create/duplicate`, used as
 * `SessionSnapshot.persona`) and the frontend alike.
 */
export interface PersonaRecord {
	id: string;
	name: string;
	description: string;
	pronouns: string | null;
	/** Structured pronoun declensions (custom case only); null for presets and unset. */
	pronounForms: PronounForms | null;
	avatarAssetId: string | null;
	avatarFullAssetId: string | null;
	avatarCropJson: string | null;
	avatarExt: string | null;
	avatarFullExt: string | null;
	defaultForNewChats: boolean;
	/** Vision-generated appearance description of the avatar. Null = undescribed. */
	avatarDescription: string | null;
	/** Whether the avatar appearance is injected into the prompt. */
	includeAvatarInPrompt: boolean;
	/** ISO timestamp of the last row update; avatar cache-bust key (symmetric with `CharacterRecord.updatedAt`). */
	updatedAt: string;
}

// ─── Chat ──────────────────────────────────────────────────────────────

/** Sidebar chat-list entry. `characterId` is branded on the wire. */
export interface ChatListItem {
	id: ChatId;
	title: string;
	characterId: CharacterId;
	characterName: string;
	subtitle: string;
	activeBranchLabel: string;
	messageCount: number;
	updatedAt: string;
}
