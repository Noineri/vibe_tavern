/**
 * @module stt/backends/elevenlabs-stt
 *
 * ElevenLabs Scribe STT adapter (STT_PROVIDER_EXPANSION SPE-5) — native
 * batch speech-to-text on `POST /v1/speech-to-text`, NOT the OpenAI-compatible
 * multipart surface.
 *
 * Doc gate (api-reference pages via llms.txt, verified in the SPE-R
 * wire-contract pass 2026-09-05 — sources inline in
 * STT_PROVIDER_EXPANSION_REPORT):
 * - `POST https://api.elevenlabs.io/v1/speech-to-text` with the
 *   `xi-api-key` header (the same auth scheme the repo's ElevenLabs TTS
 *   adapter pins) and a multipart body;
 * - form fields: `file` (the audio; WAV is first in the documented format
 *   list, and the dictation recorder produces exactly 16 kHz mono WAV),
 *   `model_id` (required — scribe_v2), `language_code` (ISO-639-1 or
 *   ISO-639-3, OPTIONAL: null/omitted = auto-detect; RU is "rus" among the
 *   90+ documented languages). Diarize/tag_audio_events/keyterms are out of
 *   scope for dictation (no speaker labels in the input box);
 * - response: `{language_code, language_probability, text, words[…]}` — the
 *   transcript is `text`, the detected language echoes back as
 *   `language_code` (mapped into the result so the dictation wire can show
 *   it);
 * - caps (3 GB / 10 h per file, auto-scaling concurrency) are irrelevant for
 *   dictation clips;
 * - errors: `{"detail": {"status", "message"}}` (or a bare string detail) —
 *   surfaced as `status: message` when both parse, else the raw excerpt;
 * - NO model discovery endpoint: `/v1/models` is the TTS catalog; the Scribe
 *   roster ships as the static preset list (SPE-7), so `listModels` is
 *   deliberately not implemented. The probe mirrors the TTS adapter's
 *   `GET /v1/voices` auth check (account-scope, no credits spent).
 *
 * Config bag (loose, house style — the ST-5a boundary cast): `model`
 * (free text; DEFAULT_ELEVENLABS_STT_MODEL fallback), `language?`, plus the
 * adapter-injected `apiKey` (the typed column value, never stored in config).
 */

import { DEFAULT_ELEVENLABS_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileConfig } from "@vibe-tavern/domain";

import type {
  SttBackend,
  SttBackendFactory,
  SttProbeResult,
  SttTranscribeResult,
} from "../stt-backend.js";
import { registerSttBackend } from "../stt-registry.js";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const TRANSCRIBE_URL = `${ELEVENLABS_BASE_URL}/v1/speech-to-text`;
const VOICES_URL = `${ELEVENLABS_BASE_URL}/v1/voices`;

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** HTTP / transport failure of a transcription or probe request. */
export class ElevenLabsSttError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, timeout). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "ElevenLabsSttError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing API key). */
export class ElevenLabsSttConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsSttConfigError";
  }
}

// ─── Config accessors (loose config bag, house style) ───────────────────────

interface ElevenLabsSttConfig {
  apiKey: string;
  model: string;
  language?: string;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseConfig(config: SttProfileConfig): ElevenLabsSttConfig {
  // The factory reads the adapter-injected apiKey off the loose bag
  // (ST-5a boundary cast — no `as any`).
  const bag = config as Record<string, unknown>;
  const apiKey = readString(bag, "apiKey");
  if (!apiKey) {
    throw new ElevenLabsSttConfigError(
      "ElevenLabs STT config error: `apiKey` is required (own key or auto-key reuse from an ElevenLabs TTS profile)",
    );
  }
  const parsed: ElevenLabsSttConfig = {
    apiKey,
    model: readString(bag, "model") ?? DEFAULT_ELEVENLABS_STT_MODEL,
  };
  const language = readString(bag, "language");
  if (language !== undefined) parsed.language = language;
  return parsed;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Read the failure body: ElevenLabs errors are `{"detail": {"status",
 *  "message"}}` (or a bare string detail) — the parsed pair is preferred
 *  over a raw excerpt. */
async function readErrorExcerpt(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "(unreadable error body)";
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const detail = (parsed as Record<string, unknown>).detail;
      if (typeof detail === "object" && detail !== null) {
        const status = (detail as Record<string, unknown>).status;
        const message = (detail as Record<string, unknown>).message;
        if (typeof status === "string" && typeof message === "string") {
          return `${status}: ${message}`;
        }
      }
      if (typeof detail === "string" && detail.trim() !== "") {
        return detail.trim();
      }
    }
  } catch {
    // Non-JSON body — fall through to the raw excerpt.
  }
  return text.length > ERROR_BODY_EXCERPT_LENGTH
    ? `${text.slice(0, ERROR_BODY_EXCERPT_LENGTH)}…`
    : text;
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
    throw new ElevenLabsSttError(
      `ElevenLabs STT ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Filename extension for the multipart `file` field. ElevenLabs detects the
 *  container from the payload, but a real filename keeps the field honest;
 *  the dictation recorder's audio/wav maps to ".wav". */
function mimeExtension(mime: string): string {
  const subtype = mime.split(";")[0].trim().toLowerCase().split("/")[1] ?? "";
  if (subtype === "x-wav") return "wav";
  if (subtype === "mpeg" || subtype === "mp3") return "mp3";
  if (subtype === "x-m4a") return "m4a";
  if (subtype === "opus") return "ogg";
  if (subtype === "x-flac") return "flac";
  return subtype.length > 0 ? subtype : "bin";
}

/** Extract the transcript + detected language from a speech-to-text
 *  response: `{language_code, language_probability, text, words[…]}`.
 *  Defensive against missing containers ("" — the caller decides whether an
 *  empty transcript is an error). Exported for tests. */
export function extractSpeechToText(payload: unknown): SttTranscribeResult {
  if (typeof payload !== "object" || payload === null) return { text: "" };
  const record = payload as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  const result: SttTranscribeResult = { text };
  const language = record.language_code;
  if (typeof language === "string" && language.trim() !== "") {
    result.language = language.trim();
  }
  return result;
}

/** Count the voices of a `/v1/voices` payload (probe detail — the same
 *  account-scope check the TTS adapter's probe runs). */
function countVoices(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const voices = (parsed as Record<string, unknown>).voices;
  return Array.isArray(voices) ? voices.length : 0;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Build the multipart body: `file` (raw bytes under a MIME-honest
 *  filename), `model_id` (always), `language_code` (only when the profile
 *  carries a hint — omitted means ElevenLabs' own auto-detect). */
function buildFormData(
  cfg: ElevenLabsSttConfig,
  audio: Buffer | ArrayBuffer,
  mime: string,
): FormData {
  const blob =
    audio instanceof ArrayBuffer
      ? new Blob([audio], { type: mime })
      : new Blob([new Uint8Array(audio).buffer], { type: mime });
  const form = new FormData();
  form.append("file", blob, `audio.${mimeExtension(mime)}`);
  form.append("model_id", cfg.model);
  if (cfg.language !== undefined) form.append("language_code", cfg.language);
  return form;
}

export const elevenlabsSttFactory: SttBackendFactory = (config) => {
  const cfg = parseConfig(config);

  const backend: SttBackend = {
    async transcribe(audio, options): Promise<SttTranscribeResult> {
      const response = await fetchOrWrap(
        TRANSCRIBE_URL,
        {
          method: "POST",
          // xi-api-key — the documented auth header (Bearer is NOT
          // accepted here); Content-Type is set by the FormData boundary.
          headers: { "xi-api-key": cfg.apiKey },
          body: buildFormData(cfg, audio, options.mime),
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        },
        "transcribe",
      );

      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new ElevenLabsSttError(
          `ElevenLabs STT transcription failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      return extractSpeechToText(payload);
    },

    async probe(): Promise<SttProbeResult> {
      // The TTS twin's auth check: /v1/voices is account-scope and costs no
      // credits. There is no STT-specific discovery endpoint (the Scribe
      // roster is static — see the module note).
      try {
        const response = await fetch(VOICES_URL, {
          headers: { "xi-api-key": cfg.apiKey },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
          const excerpt = await readErrorExcerpt(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt.slice(0, 120)}` : ""}`,
            status: response.status,
          };
        }
        const parsed: unknown = await response.json().catch(() => null);
        return { ok: true, detail: `${countVoices(parsed)} voices (account ok)` };
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

// Module-scope registration (protocol-registry pattern): importing this module
// makes the 'elevenlabs' STT slug creatable via the STT registry.
registerSttBackend(STT_BACKENDS.ElevenLabs, elevenlabsSttFactory);
