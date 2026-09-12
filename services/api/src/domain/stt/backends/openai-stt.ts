/**
 * @module stt/backends/openai-stt
 *
 * OpenAI-compatible STT adapter (ST-5a) — ONE adapter for any server speaking
 * the OpenAI speech-recognition protocol: OpenAI cloud and local
 * OpenAI-compatible servers. The endpoint is the base URL INCLUDING `/v1`
 * (house `normalizeOpenAiCompatibleBaseUrl` also tolerates a trailing slash
 * or a pasted `/chat/completions` suffix). This is the first server-executable
 * SttBackend; mirror/adapter of the TTS openai-tts adapter (endpoint
 * normalization, fetch seam, timeouts, normalized errors, discover).
 *
 * API facts:
 * - POST {endpoint}/audio/transcriptions, multipart fields { file, model,
 *   language?, response_format: "json" }. `Authorization: Bearer` ONLY when
 *   a key is set — local servers run keyless. The apiKey is injected into
 *   the config bag server-side by the (ST-6+) adapter exactly like TTS
 *   injects it (the secret never rides the stored SttProfileConfig; ST-1).
 * - Live model discovery via GET {endpoint}/models?output_modalities=
 *   transcription — the STT twin of TTS's `?output_modalities=speech`.
 *   OpenAI-compatible servers either honor the modality filter or ignore it
 *   and return the full catalog; either way the response parses through the
 *   same `{data:[{id,name?,description?,pricing?}]}` / `{models:[...]}`
 *   shapes (aggregator entries carry OpenRouter-style enrichment).
 */

import { STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileConfig } from "@vibe-tavern/domain";

import type {
  SttBackend,
  SttBackendFactory,
  SttModelInfo,
  SttProbeResult,
  SttTranscribeResult,
} from "../stt-backend.js";
import { registerSttBackend } from "../stt-registry.js";
import {
  buildHeaders,
  normalizeOpenAiCompatibleBaseUrl,
} from "../../providers/provider-transport.js";

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

const DEFAULT_MODEL = "whisper-1";
const FALLBACK_EXT = "bin";

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** HTTP / transport failure of a transcription or model-list request. */
export class OpenAiCompatSttError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, timeout). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "OpenAiCompatSttError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint). */
export class OpenAiCompatSttConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiCompatSttConfigError";
  }
}

// ─── Config accessors (loose config bag, house style) ───────────────────────

interface OpenAiCompatSttConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  language?: string;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseConfig(config: SttProfileConfig): OpenAiCompatSttConfig {
  // SttProfileConfig is a strict per-backend union (ST-1); the factory reads
  // the injected apiKey off the loose bag the (ST-6+) server adapter built,
  // so cast at this type-erased boundary — no `as any`.
  const bag = config as Record<string, unknown>;
  const rawEndpoint = readString(bag, "endpoint");
  if (!rawEndpoint) {
    throw new OpenAiCompatSttConfigError(
      "OpenAI-compatible STT config error: `endpoint` is required",
    );
  }
  const endpoint = normalizeOpenAiCompatibleBaseUrl(rawEndpoint);
  if (!endpoint) {
    throw new OpenAiCompatSttConfigError(
      "OpenAI-compatible STT config error: `endpoint` is empty after normalization",
    );
  }
  const parsed: OpenAiCompatSttConfig = {
    endpoint,
    apiKey: readString(bag, "apiKey") ?? "",
    model: readString(bag, "model") ?? DEFAULT_MODEL,
  };
  const language = readString(bag, "language");
  if (language !== undefined) parsed.language = language;
  return parsed;
}

/** Map a MIME type to a usable multipart filename extension. */
function fileExtension(mime: string): string {
  if (mime.includes("mpeg")) return "mp3";
  const sub = mime.split("/")[1] ?? "";
  return sub !== "" ? sub : FALLBACK_EXT;
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
  return `OpenAI-compatible STT ${operation} failed with HTTP ${response.status}${
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
    throw new OpenAiCompatSttError(
      `OpenAI-compatible STT ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
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

// ─── Factory ─────────────────────────────────────────────────────────────────

export const openAiCompatSttFactory: SttBackendFactory = (config) => {
  const cfg = parseConfig(config);

  const backend: SttBackend = {
    async transcribe(audio, options): Promise<SttTranscribeResult> {
      const form = new FormData();
      // Buffer is a Uint8Array over an ArrayBufferLike — copy it into a fresh
      // Uint8Array so the BlobPart is backed by a real ArrayBuffer (no cast).
      const part: BlobPart = audio instanceof ArrayBuffer ? audio : new Uint8Array(audio);
      form.append("file", new Blob([part], { type: options.mime }), `audio.${fileExtension(options.mime)}`);
      form.append("model", cfg.model);
      // Language is a neutral tuning — omit when unset rather than sending an
      // empty/placeholder value (mirrors how TTS omits neutral tunings).
      if (cfg.language !== undefined) {
        form.append("language", cfg.language);
      }
      form.append("response_format", "json");

      const response = await fetchOrWrap(
        `${cfg.endpoint}/audio/transcriptions`,
        {
          method: "POST",
          // buildHeaders without withBody sets no Content-Type — fetch fills
          // in the multipart boundary itself (same as the TTS clone upload).
          headers: buildHeaders(cfg.apiKey),
          body: form,
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        },
        "transcribe",
      );

      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new OpenAiCompatSttError(
          httpErrorMessage("transcription", response, excerpt),
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      if (typeof parsed !== "object" || parsed === null) {
        throw new OpenAiCompatSttError(
          "OpenAI-compatible STT transcription response is missing a JSON body",
        );
      }
      const record = parsed as Record<string, unknown>;
      const result: SttTranscribeResult = {
        text: typeof record.text === "string" ? record.text : "",
      };
      if (typeof record.language === "string" && record.language !== "") {
        result.language = record.language;
      }
      return result;
    },

    async listModels(): Promise<SttModelInfo[]> {
      // The STT twin of the TTS modality discovery: the /models catalog
      // filtered to transcription-capable models. Servers that ignore the
      // filter simply return the full catalog — parsed through the same
      // shapes (mirrors TTS's `?output_modalities=speech` behavior).
      const response = await fetchOrWrap(
        `${cfg.endpoint}/models?output_modalities=transcription`,
        {
          method: "GET",
          headers: buildHeaders(cfg.apiKey),
          signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
        },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new OpenAiCompatSttError(httpErrorMessage("model list", response, excerpt), { status: response.status });
      }
      const parsed: unknown = await response.json().catch(() => null);
      if (typeof parsed !== "object" || parsed === null) return [];
      // OpenAI-compatible `{data:[{id}]}` and openai-edge-tts-style
      // `{models:[{id}]}` — accept either (mirrors the TTS parser).
      const record = parsed as Record<string, unknown>;
      const data = Array.isArray(record.data)
        ? record.data
        : Array.isArray(record.models)
          ? record.models
          : null;
      if (data === null) return [];
      const out: SttModelInfo[] = [];
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) continue;
        const item = entry as Record<string, unknown>;
        const id = item.id;
        if (typeof id !== "string" || id.length === 0) continue;
        const info: SttModelInfo = {
          id,
          label: typeof item.name === "string" && item.name.length > 0 ? item.name : id,
        };
        if (typeof item.description === "string" && item.description.length > 0) {
          info.description = item.description;
        }
        // Aggregator enrichment (OpenRouter-style; absent on plain servers):
        // `pricing.prompt/completion` per-Mtok strings ("0" = free tier).
        const pricing = item.pricing;
        if (typeof pricing === "object" && pricing !== null) {
          const p = pricing as Record<string, unknown>;
          const toNumber = (v: unknown): number | null => {
            if (typeof v === "number" && Number.isFinite(v)) return v;
            if (typeof v === "string" && v.trim() !== "") {
              const value = Number(v);
              return Number.isFinite(value) ? value : null;
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

    async probe(): Promise<SttProbeResult> {
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

// Module-scope registration (protocol-registry pattern): importing this module
// makes the 'openai-compat' STT slug creatable via the STT registry.
registerSttBackend(STT_BACKENDS.OpenAiCompat, openAiCompatSttFactory);
