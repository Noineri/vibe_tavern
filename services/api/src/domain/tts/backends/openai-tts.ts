/**
 * @module tts/backends/openai-tts
 *
 * OpenAI-compatible TTS adapter (TTS_PLAN TS-4) — ONE adapter for any server
 * speaking the OpenAI speech protocol: OpenAI cloud, OpenRouter, and local
 * servers (kokoro-fastapi :8880, openedai-tts :8000, …). The endpoint is the
 * base URL INCLUDING `/v1` (house `normalizeOpenAiCompatibleBaseUrl` also
 * tolerates a trailing slash or a pasted `/chat/completions` suffix).
 *
 * API facts (verified 2026-08-27):
 * - POST {endpoint}/audio/speech, body { model, input, voice, response_format,
 *   speed? } (snake_case). `Authorization: Bearer` ONLY when a key is set —
 *   local servers run keyless. `instructions` is OpenAI-specific and works
 *   ONLY on gpt-4o-mini-tts* models (rejected/ignored on tts-1 family), so it
 *   is included only for that model family.
 * - Voices: kokoro-fastapi exposes GET /v1/audio/voices → { voices: [{ id, name? }] };
 *   OpenAI's canonical list endpoint is GET /v1/models → { data: [{ id }] }.
 *   Voice listing falls back voices→models→static OpenAI roster so a cloud
 *   endpoint always yields a usable list even offline.
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

/** OpenAI /v1/models shape: { data: [{ id }] }. */
function parseModelsAsVoices(parsed: unknown): TtsVoiceInfo[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  const voices: TtsVoiceInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const voice = toVoiceInfo((entry as Record<string, unknown>).id, undefined);
    if (voice) voices.push(voice);
  }
  return voices.length > 0 ? voices : null;
}

/** Static roster so api.openai.com-style endpoints always list something. */
function staticRosterVoices(): TtsVoiceInfo[] {
  return VOICES_GPT4O_MINI_TTS.map((id) => ({ id, label: id, lang: "en" }));
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const openAiCompatTtsFactory: TtsBackendFactory = (config) => {
  const cfg = parseConfig(config);

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
      const response = await fetchOrWrap(
        `${cfg.endpoint}/models`,
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
      const data = (parsed as Record<string, unknown>).data;
      if (!Array.isArray(data)) return [];
      const out: import("../tts-backend.js").TtsModelInfo[] = [];
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) continue;
        const id = (entry as Record<string, unknown>).id;
        if (typeof id !== "string" || id.length === 0) continue;
        out.push({ id, label: id });
      }
      return out;
    },

    async listVoices(): Promise<TtsVoiceInfo[]> {
      // Never throws for unreachable servers: voices → models → static roster.
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
      } catch {
        // Unreachable → fall through to the models endpoint.
      }

      try {
        const modelsResponse = await fetch(`${cfg.endpoint}/models`, {
          headers: buildHeaders(cfg.apiKey),
          signal: AbortSignal.timeout(TTS_VOICE_LIST_TIMEOUT_MS),
        });
        if (modelsResponse.ok) {
          const parsed: unknown = await modelsResponse.json().catch(() => null);
          const voices = parseModelsAsVoices(parsed);
          if (voices) return voices;
        }
      } catch {
        // Unreachable → fall through to the static roster.
      }

      return staticRosterVoices();
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
