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
 *   any failure — no fallback to /models. Documented hosts (F8) resolve
 *   their per-model rosters from the static DOCUMENTED_MODELS table below
 *   instead (no network); aggregator catalogs carry the roster per entry.
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

/** Known aggregator that hides speech models behind the
 *  `output_modalities` query param: the unfiltered catalog is 300+
 *  chat-only models with none of the TTS ones (verified live — the
 *  speech-filtered request returns them, the plain one does not).
 *  Host-based detection heals profiles saved before the preset began
 *  stamping `modelFilter` into the config bag. */
const MODALITY_FILTER_HOSTS = new Set(["openrouter.ai"]);

function hostnameOf(endpoint: string): string | null {
  try {
    return new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isOpenRouterStyleEndpoint(endpoint: string): boolean {
  const host = hostnameOf(endpoint);
  return host !== null && MODALITY_FILTER_HOSTS.has(host);
}

/** NanoGPT serves TTS discovery from a DEDICATED catalog: GET
 *  /audio-models?type=tts&detailed=true (docs: /api-reference/endpoint/
 *  audio-models). The plain /models catalog is chat-only and silently
 *  ignores output_modalities — verified live 2026-08-29 (D23). Host-based
 *  detection heals profiles saved before the preset stamped `modelFilter:
 *  "audio-models"`. */
const AUDIO_MODELS_HOSTS = new Set(["nano-gpt.com"]);

function isNanoGptStyleEndpoint(endpoint: string): boolean {
  const host = hostnameOf(endpoint);
  return host !== null && AUDIO_MODELS_HOSTS.has(host);
}

// ─── Documented catalogs (F8, owner decision 2026-08-29) ─────────────────────

/** Hosts whose TTS model catalog is fully documented — discovery is a
 *  static table, no network fetch. The name-heuristic that used to filter
 *  these hosts' mixed /models lists is REMOVED (owner decision 2026-08-29,
 *  F8: known providers do not need a heuristic — their documented model
 *  and voice discovery is known from primary docs; see the F8 handoff in
 *  the plan repo for the verbatim decision).
 *  The host ALWAYS wins over legacy stamps: every pre-F8 profile on these
 *  hosts carries the preset glue `modelFilter: "name-heuristic"`, which is
 *  not a user choice (no UI edits modelFilter) — same healing rule as the
 *  nano-gpt field fix. */
const DOCUMENTED_HOSTS = new Set(["api.openai.com", "api.groq.com", "api.electronhub.ai"]);

/** SiliconFlow documents a server-side catalog filter: GET /v1/models?type=audio
 *  (docs.siliconflow.cn/en/api-reference/models/get-model-list — `type`:
 *  text/image/audio/video; `sub_type` has no text-to-speech option). */
const AUDIO_TYPE_HOSTS = new Set(["api.siliconflow.cn", "api.siliconflow.com"]);

/** One documented catalog entry: model id, its label, optional per-model
 *  voice roster (`undefined` → the picker degrades to manual voice input),
 *  and the roster language for voice labels. */
interface DocumentedModel {
  id: string;
  label: string;
  voices?: string[];
  lang?: string;
}

const OPENAI_MINI_TTS_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova",
  "sage", "shimmer", "verse", "marin", "cedar",
];
const OPENAI_TTS1_VOICES = [
  "alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer",
];
const GROQ_EN_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];
const GROQ_AR_VOICES = ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"];
const ELECTRONHUB_OPENAI_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova",
  "sage", "shimmer", "verse",
];

/** Doc-verified rosters (all read 2026-08-29, F8 handoff matrix):
 *  - OpenAI: developers.openai.com/api/docs/guides/text-to-speech — mini-tts
 *    13 voices (marin/cedar were absent from the old preset), tts-1 family 9.
 *  - Groq: console.groq.com/docs/text-to-speech — orpheus EN/AR 6+6 (playai
 *    retired; their speech reference still showing playai-tts is THEIR docs
 *    inconsistency — do not copy it).
 *  - ElectronHub: docs.electronhub.ai/api-reference/audio/speech — the three
 *    openai-family models share an 11-voice roster; elevenlabs/playai/kokoro/
 *    microsoft document partial rosters only → manual input floor. */
const DOCUMENTED_MODELS: Record<string, DocumentedModel[]> = {
  "api.openai.com": [
    { id: "gpt-4o-mini-tts", label: "gpt-4o-mini-tts", voices: OPENAI_MINI_TTS_VOICES, lang: "en" },
    { id: "tts-1", label: "tts-1", voices: OPENAI_TTS1_VOICES, lang: "en" },
    { id: "tts-1-hd", label: "tts-1-hd", voices: OPENAI_TTS1_VOICES, lang: "en" },
  ],
  "api.groq.com": [
    { id: "canopylabs/orpheus-v1-english", label: "canopylabs/orpheus-v1-english", voices: GROQ_EN_VOICES, lang: "en" },
    { id: "canopylabs/orpheus-arabic-saudi", label: "canopylabs/orpheus-arabic-saudi", voices: GROQ_AR_VOICES, lang: "ar" },
  ],
  "api.electronhub.ai": [
    { id: "gpt-4o-mini-tts", label: "gpt-4o-mini-tts", voices: ELECTRONHUB_OPENAI_VOICES, lang: "en" },
    { id: "tts-1", label: "tts-1", voices: ELECTRONHUB_OPENAI_VOICES, lang: "en" },
    { id: "tts-1-hd", label: "tts-1-hd", voices: ELECTRONHUB_OPENAI_VOICES, lang: "en" },
    { id: "elevenlabs", label: "elevenlabs" },
    { id: "playai-tts", label: "playai-tts" },
    { id: "playai-tts-arabic", label: "playai-tts-arabic" },
    { id: "kokoro-82m", label: "kokoro-82m" },
    { id: "dia-1.6b", label: "dia-1.6b" },
    { id: "melotts", label: "melotts" },
    { id: "microsoft-tts", label: "microsoft-tts" },
  ],
};

function documentedTableFor(host: string | null): DocumentedModel[] | undefined {
  return host === null ? undefined : DOCUMENTED_MODELS[host];
}

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** HTTP / transport failure of a speech or voices request. */
export class OpenAiCompatTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, timeout). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "OpenAiCompatTtsError";
    this.status = options?.status;
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

  /** Catalog selection (D15/D23/F8), shared by listModels and listVoices:
   *  DOCUMENTED/audio-type hosts ALWAYS win over legacy stamps (the F6
   * field-fix rule — old profiles carry preset-glue `name-heuristic`
   * stamps that must heal); `plain` = the ordinary OpenAI-compatible
   * /models catalog. */
  const catalogRequest = (): {
    kind: "audio-models" | "modality" | "audio-type" | "documented" | "plain";
    url: string;
  } => {
    const modelFilter = readString(config, "modelFilter");
    const host = hostnameOf(cfg.endpoint);
    // Documented hosts: the static table below is the only legitimate
    // catalog — there is no valid stamp or fetch case past it.
    if (documentedTableFor(host) !== undefined) {
      return { kind: "documented", url: "" };
    }
    // SiliconFlow: documented server-side filter beats every stamp.
    if ((host !== null && AUDIO_TYPE_HOSTS.has(host)) || modelFilter === "audio-type") {
      return { kind: "audio-type", url: `${cfg.endpoint}/models?type=audio` };
    }
    if (modelFilter === "documented" && documentedTableFor(host) !== undefined) {
      return { kind: "documented", url: "" };
    }
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
        throw new OpenAiCompatTtsError(httpErrorMessage("generate", response, excerpt), { status: response.status });
      }
      const audio = Buffer.from(await response.arrayBuffer());
      const mime = response.headers.get("content-type") ?? FALLBACK_MIME;
      return { audio, mime };
    },

    async listModels(): Promise<import("../tts-backend.js").TtsModelInfo[]> {
      const { kind, url } = catalogRequest();
      if (kind === "documented") {
        // Static table — no network, no filtering, exactly what the
        // provider documents (F8: the heuristic is gone; the picker shows
        // the documented TTS models, zero chat models).
        const table = documentedTableFor(hostnameOf(cfg.endpoint)) ?? [];
        return table.map((entry) => ({
          id: entry.id,
          label: entry.label,
          ...(entry.voices !== undefined ? { voices: entry.voices } : {}),
        }));
      }
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
        throw new OpenAiCompatTtsError(httpErrorMessage("model list", response, excerpt), { status: response.status });
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
      return out;
    },

    async listVoices(): Promise<TtsVoiceInfo[] | null> {
      const { kind, url } = catalogRequest();
      // Documented hosts: the roster is part of the static table — resolve
      // the selected model in it. No model / model left the table / entry
      // documents no roster → null (manual voice input floor).
      if (kind === "documented") {
        const table = documentedTableFor(hostnameOf(cfg.endpoint)) ?? [];
        const model = readString(config, "model");
        if (model === undefined) return null;
        const entry = table.find((m) => m.id === model);
        if (entry === undefined || entry.voices === undefined) return null;
        const lang = entry.lang ?? "en";
        return entry.voices.map((id) => ({ id, label: id, lang }));
      }
      // D22: aggregators (audio-models/modality) have NO /audio/voices
      // endpoint (404 live-verified on openrouter.ai and nano-gpt.com) —
      // the roster is PER-MODEL data riding the catalog. Resolve it by
      // the selected model: refetch the catalog (cacheable upstream per
      // NanoGPT docs), find the entry, read its voice list. Null (manual
      // input) when no model is chosen, the model left the catalog, or
      // the catalog reports none for it. audio-type (SiliconFlow) does
      // NOT take this path: its /models?type=audio entries carry no
      // roster, and SF documents no voices endpoint — it falls through
      // to the plain /audio/voices attempt, which is null → manual there
      // (wire ids are full "model:voice" strings anyway).
      if (kind === "audio-models" || kind === "modality") {
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
