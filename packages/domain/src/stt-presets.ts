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
 * (Gemini, Deepgram, ElevenLabs, NVIDIA chat-audio) join as their own
 * backend types with their own preset rows (SPE-4..6, landed; gemini joined
 * its row in SPE-8). Only whisper-browser stays a named backend without a
 * preset row — it is the browser tier, not a provider.
 *
 * SPE-8 (owner directive 2026-09-05): the roster carries the LLM-tab group
 * taxonomy — every row has a `group` (cloud / native / local) and the
 * picker renders level-1 segments from it, exactly like the LLM provider
 * presets. The old SPE-1 line "gemini is not a preset" is superseded.
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
	DEFAULT_GEMINI_STT_MODEL,
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
	  }
	| {
			kind: "server";
	  };

/** Provider group — the LLM-tab taxonomy (SPE-8, owner directive
 *  2026-09-05): `cloud` = OpenAI-compatible transport rows,
 *  `native` = own-wire backend rows, `local` = the local-server row.
 *  The picker renders level-1 segments from this field. */
export const STT_PRESET_GROUP = {
	Cloud: "cloud",
	Native: "native",
	Local: "local",
} as const;
export type SttPresetGroup = (typeof STT_PRESET_GROUP)[keyof typeof STT_PRESET_GROUP];

/** One named provider row on the STT picker. */
export interface SttProviderPreset {
	/** Row slug — unique across the roster; doubles as the i18n key suffix
	 *  (`stt_preset_<id>`). */
	id: string;
	/** Group for the level-1 segment taxonomy (SPE-8 — mirrors the LLM
	 *  provider-presets `group` field). */
	group: SttPresetGroup;
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

/** The named-provider roster. Every row is doc-verified
 *  (STT_PROVIDER_EXPANSION_REPORT, "Verdict" table): compat rows ride the
 *  one OpenAI-compatible transport, native-adapter vendors
 *  (gemini/deepgram/elevenlabs/nvidia) ride their own slugs (SPE-4..6,
 *  SPE-8), and the local row marks the local-server arm. Only
 *  whisper-browser is a named backend without a preset row (browser tier). */
export const STT_PROVIDER_PRESETS: readonly SttProviderPreset[] = [
	{
		id: "openai",
		group: STT_PRESET_GROUP.Cloud,
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
		group: STT_PRESET_GROUP.Cloud,
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
		group: STT_PRESET_GROUP.Cloud,
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
		group: STT_PRESET_GROUP.Cloud,
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
		group: STT_PRESET_GROUP.Cloud,
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
		// speaches, LocalAI, a Riva NIM ASR container); mirrors
		// the TTS tab's Local Server entry instead of hiding locals in the
		// old catch-all row.
		id: "local",
		group: STT_PRESET_GROUP.Local,
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
	// SPE-8: gemini joins the native group — it moves from a segment option
	// to a preset row (the LLM-tab pattern: natives are rows, not segments).
	// Fetch roster via the gemini-stt listModels (fixed Gemini API endpoint,
	// no endpoint field — the ST-7 precedent all natives share).
	{
		id: "gemini",
		group: STT_PRESET_GROUP.Native,
		backend: STT_BACKENDS.Gemini,
		baseUrl: "",
		vendor: "gemini",
		modelSource: {
			kind: "fetch",
			defaultModel: DEFAULT_GEMINI_STT_MODEL,
		},
		keyOptional: false,
	},
	{
		id: "whisper-cpp",
		group: STT_PRESET_GROUP.Local,
		backend: STT_BACKENDS.WhisperCpp,
		// The project's own local server surface (`POST /inference`) —
		// SPE-9: own-wire locals are adapter territory, not an exclusion
		// note. Prefilled with the server's default host/port; the endpoint
		// stays editable (the Local arm). Also covers whisperfile (the
		// llamafile wraps this server).
		baseUrl: "http://127.0.0.1:8080",
		vendor: "",
		// The model is bound at server start (`-m`) — no request-side
		// model field; the picker shows the server-flags hint instead.
		modelSource: { kind: "server" },
		keyOptional: true,
	},
	{
		id: "deepgram",
		group: STT_PRESET_GROUP.Native,
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
		group: STT_PRESET_GROUP.Native,
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
		group: STT_PRESET_GROUP.Native,
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

/** Group of a preset row by slug (`null` for unknown ids) — mirrors the
 *  TTS `getTtsPresetGroup` helper so the picker filters rows by the
 *  level-1 segment. */
export function getSttPresetGroup(id: string): SttPresetGroup | null {
	return STT_PROVIDER_PRESETS.find((preset) => preset.id === id)?.group ?? null;
}

/** The preset row backing a NATIVE backend slug (gemini / deepgram /
 *  elevenlabs / nvidia), `undefined` for every non-native slug (compat
 *  presets are many per backend, whisper-browser is the browser tier
 *  without a row). The web recognition section and provider form use this
 *  for the static model roster and the EN-only flag — pure data, no
 *  adapter imports. */
export function getSttNativePreset(backend: SttBackendType): SttProviderPreset | undefined {
	if (backend === STT_BACKENDS.OpenAiCompat || backend === STT_BACKENDS.WhisperBrowser) {
		return undefined;
	}
	return STT_PROVIDER_PRESETS.find((preset) => preset.backend === backend);
}
