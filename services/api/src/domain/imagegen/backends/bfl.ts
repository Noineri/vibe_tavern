/**
 * @module imagegen/backends/bfl
 *
 * Black Forest Labs image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave
 * PE-5 unit 1) — the ASYNC TASK surface: per-model endpoints
 * `POST /v1/{model}`, response `{id, polling_url}`, poll until Ready,
 * download the signed sample URL server-side.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Black Forest Labs
 * direct", doc-verified 2026-09-07; re-verified live 2026-09-18: full
 * openapi.json re-pulled — paths, Flux2Inputs, AsyncResponse,
 * StatusResponse — plus the flux2 image-editing guide's poll/download
 * examples; zero drift against the card):
 *
 * - Transport: base `https://api.bfl.ai`, auth header `x-key`, JSON
 *   bodies. Per-model endpoints (the paths ARE the catalog — no list
 *   endpoint): FLUX.2 max/pro/pro-preview/flex/klein-9b(+preview)/
 *   klein-4b, FLUX Kontext max/pro, FLUX 1.1 pro(+ultra), FLUX 1 dev.
 *   Tools (fill/expand/erase/vto) and FLUX 3 video are out of v1 scope.
 * - ASYNC: submit → `{id, polling_url, cost?, input_mp?, output_mp?}` →
 *   `GET polling_url` WITH the x-key header (their own poll examples) →
 *   `SettledCostResultResponse | ResultResponse` with `status` from the
 *   live-pinned enum: `Task not found | Pending | Reasoning | Generating
 *   | Request Moderated | Content Moderated | Ready | Error`. Ready →
 *   `result.sample` = signed URL, downloaded server-side WITHOUT the key
 *   (the signed-URL rule — aihorde/dashscope precedent). The two
 *   Moderated states are TERMINAL and get their own messages (fail
 *   closed: only Pending/Reasoning/Generating continue; the docs'
 *   examples also check a "Failed" value that is not in the enum — any
 *   unrecognized non-Ready status is terminal here, never an infinite
 *   loop).
 * - Body (Flux2Inputs): `prompt` (required); `width`/`height` (min 64,
 *   default 0 = server-chosen) when BOTH set; `seed` when set. NEVER
 *   sent: `negative_prompt` (their own guide — "working without negative
 *   prompts"; exclusions go positive), `disable_pup` /
 *   `safety_tolerance` / `output_format` / `webhook_*` / `input_image*`
 *   (vendor defaults stand — the params-unset discipline; image inputs
 *   are the editing surface, out of v1 scope); no steps/guidance/sampler
 *   surface exists on FLUX.
 * - Default model `flux-2-pro` (the pinned GA flagship of their own
 *   examples — the google default-model precedent); per-request model
 *   override rides the path.
 * - Live-probed auth ladder (2026-09-18, no key): no x-key → 403
 *   `{"detail": "Not authenticated"}`; junk/64-hex key → 422
 *   `{"detail": "Invalid API key format"}` (format check precedes key
 *   validity); wrong model path → 404 (routing precedes auth). Probe:
 *   invalid-post creds discrimination on the default model endpoint —
 *   403/404/5xx and 422-with-key-format-detail fail; any other 4xx =
 *   validation reached (auth passed), the dashscope probe semantics.
 * - Poll cadence: their examples sleep 0.5 s — start at 1 s, double
 *   every 30 s of elapsed time, cap 5 s; total budget 150 s INSIDE the
 *   3-minute cloud generation timeout (the dashscope precedent).
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenGeneratedImage,
  ImageGenModelInfo,
  ImageGenProbeResult,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import {
  normalizeOpenAiCompatibleBaseUrl,
} from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class BflImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "BflImageError";
    this.status = options?.status;
  }
}

export class BflImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BflImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** The pinned GA flagship — their own examples' "pinned model" row. */
export const BFL_DEFAULT_MODEL = "flux-2-pro";

/** The static catalog — the per-model paths ARE the catalog (the live
 *  openapi.json path list, image families only; tools/fill/expand/erase/
 *  deblur/vto/finetuned variants and flux-3 video are out of v1 scope). */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: "flux-2-max", label: "FLUX 2 Max" },
  { id: "flux-2-pro", label: "FLUX 2 Pro" },
  { id: "flux-2-pro-preview", label: "FLUX 2 Pro (Preview)" },
  { id: "flux-2-flex", label: "FLUX 2 Flex" },
  { id: "flux-2-klein-9b", label: "FLUX 2 Klein 9B" },
  { id: "flux-2-klein-9b-preview", label: "FLUX 2 Klein 9B (Preview)" },
  { id: "flux-2-klein-4b", label: "FLUX 2 Klein 4B" },
  { id: "flux-kontext-max", label: "FLUX Kontext Max" },
  { id: "flux-kontext-pro", label: "FLUX Kontext Pro" },
  { id: "flux-pro-1.1", label: "FLUX 1.1 Pro" },
  { id: "flux-pro-1.1-ultra", label: "FLUX 1.1 Pro Ultra" },
  { id: "flux-dev", label: "FLUX 1 Dev" },
];

/** Statuses that keep polling (the live StatusResponse enum — everything
 *  else is terminal: Ready resolves, Moderated/Error/unknown fail). */
const NON_TERMINAL_STATUSES = new Set(["Pending", "Reasoning", "Generating"]);

/** Poll cadence: their examples sleep 0.5 s — start at 1 s, double every
 *  30 s of elapsed time, cap at 5 s. */
const POLL_INITIAL_INTERVAL_MS = 1_000;
const POLL_INTERVAL_CAP_MS = 5_000;
const POLL_BACKOFF_WINDOW_MS = 30_000;
/** The poll budget — inside the 3-minute cloud generation timeout. */
const POLL_TOTAL_BUDGET_MS = 150_000;

/** Real production wait (the test seam overrides this via the helper's
 *  `wait` parameter — no sleeps in tests). */
const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** BFL auth headers — `x-key` ONLY (no Authorization Bearer: the wire
 *  never carries a header the vendor does not document; the google
 *  x-goog-api-key precedent). */
function bflHeaders(apiKey: string, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", "x-key": apiKey };
  if (withBody) headers["Content-Type"] = "application/json";
  return headers;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface BflImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): BflImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a /v1-suffixed base keeps working (paths below add
  // their own /v1 prefix — never /v1/v1).
  if (endpoint.endsWith("/v1")) {
    endpoint = endpoint.slice(0, -"/v1".length);
  }
  if (!endpoint) {
    throw new BflImageConfigError("BFL config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new BflImageConfigError("BFL config error: `apiKey` is required (the x-key header)");
  }
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, fetch: config.fetch ?? fetch };
}

// ─── HTTP + parsing helpers ──────────────────────────────────────────────────

async function fetchOrWrap(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await transport(url, init);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new BflImageError(
      `BFL ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** BFL's documented error convention: `{detail: string}` (live-probed on
 *  the auth ladder). Best-effort — non-object bodies fall back to the
 *  status code alone. */
async function readDetail(response: Response): Promise<string> {
  const excerpt = await readProviderErrorBody(response);
  return excerpt ?? "";
}

/** Poll a BFL task until Ready; resolves with the Ready payload ROOT
 *  (carrying `result.sample`). Exported as the test seam: `wait`
 *  defaults to the real sleep; tests inject an instant resolver and a
 *  scripted fetch (no sleeps in tests — hygiene R5). */
export async function pollBflTask(params: {
  pollingUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const wait = params.wait ?? realWait;
  let elapsed = 0;
  for (;;) {
    const response = await fetchOrWrap(
      params.fetch,
      params.pollingUrl,
      {
        method: "GET",
        headers: { accept: "application/json", "x-key": params.apiKey },
        signal: params.signal,
      },
      "task poll",
    );
    if (!response.ok) {
      const detail = await readDetail(response);
      throw new BflImageError(
        `BFL task poll failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new BflImageError("BFL task poll returned a non-object payload");
    }
    const root = payload as Record<string, unknown>;
    const status = root.status;
    if (status === "Ready") return root;
    if (typeof status === "string" && NON_TERMINAL_STATUSES.has(status)) {
      if (elapsed >= POLL_TOTAL_BUDGET_MS) {
        throw new BflImageError(
          `BFL task did not complete within ${POLL_TOTAL_BUDGET_MS / 1000}s (last status: ${status})`,
        );
      }
      const interval = Math.min(
        POLL_INITIAL_INTERVAL_MS * 2 ** Math.floor(elapsed / POLL_BACKOFF_WINDOW_MS),
        POLL_INTERVAL_CAP_MS,
      );
      await wait(interval);
      elapsed += interval;
      continue;
    }
    // Error / Request Moderated / Content Moderated / Task not found /
    // anything unrecognized — terminal, fail closed with the status.
    const detailPart = typeof root.detail === "string" ? `: ${root.detail}` : "";
    throw new BflImageError(
      `BFL task ended with status ${String(status)}${detailPart}`,
    );
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const bflImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || BFL_DEFAULT_MODEL;

      const body: Record<string, unknown> = { prompt: request.prompt };
      if (request.width !== undefined && request.height !== undefined) {
        // Free integers, min 64; the vendor default (0) is server-chosen
        // and only bypassed when BOTH dimensions are set.
        body.width = request.width;
        body.height = request.height;
      }
      if (request.seed !== undefined) {
        body.seed = request.seed;
      }
      // negative_prompt: FLUX has none (their own guide) — the capability
      // flag is false, the UI never offers it, the wire never carries it.
      // disable_pup / safety_tolerance / output_format / webhook_*: vendor
      // defaults stand (params-unset discipline).

      const submitResponse = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/v1/${model}`,
        {
          method: "POST",
          headers: bflHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: request.signal,
        },
        "generation",
      );
      if (!submitResponse.ok) {
        const detail = await readDetail(submitResponse);
        throw new BflImageError(
          `BFL generation failed with HTTP ${submitResponse.status}${detail ? `: ${detail}` : ""}`,
          { status: submitResponse.status },
        );
      }
      const submitPayload: unknown = await submitResponse.json().catch(() => null);
      if (typeof submitPayload !== "object" || submitPayload === null) {
        throw new BflImageError("BFL generation returned a non-object payload");
      }
      const pollingUrl = (submitPayload as Record<string, unknown>).polling_url;
      if (typeof pollingUrl !== "string" || pollingUrl.length === 0) {
        throw new BflImageError("BFL submit response is missing `polling_url`");
      }

      const ready = await pollBflTask({
        pollingUrl,
        apiKey: cfg.apiKey,
        fetch: cfg.fetch,
        signal: request.signal,
      });

      const result = ready.result;
      const sample =
        typeof result === "object" && result !== null
          ? (result as Record<string, unknown>).sample
          : undefined;
      if (typeof sample !== "string" || sample.length === 0) {
        throw new BflImageError("BFL Ready payload is missing `result.sample`");
      }

      // Signed sample URL — self-authorizing, downloaded WITHOUT the key
      // (the signed-URL rule; aihorde/dashscope precedent).
      const download = await fetchOrWrap(
        cfg.fetch,
        sample,
        { method: "GET", signal: request.signal },
        "image download",
      );
      if (!download.ok) {
        throw new BflImageError(`BFL image download failed with HTTP ${download.status}`, {
          status: download.status,
        });
      }

      // The vendor default output format is jpeg (output_format unsent) —
      // content-type backs it up when present.
      return {
        images: [
          {
            data: Buffer.from(await download.arrayBuffer()),
            mimeType: download.headers.get("content-type") ?? "image/jpeg",
          },
        ],
      };
    },

    async listModels(): Promise<ImageGenModelInfo[]> {
      // Static catalog — the per-model paths ARE the catalog; no list
      // endpoint exists in the live OpenAPI.
      return STATIC_MODELS.map((m) => ({ ...m }));
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the default model endpoint:
      // an empty body (no prompt) can never generate. Live ladder: 403 =
      // key header missing/rejected, 422 {detail: Invalid API key
      // format} = key format rejected, 404 = wrong endpoint, other 4xx =
      // validation reached (auth passed).
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/v1/${BFL_DEFAULT_MODEL}`, {
          method: "POST",
          headers: bflHeaders(cfg.apiKey, true),
          body: JSON.stringify({}),
          signal,
        });
        if (response.status === 403 || response.status === 401) {
          const detail = await readDetail(response);
          return {
            ok: false,
            detail: `${response.status}${detail ? `: ${detail}` : ""} — credentials rejected`,
            status: response.status,
          };
        }
        if (response.status === 404) {
          return { ok: false, detail: "404: generation endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const detail = await readDetail(response);
          return {
            ok: false,
            detail: `${response.status}${detail ? `: ${detail}` : ""}`,
            status: response.status,
          };
        }
        const detail = await readDetail(response);
        if (/invalid api key/i.test(detail)) {
          return {
            ok: false,
            detail: `422: ${detail} — credentials rejected`,
            status: 422,
          };
        }
        return { ok: true, detail: `credentials accepted — ${STATIC_MODELS.length} static models` };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release.
    },
  };

  return backend;
};

// Module-scope registration (protocol-registry pattern, the STT/TTS twins).
registerImageGenBackend(IMAGE_GEN_BACKENDS.Bfl, bflImageFactory);
