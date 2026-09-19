/**
 * @module imagegen/backends/novita
 *
 * Novita AI image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-5
 * unit 6 — the wave's THIN arm): exactly one documented t2i model
 * (Qwen-Image) on the async task surface.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Novita AI",
 * doc-verified 2026-09-07; re-verified live 2026-09-18: the
 * qwen-image-txt2img reference page scraped in full (Fern/Mintlify,
 * firecrawl — the .md twin moved) + the task-result reference .md with
 * the full status enum + no-key probes on both endpoints):
 *
 * - Transport: `POST https://api.novita.ai/v3/async/qwen-image-txt2img`,
 *   `Authorization: Bearer` (their own example format). Body:
 *   `prompt` (required), `size` `"W*H"` (STAR separator — the DashScope
 *   dialect, not "WxH"; 256–1536 per dimension; default 1024*1024) —
 *   sent only when BOTH VT dimensions are set. That is the WHOLE
 *   documented surface: no seed, no negative, no steps/sampler, no n
 *   (per-card; the pivoted catalog dropped the old /v3/async/txt2img
 *   SD surface entirely).
 * - ASYNC: submit → `{task_id}` → poll
 *   `GET /v3/async/task-result?task_id=` → `task.status` from the
 *   documented enum: TASK_STATUS_QUEUED / TASK_STATUS_PROCESSING (keep
 *   polling) → TASK_STATUS_SUCCEED / TASK_STATUS_FAILED (terminal;
 *   `task.reason` carries the failure).
 * - Result: `{extra: {has_nsfw_contents: []}, task: {…, eta,
 *   progress_percent}, images: [{image_url, image_url_ttl,
 *   image_type, nsfw_detection_result}], videos: [], audios: []}`.
 *   `image_url_ttl: "0"` observed in the doc example — TTL semantics
 *   undocumented → downloaded IMMEDIATELY server-side, keyless
 *   (cloudfront.net delivery, no auth gate observed on the wire).
 *   **NSFW surfacing**: non-empty `extra.has_nsfw_contents` or a
 *   non-null per-image `nsfw_detection_result` → typed error (the fal
 *   safety-checker precedent — never silently show a checker-replaced
 *   file).
 * - Model catalog: STATIC single entry (no image-model list endpoint
 *   exists — per-card, llms.txt re-verified); the model field stays a
 *   passthrough override for future Novita models riding the same
 *   task pattern (a wrong model id surfaces the vendor's own error).
 * - Live no-key ladder: 403
 *   `{"code":403,"reason":"INVALID_API_KEY","message":"invalid
 *   api-key"}` on BOTH endpoints — the probe's rejected-creds shape.
 * - Poll cadence: 1 s → doubling per 30 s → 5 s cap; total budget
 *   150 s inside the 3-minute cloud timeout. No cancel endpoint on
 *   the surface (the dashscope/luma no-cancel precedent).
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
  buildHeaders,
} from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class NovitaImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "NovitaImageError";
    this.status = options?.status;
  }
}

export class NovitaImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NovitaImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** The one documented t2i model — Novita's whole image v1 surface. */
export const NOVITA_DEFAULT_MODEL = "qwen-image-txt2img";

/** Static single-entry catalog (no list endpoint exists). */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: NOVITA_DEFAULT_MODEL, label: "Qwen-Image" },
];

/** Statuses that keep polling (the task-result reference enum). */
const NON_TERMINAL_STATUSES = new Set(["TASK_STATUS_QUEUED", "TASK_STATUS_PROCESSING"]);

/** Poll cadence: 1 s → doubling per 30 s → 5 s cap (the wave's shape). */
const POLL_INITIAL_INTERVAL_MS = 1_000;
const POLL_INTERVAL_CAP_MS = 5_000;
const POLL_BACKOFF_WINDOW_MS = 30_000;
/** The poll budget — inside the 3-minute cloud generation timeout. */
const POLL_TOTAL_BUDGET_MS = 150_000;

/** Real production wait (the test seam overrides this — no sleeps in
 *  tests). */
const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Config ──────────────────────────────────────────────────────────────────

interface NovitaImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): NovitaImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: /v3 or /v1 suffixed bases keep working.
  if (endpoint.endsWith("/v3")) {
    endpoint = endpoint.slice(0, -"/v3".length);
  } else if (endpoint.endsWith("/v1")) {
    endpoint = endpoint.slice(0, -"/v1".length);
  }
  if (!endpoint) {
    throw new NovitaImageConfigError("Novita config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new NovitaImageConfigError("Novita config error: `apiKey` is required (the Bearer key)");
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
    throw new NovitaImageError(
      `Novita ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Poll a Novita task until SUCCEED; resolves with the COMPLETED result
 *  root. Exported as the test seam: `wait` defaults to the real sleep;
 *  tests inject an instant resolver and a scripted fetch (no sleeps in
 *  tests — hygiene R5). */
export async function pollNovitaTask(params: {
  endpoint: string;
  apiKey: string;
  taskId: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const wait = params.wait ?? realWait;
  let elapsed = 0;
  for (;;) {
    const response = await fetchOrWrap(
      params.fetch,
      `${params.endpoint}/v3/async/task-result?task_id=${encodeURIComponent(params.taskId)}`,
      {
        method: "GET",
        headers: buildHeaders(params.apiKey, false),
        signal: params.signal,
      },
      "task poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new NovitaImageError(
        `Novita task poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new NovitaImageError("Novita task poll returned a non-object payload");
    }
    const root = payload as Record<string, unknown>;
    const task = root.task;
    const status =
      typeof task === "object" && task !== null
        ? (task as Record<string, unknown>).status
        : undefined;
    if (status === "TASK_STATUS_SUCCEED") return root;
    if (typeof status === "string" && NON_TERMINAL_STATUSES.has(status)) {
      if (elapsed >= POLL_TOTAL_BUDGET_MS) {
        throw new NovitaImageError(
          `Novita task ${params.taskId} did not complete within ${
            POLL_TOTAL_BUDGET_MS / 1000
          }s (last status: ${status})`,
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
    // TASK_STATUS_FAILED / unrecognized — terminal, carry task.reason.
    const reason =
      typeof task === "object" && task !== null
        ? (task as Record<string, unknown>).reason
        : undefined;
    const reasonPart = typeof reason === "string" && reason.length > 0 ? `: ${reason}` : "";
    throw new NovitaImageError(
      `Novita task ${params.taskId} ended with status ${String(status)}${reasonPart}`,
    );
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const novitaImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || NOVITA_DEFAULT_MODEL;

      const body: Record<string, unknown> = { prompt: request.prompt };
      if (request.width !== undefined && request.height !== undefined) {
        // STAR separator (the DashScope dialect); range 256–1536 per
        // dimension is the vendor's validation, surfaced as its own error.
        body.size = `${request.width}*${request.height}`;
      }
      // seed/negative/steps/sampler/n: NOT on the documented surface —
      // capabilities off, the wire never carries them.

      const submit = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/v3/async/${model}`,
        {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: request.signal,
        },
        "generation",
      );
      if (!submit.ok) {
        const excerpt = await readProviderErrorBody(submit);
        throw new NovitaImageError(
          `Novita generation failed with HTTP ${submit.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: submit.status },
        );
      }
      const submitted: unknown = await submit.json().catch(() => null);
      if (typeof submitted !== "object" || submitted === null) {
        throw new NovitaImageError("Novita generation returned a non-object payload");
      }
      const taskId = (submitted as Record<string, unknown>).task_id;
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new NovitaImageError("Novita submit response is missing `task_id`");
      }

      const succeeded = await pollNovitaTask({
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        taskId,
        fetch: cfg.fetch,
        signal: request.signal,
      });

      // NSFW surfacing (the fal safety-checker precedent): non-empty
      // extra.has_nsfw_contents or a non-null per-image detection result
      // — a typed error, never a silently checker-replaced file.
      const extra = succeeded.extra;
      if (
        typeof extra === "object" &&
        extra !== null &&
        Array.isArray((extra as Record<string, unknown>).has_nsfw_contents) &&
        ((extra as Record<string, unknown>).has_nsfw_contents as unknown[]).length > 0
      ) {
        throw new NovitaImageError(
          "Novita NSFW detection flagged the image (extra.has_nsfw_contents non-empty) — nothing clean to show",
        );
      }

      const images = succeeded.images;
      if (!Array.isArray(images) || images.length === 0) {
        throw new NovitaImageError("Novita succeeded task carried no images");
      }
      const first = images[0];
      if (typeof first !== "object" || first === null) {
        throw new NovitaImageError("Novita image entry is not an object");
      }
      const entry = first as Record<string, unknown>;
      if (entry.nsfw_detection_result !== null && entry.nsfw_detection_result !== undefined) {
        throw new NovitaImageError(
          "Novita NSFW detection flagged the image (nsfw_detection_result non-null) — nothing clean to show",
        );
      }
      const url = entry.image_url;
      if (typeof url !== "string" || url.length === 0) {
        throw new NovitaImageError("Novita image entry is missing `image_url`");
      }

      // image_url_ttl "0" observed — TTL semantics undocumented →
      // downloaded immediately, keyless (cloudfront delivery).
      const download = await fetchOrWrap(
        cfg.fetch,
        url,
        { method: "GET", signal: request.signal },
        "image download",
      );
      if (!download.ok) {
        throw new NovitaImageError(`Novita image download failed with HTTP ${download.status}`, {
          status: download.status,
        });
      }

      const result: ImageGenGenerateResult = {
        images: [
          {
            data: Buffer.from(await download.arrayBuffer()),
            mimeType:
              typeof entry.image_type === "string" && entry.image_type.length > 0
                ? `image/${entry.image_type === "jpg" ? "jpeg" : entry.image_type}`
                : (download.headers.get("content-type") ?? "image/png"),
          },
        ],
      };
      return result;
    },

    async listModels(): Promise<ImageGenModelInfo[]> {
      // Static single entry — no image-model list endpoint exists.
      return STATIC_MODELS.map((m) => ({ ...m }));
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the t2i endpoint: an empty
      // body (no prompt — required) can never generate. Live ladder:
      // 403 {code:403, reason:INVALID_API_KEY, message:"invalid api-key"}
      // = rejected; any other 4xx = validation reached (auth passed).
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/v3/async/${NOVITA_DEFAULT_MODEL}`, {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify({}),
          signal,
        });
        if (response.status === 401 || response.status === 403) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""} — credentials rejected`,
            status: response.status,
          };
        }
        if (response.status === 404) {
          return { ok: false, detail: "404: generation endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: "credentials accepted — Qwen-Image (static single model)" };
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
registerImageGenBackend(IMAGE_GEN_BACKENDS.Novita, novitaImageFactory);
