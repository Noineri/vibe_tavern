/**
 * @module stt/backends/deepgram-stt
 *
 * Deepgram STT adapter (STT_PROVIDER_EXPANSION SPE-4) — native batch
 * transcription on `POST /v1/listen`, NOT the OpenAI-compatible multipart
 * surface (that transport is the openai-compat backend's job).
 *
 * Doc gate (developers.deepgram.com, verified in the SPE-R wire-contract pass
 * 2026-09-05 — sources inline in STT_PROVIDER_EXPANSION_REPORT):
 * - `POST https://api.deepgram.com/v1/listen` with query params; the audio
 *   rides the request BODY as raw bytes with its own MIME as Content-Type
 *   (their own examples send audio/wav; 100+ formats accepted, 2 GB cap —
 *   nothing binding for dictation clips);
 * - auth is `Authorization: Token <API_KEY>` — the same scheme the repo's
 *   Deepgram TTS adapter pins (`Bearer` JWTs exist but are a client flow we
 *   do not need);
 * - param set for dictation: `model` (nova-3 default — RU-capable since the
 *   2025-11 monolingual wave) + `smart_format=true` (punctuation/
 *   capitalization/number formatting in one documented switch);
 *   `language` (BCP-47) is appended when the profile carries a hint;
 * - response transcript: `results.channels[].alternatives[].transcript` —
 *   mono dictation audio yields exactly one channel, but a stereo file
 *   produces one per channel, so non-empty channel transcripts join with a
 *   space;
 * - errors are JSON `{err_code, err_msg, request_id}` (e.g. 422
 *   ASR_UNPROCESSABLE_ENTITY) — surfaced as `err_code: err_msg` when both
 *   parse, else the raw body excerpt;
 * - model discovery: `GET /v1/models` → `{stt: [...], tts: [...]}` where the
 *   `stt` array IS the transcription roster (the same catalog call the TTS
 *   backend parses on the `tts` side); the picker id is `canonical_name`
 *   (the documented `model` param value, e.g. "nova-3"), with `name` as
 *   fallback for entries that omit it.
 *
 * Config bag (loose, house style — the ST-5a boundary cast): `model`
 * (free text; DEFAULT_DEEPGRAM_STT_MODEL fallback), `language?`, plus the
 * adapter-injected `apiKey` (the typed column value, never stored in config).
 */

import { DEFAULT_DEEPGRAM_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileConfig } from "@vibe-tavern/domain";

import type {
  SttBackend,
  SttBackendFactory,
  SttModelInfo,
  SttProbeResult,
  SttTranscribeResult,
} from "../stt-backend.js";
import { registerSttBackend } from "../stt-registry.js";

const DEEPGRAM_BASE_URL = "https://api.deepgram.com";

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** HTTP / transport failure of a transcription or probe request. */
export class DeepgramSttError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, timeout). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "DeepgramSttError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing API key). */
export class DeepgramSttConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepgramSttConfigError";
  }
}

// ─── Config accessors (loose config bag, house style) ───────────────────────

interface DeepgramSttConfig {
  apiKey: string;
  model: string;
  language?: string;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseConfig(config: SttProfileConfig): DeepgramSttConfig {
  // The factory reads the adapter-injected apiKey off the loose bag
  // (ST-5a boundary cast — no `as any`).
  const bag = config as Record<string, unknown>;
  const apiKey = readString(bag, "apiKey");
  if (!apiKey) {
    throw new DeepgramSttConfigError(
      "Deepgram STT config error: `apiKey` is required (own key or auto-key reuse from a Deepgram TTS profile)",
    );
  }
  const parsed: DeepgramSttConfig = {
    apiKey,
    model: readString(bag, "model") ?? DEFAULT_DEEPGRAM_STT_MODEL,
  };
  const language = readString(bag, "language");
  if (language !== undefined) parsed.language = language;
  return parsed;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Read the failure body: Deepgram errors are `{err_code, err_msg,
 *  request_id}`, so the parsed pair is preferred over a raw excerpt. */
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
      const record = parsed as Record<string, unknown>;
      const errCode = record.err_code;
      const errMsg = record.err_msg;
      if (typeof errCode === "string" && typeof errMsg === "string") {
        const requestId = typeof record.request_id === "string" ? ` (request ${record.request_id})` : "";
        return `${errCode}: ${errMsg}${requestId}`;
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
    throw new DeepgramSttError(
      `Deepgram STT ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Extract the transcript from a `/v1/listen` response. Mono dictation audio
 *  yields `channels[0].alternatives[0].transcript`; a stereo file produces
 *  one channel per track, so non-empty channel transcripts join with a
 *  space. Defensive against missing containers ("" — the caller decides
 *  whether an empty transcript is an error). Exported for tests. */
export function extractListenTranscript(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const results = (payload as Record<string, unknown>).results;
  if (typeof results !== "object" || results === null) return "";
  const channels = (results as Record<string, unknown>).channels;
  if (!Array.isArray(channels)) return "";
  const parts: string[] = [];
  for (const channel of channels) {
    if (typeof channel !== "object" || channel === null) continue;
    const alternatives = (channel as Record<string, unknown>).alternatives;
    if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
    const first = alternatives[0];
    if (typeof first !== "object" || first === null) continue;
    const transcript = (first as Record<string, unknown>).transcript;
    if (typeof transcript === "string" && transcript.trim() !== "") {
      parts.push(transcript.trim());
    }
  }
  return parts.join(" ");
}

/** Count the `stt[]` entries of a `/v1/models` payload (probe detail). */
function countSttModels(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const stt = (parsed as Record<string, unknown>).stt;
  return Array.isArray(stt) ? stt.length : 0;
}

/** Parse the `/v1/models` catalogue into STT pickable entries (P8 rule: a
 *  fetched picker for every listable backend). The response's own `stt`
 *  array IS the transcription roster — no family filtering needed (unlike
 *  the Gemini chat-catalog parser). The picker id is `canonical_name` (the
 *  documented `model` param value, "nova-3"); `name` (a display label like
 *  "2ea-nova-3") is the fallback for entries that omit it, and the label is
 *  the same string — Deepgram has no per-model metadata worth showing. */
function parseSttModels(parsed: unknown): SttModelInfo[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const stt = (parsed as Record<string, unknown>).stt;
  if (!Array.isArray(stt)) return [];
  const out: SttModelInfo[] = [];
  for (const entry of stt) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const canonicalName = record.canonical_name;
    const name = record.name;
    const id =
      typeof canonicalName === "string" && canonicalName.trim() !== ""
        ? canonicalName.trim()
        : typeof name === "string" && name.trim() !== ""
          ? name.trim()
          : "";
    if (id.length === 0) continue;
    out.push({ id, label: id });
  }
  return out;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Build the `/v1/listen` URL: model (always), smart_format (the documented
 *  dictation formatting set — punctuation, capitalization, number format),
 *  language (BCP-47, only when the profile carries a hint; nova-3 defaults
 *  to its own language roster otherwise). */
function buildListenUrl(cfg: DeepgramSttConfig): string {
  const url = new URL(`${DEEPGRAM_BASE_URL}/v1/listen`);
  url.searchParams.set("model", cfg.model);
  url.searchParams.set("smart_format", "true");
  if (cfg.language !== undefined) url.searchParams.set("language", cfg.language);
  return url.toString();
}

export const deepgramSttFactory: SttBackendFactory = (config) => {
  const cfg = parseConfig(config);

  const backend: SttBackend = {
    async transcribe(audio, options): Promise<SttTranscribeResult> {
      // Blob (the typed BodyInit carrier for raw bytes) — built from a pure
      // ArrayBuffer so no ArrayBufferLike/SharedArrayBuffer variance slips
      // into BlobPart (the Buffer branch copies once; dictation clips are
      // small, and the multipart path always arrives as a Buffer anyway).
      const blob =
        audio instanceof ArrayBuffer
          ? new Blob([audio], { type: options.mime })
          : new Blob([new Uint8Array(audio).buffer], { type: options.mime });
      const response = await fetchOrWrap(
        buildListenUrl(cfg),
        {
          method: "POST",
          headers: {
            Authorization: `Token ${cfg.apiKey}`,
            "Content-Type": options.mime,
          },
          body: blob,
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        },
        "transcribe",
      );

      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new DeepgramSttError(
          `Deepgram STT transcription failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      return { text: extractListenTranscript(payload) };
    },

    async listModels(): Promise<SttModelInfo[]> {
      // Same catalogue the probe counts; parseSttModels maps the stt[] roster.
      const response = await fetchOrWrap(
        `${DEEPGRAM_BASE_URL}/v1/models`,
        {
          headers: { Authorization: `Token ${cfg.apiKey}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new DeepgramSttError(
          `Deepgram STT model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      return parseSttModels(payload);
    },

    async probe(): Promise<SttProbeResult> {
      try {
        const response = await fetch(`${DEEPGRAM_BASE_URL}/v1/models`, {
          headers: { Authorization: `Token ${cfg.apiKey}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
          const excerpt = await readErrorExcerpt(response);
          return { ok: false, detail: `${response.status}${excerpt ? `: ${excerpt.slice(0, 120)}` : ""}` };
        }
        const parsed: unknown = await response.json().catch(() => null);
        return { ok: true, detail: `${countSttModels(parsed)} models` };
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
// makes the 'deepgram' STT slug creatable via the STT registry.
registerSttBackend(STT_BACKENDS.Deepgram, deepgramSttFactory);
