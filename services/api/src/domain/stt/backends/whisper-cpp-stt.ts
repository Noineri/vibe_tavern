/**
 * @module stt/backends/whisper-cpp-stt
 *
 * whisper.cpp server adapter (STT_PROVIDER_EXPANSION SPE-9) — the project's
 * OWN local HTTP surface (`examples/server`), NOT the OpenAI-compatible
 * transport. Built because the owner rejected excluding whisper.cpp from
 * the local roster over "no OpenAI-compatible API" — own-wire servers are
 * exactly what native adapters are for (the SPE-4..6 pattern, applied
 * locally). Also covers whisperfile: Mozilla's llamafile wraps this same
 * server, so one wire serves both.
 *
 * Doc gate (ggml-org/whisper.cpp examples/server/server.cpp @ master,
 * read in full 2026-09-05 — every fact below is pinned to that source):
 * - `POST {endpoint}/inference` (route movable via `--inference-path`; the
 *   default is `/inference` and we pin to it — the OpenAI-path trick via
 *   `--inference-path /v1/audio/transcriptions` exists but payload parity
 *   is unverified, and requiring non-default flags defeats the point);
 * - multipart field name is `file` (the server 400s with
 *   `{"error":"no 'file' field in the request"}` when it is missing);
 * - per-request params read via `get_req_parameters`: `response_format`,
 *   `temperature`, and `language` (a per-request override of the server
 *   `-l` default — the source reads a `language` multipart field; values
 *   are whisper language codes / English names / "auto");
 * - `response_format=json` (the server default) returns exactly
 *   `{"text": <transcript>}` — the plain-`json` branch of the response
 *   formatter (`verbose_json` adds segments; we never ask for it);
 * - errors are `{"error": <message>}` with 400 (bad/missing audio),
 *   500 (decode/inference failure, FFmpeg conversion failure), 503 health
 *   while the model is still loading;
 * - `GET /health` → `{"status":"ok"}` once the model is loaded, 503
 *   `{"status":"loading model"}` before that — the probe route;
 * - NO auth of any kind is checked (no key, no header);
 * - the MODEL is bound at server start (`-m/--model`, default
 *   `models/ggml-base.en.bin`) and can be hot-swapped via `POST /load`
 *   (multipart `model` field) — there is NO per-request model param, so
 *   this backend has no model field at all (the profile config carries
 *   only the endpoint; the UI hint points at the server flags);
 * - audio: the server reads WAV natively; anything else (our dictation is
 *   webm/opus) needs `--convert` at server start (ffmpeg in PATH, else
 *   the server exits at boot). The setup guide ships the flag.
 *
 * Config bag (loose, house style): `endpoint` (the server base, default
 * `http://127.0.0.1:8080` — the server's own default host/port), optional
 * `language` passthrough. No apiKey — the profile carries none (local,
 * keyless; `requiresApiKey` is false in the registry capabilities).
 */

import { STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileConfig } from "@vibe-tavern/domain";

import type {
  SttBackend,
  SttBackendFactory,
  SttProbeResult,
  SttTranscribeResult,
} from "../stt-backend.js";
import { registerSttBackend } from "../stt-registry.js";

const TRANSCRIBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** HTTP / transport failure of a transcription or probe request. */
export class WhisperCppSttError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — refused, timeout). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "WhisperCppSttError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint). */
export class WhisperCppSttConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperCppSttConfigError";
  }
}

// ─── Config accessors (loose config bag, house style) ───────────────────────

interface WhisperCppSttConfig {
  endpoint: string;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseConfig(config: SttProfileConfig): WhisperCppSttConfig {
  const bag = config as Record<string, unknown>;
  const endpoint = readString(bag, "endpoint");
  if (!endpoint) {
    throw new WhisperCppSttConfigError(
      "whisper.cpp STT config error: `endpoint` is required (the local server address, default http://127.0.0.1:8080)",
    );
  }
  return { endpoint: endpoint.replace(/\/+$/, "") };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Read the failure body: whisper.cpp errors are `{"error": <message>}`,
 *  so the parsed field is preferred over a raw excerpt. */
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
      const message = (parsed as Record<string, unknown>).error;
      if (typeof message === "string") return message;
    }
  } catch {
    // Non-JSON body — fall through to the raw excerpt.
  }
  return text.length > ERROR_BODY_EXCERPT_LENGTH
    ? `${text.slice(0, ERROR_BODY_EXCERPT_LENGTH)}…`
    : text;
}

/** Wrap a transport-level failure (refused connection, timeout) in the
 *  adapter's typed error so callers get one error surface. */
async function fetchOrWrap(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new WhisperCppSttError(
      `whisper.cpp STT ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Extract the transcript from an `response_format=json` reply. The server
 *  returns exactly `{"text": <str>}`; defensive against missing containers
 *  ("" — the caller decides whether an empty transcript is an error).
 *  Exported for tests. */
export function extractInferenceTranscript(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

/** Parse the `/health` payload (`{"status":"ok"}` / `{"status":"loading
 *  model"}`) — the probe detail. */
function parseHealthStatus(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const status = (payload as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const whisperCppSttFactory: SttBackendFactory = (config) => {
  const cfg = parseConfig(config);

  const backend: SttBackend = {
    async transcribe(audio, options): Promise<SttTranscribeResult> {
      // Blob (the typed BodyInit carrier) — built from a pure ArrayBuffer
      // so no ArrayBufferLike variance slips into BlobPart (the Buffer
      // branch copies once; dictation clips are small).
      const blob =
        audio instanceof ArrayBuffer
          ? new Blob([audio], { type: options.mime })
          : new Blob([new Uint8Array(audio).buffer], { type: options.mime });
      // Multipart per the server contract: field name `file`, explicit
      // `response_format=json` (the plain-`{"text"}` branch), and the
      // per-request `language` override when the caller carries a hint
      // (the source reads a `language` multipart field; empty = keep the
      // server's `-l` default).
      const form = new FormData();
      form.append("file", blob, "audio.webm");
      form.append("response_format", "json");
      if (options.language !== undefined && options.language !== "") {
        form.append("language", options.language);
      }

      const response = await fetchOrWrap(
        `${cfg.endpoint}/inference`,
        {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        },
        "transcribe",
      );

      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        throw new WhisperCppSttError(
          `whisper.cpp STT transcription failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      return { text: extractInferenceTranscript(payload) };
    },

    async probe(): Promise<SttProbeResult> {
      // The server exposes a dedicated health route: 200 `{"status":"ok"}`
      // once the model is loaded, 503 `{"status":"loading model"}` before.
      try {
        const response = await fetch(`${cfg.endpoint}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const payload: unknown = await response.json().catch(() => null);
        const healthStatus = parseHealthStatus(payload);
        if (!response.ok) {
          return {
            ok: false,
            detail: `${response.status}${healthStatus ? `: ${healthStatus}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: healthStatus ?? "ok" };
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
// makes the 'whisper-cpp' STT slug creatable via the STT registry. No
// listModels — the model is bound at server start, so the draft-models route
// falls back to probe() (the SPE-7 mechanism: Test-connection goes green on a
// healthy server, red on a dead one).
registerSttBackend(STT_BACKENDS.WhisperCpp, whisperCppSttFactory);
