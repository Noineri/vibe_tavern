/**
 * @module stt-presets
 *
 * Named STT provider presets on the OpenAI-compatible transport
 * (STT_PROVIDER_EXPANSION_REPORT, SPE-1).
 *
 * The v1 STT roster shipped one catch-all `openai-compat` backend where every
 * cloud vendor was a manual base URL + key + model — the anti-pattern the
 * owner flagged: concrete providers must be named rows, exactly like the TTS
 * tab's named backends. But unlike TTS (12 backends, 12 wire shapes), all
 * verified transcription vendors speak the SAME OpenAI-compatible multipart
 * `/audio/transcriptions` surface, so they are PRESETS — pure data rows on the
 * one existing transport — not twelve new backends. Native-wire vendors
 * (Deepgram, ElevenLabs, NVIDIA chat-audio) join as their own backend types
 * with their own preset rows (SPE-4..6, landed). Whisper-browser and gemini
 * stay named backends in the picker without preset rows.
 *
 * The aggregator rule (owner, standing): an aggregator (OpenRouter) is ONE row
 * among named providers, never a substitute for them — every vendor with a
 * verified direct API gets its own preset row, OpenRouter included as itself.
 *
 * Pure data: no I/O, no secrets. The web picker and the server adapter both
 * import this module directly (Vite aliases `@vibe-tavern/domain` to source).
 * All endpoint/model facts are doc-verified (sources inline in the report);
 * `baseUrl` is the value the openai-stt adapter expects — it appends
 * `/audio/transcriptions` itself.
 */

import {
	DEFAULT_DEEPGRAM_STT_MODEL,
	DEFAULT_ELEVENLABS_STT_MODEL,
	DEFAULT_NVIDIA_STT_MODEL,
	STT_BACKENDS,
} from "./entities.js";
import type { SttBackendType } from "./entities.js";

/** Auth header shape a preset's transport must send when a key is set.
 *  Optional: it is an instruction for the OpenAI-compatible transport
 *  only — a preset backed by a NATIVE adapter (deepgram/elevenlabs/nvidia)
 *  carries none, because its adapter owns the wire shape (Token /
 *  xi-api-key / Bearer hardcoded there). Bearer is the default every
 *  compat row uses; X-API-Key stays in the vocabulary for wire shapes that
 *  need it — the SPE-R pass confirmed no current row does, so no transport
 *  override is built: if a live probe ever 401s on Bearer, add the override
 *  then. */
export const STT_PRESET_AUTH_HEADER = {
	Bearer: "bearer",
	XApiKey: "x-api-key",
} as const;
export type SttPresetAuthHeader = (typeof STT_PRESET_AUTH_HEADER)[keyof typeof STT_PRESET_AUTH_HEADER];

/** How a preset's model list is sourced for the picker (SPE-3):
 *  - `static` — shipped list (the vendor's documented transcription roster);
 *  - `fetch` — live discovery via the backend's `listModels` (the openai-stt
 *    adapter already filters `GET {endpoint}/models?output_modalities=
 *    transcription`, which is OpenRouter's documented discovery shape);
 *  - `free-text` — user-typed model id (local servers: any
 *    OpenAI-compatible transcription server, whisper.cpp / faster-whisper /
 *    LocalAI / a Riva NIM container). */
export type SttPresetModelSource =
	| {
			kind: "static";
			/** Documented transcription models (picker order). */
			models: readonly string[];
			defaultModel: string;
	  }
	| {
			kind: "fetch";
			defaultModel: string;
	  }
	| {
			kind: "free-text";
			defaultModel: string;
	  };

/** One named provider row on the STT picker. */
export interface SttProviderPreset {
	/** Row slug — unique across the roster; doubles as the i18n key suffix
	 *  (`stt_preset_<id>`). */
	id: string;
	/** The transport backend that executes this preset (must exist in
	 *  {@link STT_BACKENDS} — see the module note on native adapters). */
	backend: SttBackendType;
	/** Prefilled transcriptions base URL (adapter-normalized form: trailing
	 *  slashes stripped, `/audio/transcriptions` appended by the adapter).
	 *  Empty only for the local-server preset (user-filled field). */
	baseUrl: string;
	/** Auth header the OpenAI-compatible transport sends when a key is set
	 *  (SPE-2 — optional: native-adapter presets carry none; see
	 *  {@link STT_PRESET_AUTH_HEADER}). */
	authHeader?: SttPresetAuthHeader;
	/** Vendor slug for the auto-key rule — an STT profile without its own key
	 *  reuses the same-vendor saved TTS/LLM profile key; `""` = no vendor
	 *  match (whisper-browser aside, only the local preset has none). */
	vendor: string;
	/** Model sourcing for the picker. */
	modelSource: SttPresetModelSource;
	/** True when the API key is optional at connect time (local servers may
	 *  run keyless — the openai-stt adapter already sends no Authorization
	 *  header without a key). */
	keyOptional: boolean;
	/** SPE-6 flag: the preset's models transcribe ENGLISH SPEECH ONLY (the
	 *  hosted NVIDIA omni card, owner-approved roster fact). The picker
	 *  renders the EN-only hint and hides the language field; RU dictation
	 *  stays on the other rows. */
	englishOnly?: boolean;
}

/** The named-provider roster on the OpenAI-compatible transport. Every row is
 *  doc-verified (STT_PROVIDER_EXPANSION_REPORT, "Verdict" table); the two
 *  non-transport backends (whisper-browser, gemini) are NOT presets — they
 *  stay named backends in the picker — and native-adapter vendors
 *  (deepgram/elevenlabs/nvidia) land with their adapters (SPE-4..6). */
export const STT_PROVIDER_PRESETS: readonly SttProviderPreset[] = [
	{
		id: "openai",
		backend: STT_BACKENDS.OpenAiCompat,
		baseUrl: "https://api.openai.com/v1",
		authHeader: STT_PRESET_AUTH_HEADER.Bearer,
		vendor: "openai",
		modelSource: {
			kind: "static",
			models: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-transcribe"],
			defaultModel: "whisper-1",
		},
		keyOptional: false,
	},
	{
		id: "openrouter",
		backend: STT_BACKENDS.OpenAiCompat,
		baseUrl: "https://openrouter.ai/api/v1",
		authHeader: STT_PRESET_AUTH_HEADER.Bearer,
		vendor: "openrouter",
		// Live roster via the documented discovery filter (20 models / 9
		// providers at 2026-09-05) — self-updating, nothing hardcoded. The
		// default is the first-party whisper entry of that roster.
		modelSource: {
			kind: "fetch",
			defaultModel: "openai/whisper-large-v3",
		},
		keyOptional: false,
	},
	{
		id: "groq",
		backend: STT_BACKENDS.OpenAiCompat,
		baseUrl: "https://api.groq.com/openai/v1",
		authHeader: STT_PRESET_AUTH_HEADER.Bearer,
		vendor: "groq",
		modelSource: {
			kind: "static",
			models: ["whisper-large-v3", "whisper-large-v3-turbo"],
			defaultModel: "whisper-large-v3",
		},
		keyOptional: false,
	},
	{
		id: "mistral",
		backend: STT_BACKENDS.OpenAiCompat,
		baseUrl: "https://api.mistral.ai/v1",
		authHeader: STT_PRESET_AUTH_HEADER.Bearer,
		vendor: "mistral",
		modelSource: {
			kind: "static",
			// Documented transcription roster (their API-reference model ids;
		// SPE-R note: their docs EXAMPLES drift across aliases like
		// voxtral-mini-latest / voxtral-2602, so revisit this list on the
		// first live connect — the documented ids stay the safe default
			// until a key verifies whether /v1/models supports the
			// output_modalities filter).
			models: ["voxtral-mini-3b-2507", "voxtral-small-24b-2507-stt"],
			defaultModel: "voxtral-mini-3b-2507",
		},
		keyOptional: false,
	},
	{
		id: "cartesia",
		backend: STT_BACKENDS.OpenAiCompat,
		// Their OpenAI-compatible drop-in lives at
		// https://api.cartesia.ai/audio/transcriptions (no /v1 segment) —
		// the adapter's append yields exactly that path.
		baseUrl: "https://api.cartesia.ai",
		// SPE-R correction (2026-09-05): Cartesia auth is Bearer — their own
		// /stt OpenAPI declares `APIKeyAuth {type: http, scheme: bearer}` and
		// the repo's live cartesia-tts adapter has been sending Bearer all
		// along. The earlier X-API-Key claim came from a migrate page that is
		// now unreachable (Vercel checkpoint); if a live transcription ever
		// 401s on Bearer, revisit a header override then.
		authHeader: STT_PRESET_AUTH_HEADER.Bearer,
		vendor: "cartesia",
		modelSource: {
			kind: "static",
			// Batch transcription is ink-whisper-only (ink-2 is websocket-only,
			// out of scope for single-shot dictation).
			models: ["ink-whisper"],
			defaultModel: "ink-whisper",
		},
		keyOptional: false,
	},
	{
		// «Локальный сервер» — the owner-required named row for any local
		// OpenAI-compatible transcription server (whisper.cpp server,
		// faster-whisper-server, LocalAI, a Riva NIM ASR container); mirrors
		// the TTS tab's Local Server entry instead of hiding locals in the
		// old catch-all row.
		id: "local",
		backend: STT_BACKENDS.OpenAiCompat,
		baseUrl: "",
		authHeader: STT_PRESET_AUTH_HEADER.Bearer,
		vendor: "",
		modelSource: {
			kind: "free-text",
			defaultModel: "whisper-1",
		},
		keyOptional: true,
	},
	// ── Native-adapter presets (SPE-4..6) ───────────────────────────────────
	// These rows ride their OWN backend slugs — the adapter owns the wire
	// (endpoint, auth shape, payload), so `baseUrl` stays empty (no endpoint
	// field — the gemini-stt precedent) and `authHeader` is omitted. They
	// exist so the picker, model roster, auto-key hints and the EN-only flag
	// stay pure data over ONE roster instead of adapter-code constants.
	{
		id: "deepgram",
		backend: STT_BACKENDS.Deepgram,
		baseUrl: "",
		vendor: "deepgram",
		modelSource: {
			kind: "fetch",
			// GET /v1/models → stt[] (live catalog; nova-3 is the default and
			// understands Russian natively — changelog-verified, SPE-R).
			defaultModel: DEFAULT_DEEPGRAM_STT_MODEL,
		},
		keyOptional: false,
	},
	{
		id: "elevenlabs",
		backend: STT_BACKENDS.ElevenLabs,
		baseUrl: "",
		vendor: "elevenlabs",
		modelSource: {
			kind: "static",
			// No STT discovery endpoint exists (/v1/models is the TTS catalog)
			// — the Scribe roster is shipped data (SPE-R).
			models: [DEFAULT_ELEVENLABS_STT_MODEL, "scribe-1"],
			defaultModel: DEFAULT_ELEVENLABS_STT_MODEL,
		},
		keyOptional: false,
	},
	{
		id: "nvidia",
		backend: STT_BACKENDS.Nvidia,
		baseUrl: "",
		vendor: "nvidia",
		modelSource: {
			kind: "static",
			// The hosted chat catalog does not mark audio capability — the
			// usable roster is the verified omni reference (SPE-6).
			models: [DEFAULT_NVIDIA_STT_MODEL],
			defaultModel: DEFAULT_NVIDIA_STT_MODEL,
		},
		keyOptional: false,
		englishOnly: true,
	},
];

/** Lookup by row slug (`undefined` when the id is not in the roster). */
export function getSttProviderPreset(id: string): SttProviderPreset | undefined {
	return STT_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** The preset row backing a NATIVE backend slug (deepgram / elevenlabs /
 *  nvidia), `undefined` for every non-native slug (compat presets are many
 *  per backend, whisper/gemini are named backends without preset rows).
 *  The web recognition section and provider form use this for the static
 *  model roster and the EN-only flag — pure data, no adapter imports. */
export function getSttNativePreset(backend: SttBackendType): SttProviderPreset | undefined {
	if (
		backend === STT_BACKENDS.OpenAiCompat ||
		backend === STT_BACKENDS.WhisperBrowser ||
		backend === STT_BACKENDS.Gemini
	) {
		return undefined;
	}
	return STT_PROVIDER_PRESETS.find((preset) => preset.backend === backend);
}
