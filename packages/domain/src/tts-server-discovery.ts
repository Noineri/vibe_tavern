/** Local TTS server discovery — pure probe module (TTS_PLAN TS-11a; lives in
 *  domain so BOTH the web client and the API server can run it: discovery is
 *  routed through the API (server-side fetch) because some local servers
 *  (openai-edge-tts) ship no CORS headers at all, which makes direct browser
 *  probing impossible — the browser kills the response before we can read
 *  it. The fetch implementation is injected (FetchLike); the module itself
 *  has zero dependencies and never touches I/O globals. */

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<ResponseLike>;

export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface DiscoveredServer {
  port: number;
  /** Base URL, e.g. http://127.0.0.1:8880 */
  baseUrl: string;
  /** Best-effort server identity (kokoro-fastapi recognized by a "kokoro"
   *  model id; the voices shape alone is NOT enough — openai-edge-tts returns
   *  the same { voices: [{ id }] } shape and is not kokoro). */
  kind: "kokoro-fastapi" | "openai-compatible";
  /** Voice ids when the voices endpoint returned a usable list; else []. */
  voiceIds: string[];
  /** Model ids from /v1/models when reachable; else []. */
  modelIds: string[];
}

export interface ProbeOutcome {
  port: number;
  status: "found" | "refused" | "http-error" | "bad-shape" | "timeout";
  server?: DiscoveredServer;
  /** HTTP status when status === "http-error"; used by diagnoseOutcome. */
  httpStatus?: number;
}

export type DiscoveryDiagnosticCode =
  | "found"
  | "server-not-running"
  | "wrong-shape"
  | "auth-or-http"
  | "http-other"
  | "timeout";

const PROBE_PORTS = [8880, 8000, 7851, 5000, 5050] as const;

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull the model-id array out of a /v1/models body. Two shapes in the wild:
 *  the OpenAI-compatible `{ data: [{ id }] }` and openai-edge-tts's
 *  `{ models: [{ id }] }` — accept either. Returns null when neither key
 *  holds an array. */
function readModelIdArray(json: unknown): string[] | null {
  if (!isRecord(json)) return null;
  const source: unknown[] | undefined = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.models)
      ? json.models
      : undefined;
  if (source === undefined) return null;
  const modelIds: string[] = [];
  for (const item of source) {
    if (isRecord(item) && typeof item.id === "string" && item.id.length > 0) {
      modelIds.push(item.id);
    }
  }
  return modelIds;
}

function fetchWithTimeout(
  fetchLike: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<ResponseLike> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(`timeout after ${timeoutMs}ms for ${url}`)), timeoutMs);
  });
  let fetchPromise: Promise<ResponseLike>;
  try {
    fetchPromise = fetchLike(url);
  } catch (error) {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    throw error;
  }
  return Promise.race([fetchPromise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

type EndpointResult =
  | { status: "found"; modelIds?: string[]; voiceIds?: string[] }
  | { status: "http-error"; httpStatus: number }
  | { status: "bad-shape" }
  | { status: "refused" }
  | { status: "timeout" };

async function probeModels(
  baseUrl: string,
  fetchLike: FetchLike,
  timeoutMs: number,
): Promise<EndpointResult & { modelIds?: string[] }> {
  let response: ResponseLike;
  try {
    response = await fetchWithTimeout(fetchLike, `${baseUrl}/v1/models`, timeoutMs);
  } catch (error) {
    if (error instanceof TimeoutError) return { status: "timeout" };
    return { status: "refused" };
  }
  if (!response.ok) {
    return { status: "http-error", httpStatus: response.status };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { status: "bad-shape" };
  }
  const modelIds = readModelIdArray(json);
  if (modelIds === null) return { status: "bad-shape" };
  return { status: "found", modelIds };
}

async function probeVoices(
  baseUrl: string,
  fetchLike: FetchLike,
  timeoutMs: number,
): Promise<EndpointResult & { voiceIds?: string[] }> {
  let response: ResponseLike;
  try {
    response = await fetchWithTimeout(fetchLike, `${baseUrl}/v1/audio/voices`, timeoutMs);
  } catch (error) {
    if (error instanceof TimeoutError) return { status: "timeout" };
    return { status: "refused" };
  }
  if (!response.ok) {
    return { status: "http-error", httpStatus: response.status };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { status: "bad-shape" };
  }
  // Bare array: [{ id, name? }]
  if (Array.isArray(json)) {
    const voiceIds: string[] = [];
    for (const item of json) {
      if (isRecord(item) && typeof item.id === "string" && item.id.length > 0) {
        voiceIds.push(item.id);
      }
    }
    return { status: "found", voiceIds };
  }
  if (isRecord(json) && Array.isArray(json.voices)) {
    const voiceIds: string[] = [];
    for (const item of json.voices) {
      if (isRecord(item) && typeof item.id === "string" && item.id.length > 0) {
        voiceIds.push(item.id);
      }
    }
    return { status: "found", voiceIds };
  }
  return { status: "bad-shape" };
}

/** Probe one port: GET {base}/v1/models and GET {base}/v1/audio/voices.
 *  AbortSignal with a caller-chosen timeout (default 1500ms).
 *  A port is "found" when /v1/models returns ok JSON shaped { data: [{ id }] }
 *  or { models: [{ id }] } OR /v1/audio/voices returns ok JSON shaped
 *  { voices: [{ id }] } / bare array. ok-but-unparseable → "bad-shape".
 *  Non-2xx → "http-error". Network refusal → "refused". Timeout via the
 *  signal → "timeout". Never throws. */
export async function probeServerPort(
  port: number,
  fetchLike: FetchLike,
  timeoutMs = 1500,
): Promise<ProbeOutcome> {
  // 127.0.0.1 is the deterministic loopback form — avoids IPv6 localhost
  // resolution stalls that some local servers exhibit on ::1.
  const baseUrl = `http://127.0.0.1:${port}`;

  const [modelsResult, voicesResult] = await Promise.all([
    probeModels(baseUrl, fetchLike, timeoutMs),
    probeVoices(baseUrl, fetchLike, timeoutMs),
  ]);

  const modelsFound = modelsResult.status === "found";
  const voicesFound = voicesResult.status === "found";

  if (modelsFound || voicesFound) {
    const modelIds = modelsFound && modelsResult.modelIds !== undefined ? modelsResult.modelIds : [];
    const voiceIds = voicesFound && voicesResult.voiceIds !== undefined ? voicesResult.voiceIds : [];
    // kokoro recognition: a "kokoro" model id. The voices shape alone is NOT
    // evidence — openai-edge-tts serves the same { voices: [...] } shape.
    const hasKokoroModel = modelIds.some((id) => id.toLowerCase().includes("kokoro"));
    const kind: DiscoveredServer["kind"] = hasKokoroModel ? "kokoro-fastapi" : "openai-compatible";
    const server: DiscoveredServer = {
      port,
      baseUrl,
      kind,
      voiceIds,
      modelIds,
    };
    return { port, status: "found", server };
  }

  // Not found — pick the most informative non-found status.
  const hasTimeout = modelsResult.status === "timeout" || voicesResult.status === "timeout";
  if (hasTimeout) {
    return { port, status: "timeout" };
  }
  const hasBadShape = modelsResult.status === "bad-shape" || voicesResult.status === "bad-shape";
  if (hasBadShape) {
    return { port, status: "bad-shape" };
  }
  if (modelsResult.status === "http-error" || voicesResult.status === "http-error") {
    const httpStatus =
      modelsResult.status === "http-error"
        ? modelsResult.httpStatus
        : voicesResult.status === "http-error"
          ? voicesResult.httpStatus
          : undefined;
    return { port, status: "http-error", httpStatus };
  }
  return { port, status: "refused" };
}

/** Probe the full ordered list in parallel; resolves when all settle. */
export async function discoverLocalTtsServers(
  fetchLike: FetchLike,
  timeoutMs = 1500,
): Promise<ProbeOutcome[]> {
  const outcomes = await Promise.all(
    PROBE_PORTS.map((port) => probeServerPort(port, fetchLike, timeoutMs)),
  );
  return outcomes;
}

/** Map a ProbeOutcome to a machine-readable diagnostic CODE (11b turns these
 *  into i18n strings): found / server-not-running (refused) / wrong-shape
 *  (bad-shape) / auth-or-http (http-error 401/403) / http-other / timeout. */
export function diagnoseOutcome(outcome: ProbeOutcome): DiscoveryDiagnosticCode {
  switch (outcome.status) {
    case "found":
      return "found";
    case "refused":
      return "server-not-running";
    case "bad-shape":
      return "wrong-shape";
    case "timeout":
      return "timeout";
    case "http-error": {
      const code = outcome.httpStatus;
      if (code === 401 || code === 403) return "auth-or-http";
      return "http-other";
    }
    default:
      return "http-other";
  }
}
