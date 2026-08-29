/**
 * @module tts/backends/openai-tts
 *
 * OpenAI-compatible TTS adapter (TTS_PLAN TS-4) — ONE adapter for any server
 * speaking the OpenAI speech protocol: OpenAI cloud, OpenRouter, and local
 * servers (kokoro-fastapi :8880, openedai-tts :8000, …). The endpoint is the
 * base URL INCLUDING `/v1` (house `normalizeOpenAiCompatibleBaseUrl` also
 * tolerates a trailing slash or a pasted `/chat/completions` suffix).
 *
 * API facts (verified 2026-08-27, TE2-3 honest):
 * - POST {endpoint}/audio/speech, body { model, input, voice, response_format,
 *   speed? } (snake_case). `Authorization: Bearer` ONLY when a key is set —
 *   local servers run keyless. `instructions` is OpenAI-specific and works
 *   ONLY on gpt-4o-mini-tts* models (rejected/ignored on tts-1 family), so it
 *   is included only for that model family.
 * - Voices: kokoro-fastapi exposes GET /v1/audio/voices → { voices: [{ id, name? }] };
 *   Honest (TE2-3): listVoices hits ONLY /audio/voices and returns null on
 *   any failure — no fallback to /models or to the static OpenAI roster.
 *   Static voice lists for cloud presets now live client-side
 *   (apps/web/src/lib/tts/tts-presets.ts).
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type {
  TtsAudioResult,
  TtsBackend,
  TtsBackendFactory,
  TtsGenerateRequest,
  TtsProbeResult,
  TtsVoiceInfo,
} from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";
import {
  buildHeaders,
  normalizeOpenAiCompatibleBaseUrl,
} from "../../providers/provider-transport.js";

const TTS_GENERATE_TIMEOUT_MS = 30_000;
const TTS_VOICE_LIST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

const DEFAULT_MODEL = "kokoro";
const DEFAULT_RESPONSE_FORMAT = "mp3";
const FALLBACK_MIME = "audio/mpeg";

const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

/** Heuristic for filtering chat models out of a mixed /models list —
 *  keeps only ids that look like TTS models. Empty result falls back
 *  to the full list so the UI is never left with an empty dropdown. */
const TTS_MODEL_HEURISTIC_RE =
  /tts|speech|audio|kokoro|orpheus|fish|cosy|dia|melo|voice/i;

/** Known aggregator that hides speech models behind the
 *  `output_modalities` query param: the unfiltered catalog is 300+
 *  chat-only models with none of the TTS ones (verified live — the
 *  speech-filtered request returns them, the plain one does not).
 *  Host-based detection heals profiles saved before the preset began
 *  stamping `modelFilter` into the config bag. */
const MODALITY_FILTER_HOSTS = new Set(["openrouter.ai"]);

function isOpenRouterStyleEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
    return MODALITY_FILTER_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** NanoGPT serves TTS discovery from a DEDICATED catalog: GET
 *  /audio-models?type=tts&detailed=true (docs: /api-reference/endpoint/
 *  audio-models). The plain /models catalog is chat-only and silently
 *  ignores output_modalities — verified live 2026-08-29 (D23). Host-based
 *  detection heals profiles saved before the preset stamped `modelFilter:
 *  "audio-models"`. */
const AUDIO_MODELS_HOSTS = new Set(["nano-gpt.com"]);

function isNanoGptStyleEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
    return AUDIO_MODELS_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** OpenAI's gpt-4o-mini-tts built-in voice roster (13, docs 2026-08-27). */
export const VOICES_GPT4O_MINI_TTS: readonly string[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];

/** The tts-1 / tts-1-hd subset (9 voices, docs 2026-08-27). */
export const VOICES_TTS1: readonly string[] = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
];

/** HTTP / transport failure of a speech or voices request. */
export class OpenAiCompatTtsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenAiCompatTtsError";
  }
}

/** Profile config problem (missing endpoint, empty voice). */
export class OpenAiCompatTtsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiCompatTtsConfigError";
  }
}

// ─── Config accessors (loose TtsProfileConfig bag, house style) ──────────────

interface OpenAiCompatTtsConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  responseFormat: string;
}

function readString(config: TtsProfileConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseConfig(config: TtsProfileConfig): OpenAiCompatTtsConfig {
  const rawEndpoint = readString(config, "endpoint");
  if (!rawEndpoint) {
    throw new OpenAiCompatTtsConfigError(
      "OpenAI-compatible TTS config error: `endpoint` is required",
    );
  }
  const endpoint = normalizeOpenAiCompatibleBaseUrl(rawEndpoint);
  if (!endpoint) {
    throw new OpenAiCompatTtsConfigError(
      "OpenAI-compatible TTS config error: `endpoint` is empty after normalization",
    );
  }
  return {
    endpoint,
    apiKey: readString(config, "apiKey") ?? "",
    model: readString(config, "model") ?? DEFAULT_MODEL,
    responseFormat: readString(config, "responseFormat") ?? DEFAULT_RESPONSE_FORMAT,
  };
}

function clampSpeed(value: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function readErrorExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > ERROR_BODY_EXCERPT_LENGTH
      ? `${text.slice(0, ERROR_BODY_EXCERPT_LENGTH)}…`
      : text;
  } catch {
    return "(unreadable error body)";
  }
}

function httpErrorMessage(operation: string, response: Response, excerpt: string): string {
  return `OpenAI-compatible TTS ${operation} failed with HTTP ${response.status}${
    excerpt ? `: ${excerpt}` : ""
  }`;
}

/** Wrap a transport-level failure (DNS, refused connection, timeout) in the
 *  adapter's typed error so callers get one error surface. */
async function fetchOrWrap(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new OpenAiCompatTtsError(
      `OpenAI-compatible TTS ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

// ─── Voice payload parsing (unknown at the fetch edge) ───────────────────────

function toVoiceInfo(id: unknown, name: unknown): TtsVoiceInfo | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    id,
    label: typeof name === "string" && name.length > 0 ? name : id,
    lang: "en",
  };
}

/** kokoro-fastapi shape: { voices: [{ id, name? }] } (bare array tolerated). */
function parseVoicesPayload(parsed: unknown): TtsVoiceInfo[] | null {
  const raw = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).voices
      : undefined;
  if (!Array.isArray(raw)) return null;
  const voices: TtsVoiceInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const voice = toVoiceInfo(record.id, record.name);
    if (voice) voices.push(voice);
  }
  return voices.length > 0 ? voices : null;
}



// ─── Factory ─────────────────────────────────────────────────────────────────

export const openAiCompatTtsFactory: TtsBackendFactory = (config) => {
  const cfg = parseConfig(config);

  /** Catalog selection (D15/D23), shared by listModels and listVoices:
   *  explicit stamp wins, else the host default heals pre-stamp profiles.
   *  `plain` = the ordinary OpenAI-compatible /models catalog. */
  const catalogRequest = (): { kind: "audio-models" | "modality" | "plain"; url: string } => {
    const modelFilter = readString(config, "modelFilter");
    // NanoGPT: the HOST ALWAYS wins (field fix 2026-08-29). Every pre-F6
    // nanogpt profile carries the OLD preset stamp `modelFilter:
    // "name-heuristic"` — an explicit-LOOKING value that is not a user
    // choice (no UI edits modelFilter; it is preset glue only), so healing
    // only the undefined case missed exactly the live profiles it existed
    // for (owner field report: chat catalog + no voices). The plain
    // /models catalog on nano-gpt is chat-only — there is no legitimate
    // plain case there.
    if (modelFilter === "audio-models" || isNanoGptStyleEndpoint(cfg.endpoint)) {
      return { kind: "audio-models", url: `${cfg.endpoint}/audio-models?type=tts&detailed=true` };
    }
    // OpenRouter keeps the heal-on-undefined contract: its stamp era began
    // with "modality" (D15), so undefined is the only legacy shape in the
    // wild — no stamped-but-wrong class exists here.
    if (modelFilter === "modality" || (modelFilter === undefined && isOpenRouterStyleEndpoint(cfg.endpoint))) {
      return { kind: "modality", url: `${cfg.endpoint}/models?output_modalities=speech` };
    }
    return { kind: "plain", url: `${cfg.endpoint}/models` };
  };

  const backend: TtsBackend = {
    async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
      const voice = req.voiceId.trim();
      if (!voice) {
        throw new OpenAiCompatTtsConfigError(
          "OpenAI-compatible TTS generate requires a non-empty voiceId",
        );
      }

      const body: Record<string, unknown> = {
        model: cfg.model,
        input: req.text,
        voice,
        response_format: cfg.responseFormat,
      };
      if (req.speed !== undefined) body.speed = clampSpeed(req.speed);
      // `instructions` is gpt-4o-mini-tts-only (OpenAI docs: does not work
      // with tts-1/tts-1-hd) — sending it to other servers risks spoken
      // leakage, so it is gated on the model family.
      if (req.instructions && req.instructions.trim() !== "" && cfg.model.startsWith("gpt-4o-mini-tts")) {
        body.instructions = req.instructions;
      }

      const response = await fetchOrWrap(
        `${cfg.endpoint}/audio/speech`,
        {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TTS_GENERATE_TIMEOUT_MS),
        },
        "generate",
      );

      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new OpenAiCompatTtsError(httpErrorMessage("generate", response, excerpt));
      }
      const audio = Buffer.from(await response.arrayBuffer());
      const mime = response.headers.get("content-type") ?? FALLBACK_MIME;
      return { audio, mime };
    },

    async listModels(): Promise<import("../tts-backend.js").TtsModelInfo[]> {
      const modelFilter = readString(config, "modelFilter");
      const { kind, url } = catalogRequest();
      const useModalityParam = kind === "modality";
      const useAudioModelsCatalog = kind === "audio-models";
      const response = await fetchOrWrap(
        url,
        {
          method: "GET",
          headers: buildHeaders(cfg.apiKey),
          signal: AbortSignal.timeout(TTS_VOICE_LIST_TIMEOUT_MS),
        },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new OpenAiCompatTtsError(httpErrorMessage("model list", response, excerpt));
      }
      const parsed: unknown = await response.json().catch(() => null);
      if (typeof parsed !== "object" || parsed === null) return [];
      // Two shapes in the wild: OpenAI-compatible `{data:[{id}]}` and
      // openai-edge-tts's `{models:[{id}]}` — accept either.
      const record = parsed as Record<string, unknown>;
      const data = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null;
      if (data === null) return [];
      const out: import("../tts-backend.js").TtsModelInfo[] = [];
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const id = record.id;
        if (typeof id !== "string" || id.length === 0) continue;
        // NanoGPT audio-models entries (D23): `type=tts` still returns music
        // models — only entries with capabilities.text_to_speech === true
        // synthesize via POST /audio/speech. Docs say to rely on the
        // capability flag, never hardcode the roster.
        if (useAudioModelsCatalog) {
          const capabilities = record.capabilities;
          const tts =
            typeof capabilities === "object" && capabilities !== null
              ? (capabilities as Record<string, unknown>).text_to_speech
              : undefined;
          if (tts !== true) continue;
        }
        // Enrichment (OpenRouter-style entries; absent on plain OpenAI):
        // `name` is the display label, `description` human wording,
        // `pricing.prompt/completion` per-Mtok strings ("0" = free tier),
        // `context_length` the input window. NanoGPT prices per thousand
        // CHARS instead (`pricing.per_thousand_chars`).
        const info: import("../tts-backend.js").TtsModelInfo = {
          id,
          label: typeof record.name === "string" && record.name.length > 0 ? record.name : id,
        };
        if (typeof record.description === "string" && record.description.length > 0) {
          info.description = record.description;
        }
        if (typeof record.context_length === "number" && Number.isFinite(record.context_length)) {
          info.contextLength = record.context_length;
        }
        // D22: the per-model voice roster rides the catalog entry. Only the
        // aggregator catalogs carry it (plain /models responses have none —
        // their voices come from /audio/voices in listVoices).
        if (useAudioModelsCatalog || useModalityParam) {
          const voices = catalogEntryVoices(record, useAudioModelsCatalog);
          if (voices !== undefined) info.voices = voices;
        }
        if (useAudioModelsCatalog) {
          const pricing = record.pricing;
          if (typeof pricing === "object" && pricing !== null) {
            const perKCharsRaw = (pricing as Record<string, unknown>).per_thousand_chars;
            const perKChars =
              typeof perKCharsRaw === "number"
                ? perKCharsRaw
                : typeof perKCharsRaw === "string" && perKCharsRaw.trim() !== ""
                  ? Number(perKCharsRaw)
                  : Number.NaN;
            if (Number.isFinite(perKChars)) info.isFree = perKChars === 0;
          }
          out.push(info);
          continue;
        }
        const pricing = record.pricing;
        if (typeof pricing === "object" && pricing !== null) {
          const p = pricing as Record<string, unknown>;
          const toNumber = (v: unknown): number | null => {
            if (typeof v === "number" && Number.isFinite(v)) return v;
            if (typeof v === "string" && v.trim() !== "") {
              const parsed = Number(v);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
          };
          const prompt = toNumber(p.prompt);
          const completion = toNumber(p.completion);
          if (prompt !== null && completion !== null) info.isFree = prompt === 0 && completion === 0;
        }
        out.push(info);
      }
      if (modelFilter === "name-heuristic") {
        const filtered = out.filter((m) => TTS_MODEL_HEURISTIC_RE.test(m.id));
        if (filtered.length > 0) return filtered;
      }
      return out;
    },

    async listVoices(): Promise<TtsVoiceInfo[] | null> {
      const { kind, url } = catalogRequest();
      // D22: aggregators have NO /audio/voices endpoint (404 live-verified
      // on openrouter.ai and nano-gpt.com) — the roster is PER-MODEL data
      // riding the catalog. Resolve it by the selected model: refetch the
      // catalog (cacheable upstream per NanoGPT docs), find the entry, read
      // its voice list. Null (manual input) when no model is chosen, the
      // model left the catalog, or the catalog reports none for it.
      if (kind !== "plain") {
        try {
          const response = await fetchOrWrap(
            url,
            {
              method: "GET",
              headers: buildHeaders(cfg.apiKey),
              signal: AbortSignal.timeout(TTS_VOICE_LIST_TIMEOUT_MS),
            },
            "voice list",
          );
          if (!response.ok) return null;
          const parsed: unknown = await response.json().catch(() => null);
          const data =
            typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).data : undefined;
          if (!Array.isArray(data)) return null;
          const model = readString(config, "model");
          if (model === undefined) return null;
          for (const entry of data) {
            if (typeof entry !== "object" || entry === null) continue;
            const record = entry as Record<string, unknown>;
            if (record.id !== model) continue;
            const voices = catalogEntryVoices(record, kind === "audio-models");
            if (voices === undefined) return null;
            return voices.map((voice) => ({ id: voice, label: voice, lang: "en" }));
          }
          return null;
        } catch {
          return null;
        }
      }
      try {
        const voicesResponse = await fetch(`${cfg.endpoint}/audio/voices`, {
          headers: buildHeaders(cfg.apiKey),
          signal: AbortSignal.timeout(TTS_VOICE_LIST_TIMEOUT_MS),
        });
        if (voicesResponse.ok) {
          const parsed: unknown = await voicesResponse.json().catch(() => null);
          const voices = parseVoicesPayload(parsed);
          if (voices) return voices;
        }
        return null;
      } catch {
        return null;
      }
    },

    async probe(): Promise<TtsProbeResult> {
      try {
        const response = await fetch(`${cfg.endpoint}/models`, {
          headers: buildHeaders(cfg.apiKey),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
          return { ok: false, detail: `${response.status} ${response.statusText}`.trim() };
        }
        const parsed: unknown = await response.json().catch(() => null);
        const count = countModelIds(parsed);
        return { ok: true, detail: `${count} models` };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release.
    },
  };

  return backend;
};

/** Per-model voice roster off a catalog entry (D22): OpenRouter exposes
 *  `supported_voices: string[] | null`, NanoGPT
 *  `supported_parameters.voices`. Returns undefined for absent/null/empty —
 *  the callers treat that as "no roster" (manual voice input). */
function catalogEntryVoices(record: Record<string, unknown>, useAudioModelsCatalog: boolean): string[] | undefined {
	const raw = useAudioModelsCatalog
		? typeof record.supported_parameters === "object" && record.supported_parameters !== null
			? (record.supported_parameters as Record<string, unknown>).voices
			: undefined
		: record.supported_voices;
	if (!Array.isArray(raw)) return undefined;
	const voices: string[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.length > 0) voices.push(item);
	}
	return voices.length > 0 ? voices : undefined;
}

function countModelIds(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data)) return 0;
  let count = 0;
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null) {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) count += 1;
    }
  }
  return count;
}

// Module-scope registration (protocol-registry pattern): importing this module
// makes the 'openai-compatible' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.OpenAiCompatible, openAiCompatTtsFactory);
