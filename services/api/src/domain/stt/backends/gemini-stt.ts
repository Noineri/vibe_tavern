/**
 * @module stt/backends/gemini-stt
 *
 * Gemini STT adapter (STT_PLAN ST-7) — batch audio UNDERSTANDING, not just
 * ASR: transcript plus an optional tone/emotion annotation in ONE pass over
 * the clip. Talks to the Interactions REST surface (`POST /v1beta/interactions`)
 * — the same transport as the repo's Gemini TTS adapter — with inline
 * base64 audio, NOT the Live websocket (explicitly out of scope).
 *
 * Doc gate (ai.google.dev/gemini-api/docs/audio, checked 2026-09-02):
 * - audio understanding is documented on the Interactions surface; inline
 *   audio rides `input: [{ type: "audio", data: <base64>, mime_type }]`
 *   (≤ 20 MB total request);
 * - supported MIME types include `audio/webm` and `audio/opus` — the
 *   browser recorder's webm/opus output needs NO transcoding;
 * - structured output rides `response_format` (a JSON schema) — the docs'
 *   own transcription example annotates emotion this way, exactly our case;
 * - the key travels in the `x-goog-api-key` header (an `Authorization:
 *   Bearer` header is rejected with API_KEY_SERVICE_BLOCKED — same rule the
 *   TTS adapter pinned).
 *
 * Response text extraction mirrors the repo's own Interactions parsing
 * (`steps[].model_output.content[].text`), with defensive fallbacks to the
 * legacy `candidates[0].content.parts[].text` and an `output` array — the
 * same three containers the TTS adapter's findAudioBlock scans.
 *
 * Config bag (loose, house style — the ST-5a boundary cast): `model`
 * (free text; DEFAULT_GEMINI_STT_MODEL fallback), `language?`, plus two
 * adapter-injected fields: `apiKey` (the typed column value, never stored in
 * config) and `emotionAnnotation` (the ST-7 profile toggle — when false the
 * request carries no response_format and the reply is the plain transcript).
 */

import { DEFAULT_GEMINI_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileConfig } from "@vibe-tavern/domain";

import type {
  SttBackend,
  SttBackendFactory,
  SttProbeResult,
  SttTranscribeResult,
} from "../stt-backend.js";
import { registerSttBackend } from "../stt-registry.js";

const INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** HTTP / transport failure of a transcription or probe request. */
export class GeminiSttError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, timeout). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "GeminiSttError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing API key). */
export class GeminiSttConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiSttConfigError";
  }
}

// ─── Config accessors (loose config bag, house style) ───────────────────────

interface GeminiSttConfig {
  apiKey: string;
  model: string;
  language?: string;
  emotionAnnotation: boolean;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseConfig(config: SttProfileConfig): GeminiSttConfig {
  // The factory reads the adapter-injected apiKey + emotionAnnotation off
  // the loose bag (ST-5a boundary cast — no `as any`).
  const bag = config as Record<string, unknown>;
  const apiKey = readString(bag, "apiKey");
  if (!apiKey) {
    throw new GeminiSttConfigError(
      "Gemini STT config error: `apiKey` is required (own key or auto-key reuse)",
    );
  }
  const parsed: GeminiSttConfig = {
    apiKey,
    model: readString(bag, "model") ?? DEFAULT_GEMINI_STT_MODEL,
    emotionAnnotation: bag.emotionAnnotation === true,
  };
  const language = readString(bag, "language");
  if (language !== undefined) parsed.language = language;
  return parsed;
}

/** Strip MIME parameters ("audio/webm;codecs=opus" → "audio/webm") — the
 *  docs list bare base MIME types. */
function normalizeMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
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
    throw new GeminiSttError(
      `Gemini STT ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Extract the model's text from an Interactions response. Primary shape is
 *  the repo's own Interactions parsing (`steps[].model_output.content[].text`);
 *  the fallbacks scan the legacy `candidates` container and a bare `output`
 *  array — the same three containers the TTS adapter's findAudioBlock scans
 *  (the raw shapes are not fully pinned by the docs). */
export function extractInteractionText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;

  const parts: string[] = [];

  const steps = record.steps;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (typeof step !== "object" || step === null) continue;
      const s = step as Record<string, unknown>;
      if (s.type !== undefined && s.type !== "model_output") continue;
      const content = s.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
      }
    }
  }
  if (parts.length > 0) return parts.join("");

  const candidates = record.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0];
    if (typeof first === "object" && first !== null) {
      const content = (first as Record<string, unknown>).content;
      if (typeof content === "object" && content !== null) {
        const inner = (content as Record<string, unknown>).parts;
        if (Array.isArray(inner)) {
          for (const block of inner) {
            if (typeof block === "object" && block !== null) {
              const text = (block as Record<string, unknown>).text;
              if (typeof text === "string") parts.push(text);
            }
          }
        }
      }
    }
  }
  if (parts.length > 0) return parts.join("");

  const output = record.output;
  if (Array.isArray(output)) {
    for (const block of output) {
      if (typeof block === "object" && block !== null) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("");
}

function countModels(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const models = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(models)) return 0;
  return models.length;
}

// ─── Prompt + response_format (ST-7: transcript + tone in one pass) ─────────

/** response_format for the emotion-annotated pass — the docs' transcription
 *  pattern (structured output) applied to our two fields. The tone phrase
 *  mirrors the speech language, so the bracketed prompt line reads naturally
 *  in the roleplay. */
const TRANSCRIBE_WITH_TONE_FORMAT = {
  type: "object",
  properties: {
    transcript: { type: "string" },
    tone: { type: "string" },
  },
  required: ["transcript", "tone"],
} as const;

function buildPrompt(cfg: GeminiSttConfig): string {
  const lines: string[] = [];
  if (cfg.emotionAnnotation) {
    lines.push(
      "Transcribe the attached voice message verbatim, exactly as spoken — do not translate, do not add punctuation commentary.",
      "Describe the speaker's tone of voice as a short phrase (e.g. trembling, hurried, calm, teasing, choked-up) IN THE SAME LANGUAGE as the speech.",
    );
  } else {
    lines.push(
      "Transcribe the attached voice message verbatim, exactly as spoken — do not translate, do not add commentary.",
    );
  }
  if (cfg.language !== undefined) {
    lines.push(`The speech is expected to be in: ${cfg.language}.`);
  }
  return lines.join(" ");
}

/** Parse the emotion-annotated JSON reply. Tolerates a model wrapping the
 *  JSON in code fences; a tone that comes back empty is treated as absent. */
function parseTranscriptWithTone(raw: string): SttTranscribeResult {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // The schema-violating reply degrades to the raw text as the transcript —
    // an honest transcript without an annotation beats a hard failure.
    return { text: raw.trim() };
  }
  if (typeof parsed !== "object" || parsed === null) return { text: raw.trim() };
  const record = parsed as Record<string, unknown>;
  const transcript = typeof record.transcript === "string" ? record.transcript : "";
  const result: SttTranscribeResult = { text: transcript.trim() };
  if (typeof record.tone === "string" && record.tone.trim() !== "") {
    result.annotation = record.tone.trim();
  }
  return result;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const geminiSttFactory: SttBackendFactory = (config) => {
  const cfg = parseConfig(config);

  const backend: SttBackend = {
    async transcribe(audio, options): Promise<SttTranscribeResult> {
      const bytes = audio instanceof ArrayBuffer ? new Uint8Array(audio) : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      const mime = normalizeMime(options.mime);
      const response = await fetchOrWrap(
        INTERACTIONS_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": cfg.apiKey,
          },
          body: JSON.stringify({
            model: cfg.model,
            input: [
              { type: "text", text: buildPrompt(cfg) },
              { type: "audio", data: Buffer.from(bytes).toString("base64"), mime_type: mime },
            ],
            ...(cfg.emotionAnnotation ? { response_format: TRANSCRIBE_WITH_TONE_FORMAT } : {}),
          }),
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        },
        "transcribe",
      );

      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new GeminiSttError(
          `Gemini STT transcription failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const text = extractInteractionText(payload).trim();
      if (cfg.emotionAnnotation) return parseTranscriptWithTone(text);
      return { text };
    },

    async probe(): Promise<SttProbeResult> {
      try {
        const response = await fetch(MODELS_URL, {
          headers: { "x-goog-api-key": cfg.apiKey },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
          const excerpt = await readErrorExcerpt(response);
          return { ok: false, detail: `${response.status}${excerpt ? `: ${excerpt.slice(0, 120)}` : ""}` };
        }
        const parsed: unknown = await response.json().catch(() => null);
        return { ok: true, detail: `${countModels(parsed)} models` };
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
// makes the 'gemini' STT slug creatable via the STT registry.
registerSttBackend(STT_BACKENDS.Gemini, geminiSttFactory);
