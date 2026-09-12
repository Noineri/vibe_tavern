/**
 * @module stt/backends/nvidia-stt
 *
 * NVIDIA hosted omni STT adapter (STT_PROVIDER_EXPANSION SPE-6) — batch
 * transcription through the chat-completions audio-understanding surface,
 * NOT the OpenAI transcription protocol and NOT the dead hosted
 * `/v1/audio/transcriptions` path.
 *
 * Doc gate (owner-supplied reference page, re-verified in the SPE-R
 * wire-contract pass 2026-09-05 — sources inline in
 * STT_PROVIDER_EXPANSION_REPORT):
 * - `POST https://integrate.api.nvidia.com/v1/chat/completions`,
 *   `Authorization: Bearer nvapi-…` — the standard NIM chat surface;
 * - audio rides a content part `{"type":"audio_url","audio_url":{"url":
 *   "data:<mime>;base64,…"}}` (their example's file:// URI is an OpenAI-SDK
 *   client convention that resolves to this data URI — we produce it
 *   directly), plus a text part "Transcribe this audio.";
 * - decoding knobs from the reference example: `max_tokens: 1024`,
 *   `temperature: 1.0`, `top_k: 1`, `chat_template_kwargs: {enable_thinking:
 *   false}` (the omni model is a reasoning hybrid — the flag keeps the reply
 *   a bare transcript);
 * - transcript = `choices[0].message.content`; a defensive `</think>`-suffix
 *  strip guards a thinking block slipping through despite the flag;
 * - audio: wav/mp3 up to 1 h, 8 kHz+ sampling — the 16 kHz mono WAV
 *   recorder output qualifies;
 * - **Language support: English only** (documented on the model card) —
 *   useless for RU dictation, built for roster completeness per the owner's
 *   decision (the EN-only UI hint lands with the preset in SPE-7);
 * - no STT model discovery: the hosted `/v1/models` catalog (81 chat models
 *   at the SPE-R probe) does not mark audio capability, so the usable roster
 *   is the static omni list — `listModels` is deliberately not implemented;
 *   probe = the catalog call itself (auth check, no credits spent).
 *
 * Config bag (loose, house style — the ST-5a boundary cast): `model`
 * (free text; DEFAULT_NVIDIA_STT_MODEL fallback), `language?` (accepted for
 * roster symmetry but UNUSED — the omni model is EN-only; the profile
 * picker/SPE-7 hint is the real guard), plus the adapter-injected `apiKey`.
 */

import { DEFAULT_NVIDIA_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileConfig } from "@vibe-tavern/domain";

import type {
  SttBackend,
  SttBackendFactory,
  SttProbeResult,
  SttTranscribeResult,
} from "../stt-backend.js";
import { registerSttBackend } from "../stt-registry.js";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com";
const CHAT_COMPLETIONS_URL = `${NVIDIA_BASE_URL}/v1/chat/completions`;
const MODELS_URL = `${NVIDIA_BASE_URL}/v1/models`;

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** The reference example's instruction — kept verbatim (the model is
 *  instruction-tuned around this exact phrasing). */
const TRANSCRIBE_INSTRUCTION = "Transcribe this audio.";

/** max_tokens from the reference example — a dictation clip needs far less,
 *  and the transcript arrives without commentary at this ceiling. */
const MAX_TOKENS = 1024;

/** HTTP / transport failure of a transcription or probe request. */
export class NvidiaSttError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, timeout). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "NvidiaSttError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing API key). */
export class NvidiaSttConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NvidiaSttConfigError";
  }
}

// ─── Config accessors (loose config bag, house style) ───────────────────────

interface NvidiaSttConfig {
  apiKey: string;
  model: string;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseConfig(config: SttProfileConfig): NvidiaSttConfig {
  // The factory reads the adapter-injected apiKey off the loose bag
  // (ST-5a boundary cast — no `as any`).
  const bag = config as Record<string, unknown>;
  const apiKey = readString(bag, "apiKey");
  if (!apiKey) {
    throw new NvidiaSttConfigError(
      "NVIDIA STT config error: `apiKey` is required (own key or auto-key reuse from a provider on the NVIDIA host)",
    );
  }
  return {
    apiKey,
    model: readString(bag, "model") ?? DEFAULT_NVIDIA_STT_MODEL,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Read the failure body: NIM errors are OpenAI-style `{"error": {"message"}}`
 *  (sometimes a bare `detail`) — the parsed message is preferred over a raw
 *  excerpt. */
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
      const error = record.error;
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim() !== "") return message.trim();
      }
      if (typeof record.detail === "string" && record.detail.trim() !== "") {
        return record.detail.trim();
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
    throw new NvidiaSttError(
      `NVIDIA STT ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Strip MIME parameters ("audio/wav;codecs=..." → "audio/wav") for the
 *  data-URI prefix. */
function normalizeMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** Extract the transcript from a chat-completions reply:
 *  `choices[0].message.content`. Defensive against a reasoning block that
 *  slips through despite `enable_thinking: false` — everything up to and
 *  including a `</think>` close tag is dropped. Exported for tests. */
export function extractChatTranscript(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (typeof first !== "object" || first === null) return "";
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") return "";
  const closeIndex = content.lastIndexOf("</think>");
  return (closeIndex === -1 ? content : content.slice(closeIndex + "</think>".length)).trim();
}

/** Count the models of a `/v1/models` payload (probe detail — the full chat
 *  catalog, not an STT roster; see the module note). */
function countModels(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const data = (parsed as Record<string, unknown>).data;
  return Array.isArray(data) ? data.length : 0;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const nvidiaSttFactory: SttBackendFactory = (config) => {
  const cfg = parseConfig(config);

  const backend: SttBackend = {
    async transcribe(audio, options): Promise<SttTranscribeResult> {
      const bytes =
        audio instanceof ArrayBuffer
          ? new Uint8Array(audio)
          : new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      const mime = normalizeMime(options.mime);
      const response = await fetchOrWrap(
        CHAT_COMPLETIONS_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "audio_url",
                    audio_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` },
                  },
                  { type: "text", text: TRANSCRIBE_INSTRUCTION },
                ],
              },
            ],
            // The reference example's decoding set — enable_thinking false
            // keeps the omni hybrid's reply a bare transcript.
            max_tokens: MAX_TOKENS,
            temperature: 1.0,
            top_k: 1,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        },
        "transcribe",
      );

      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new NvidiaSttError(
          `NVIDIA STT transcription failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      return { text: extractChatTranscript(payload) };
    },

    async probe(): Promise<SttProbeResult> {
      // The hosted chat catalog doubles as the auth check (no credits
      // spent). It is NOT an STT roster — the usable models are the static
      // omni list (see the module note).
      try {
        const response = await fetch(MODELS_URL, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
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
        return { ok: true, detail: `${countModels(parsed)} models (catalog ok)` };
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
// makes the 'nvidia' STT slug creatable via the STT registry.
registerSttBackend(STT_BACKENDS.Nvidia, nvidiaSttFactory);
