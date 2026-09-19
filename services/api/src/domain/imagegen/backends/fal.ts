/**
 * @module imagegen/backends/fal
 *
 * fal.ai image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-5 unit
 * 2) — the QUEUE surface (their recommended transport): submit to
 * `https://queue.fal.run/{endpoint_id}`, poll the returned status_url,
 * fetch the response_url, download the signed CDN image server-side.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "fal.ai",
 * doc-verified 2026-09-07; re-verified live 2026-09-18: queue.md +
 * model-arguments.md re-fetched, the live model catalog walked (221
 * text-to-image endpoints over 3 cursor pages), no-key auth ladder
 * probed — zero drift):
 *
 * - Transport: `POST {queue}/{endpoint_id}` (endpoint ids carry slashes,
 *   e.g. `fal-ai/flux-2-pro`); auth header `Authorization: Key <key>`
 *   (their own format, NOT plain Bearer). Submit →
 *   `{request_id, status_url, response_url, cancel_url, queue_position?}`;
 *   poll `GET status_url` → `{status: IN_QUEUE|IN_PROGRESS|COMPLETED,
 *   queue_position?}`; `GET response_url` after COMPLETED;
 *   `DELETE cancel_url` cancels. Live no-key ladder: 401
 *   `{"detail": "Cannot access application … Authentication is
 *   required…"}` on both queue and sync hosts (probe discrimination).
 * - Body (Common Model Arguments): `prompt`; `image_size` as the
 *   `{width, height}` OBJECT form when BOTH dimensions are set (the
 *   6-preset-string form exists too — the object form is the generic
 *   one; `aspect_ratio` belongs to OTHER models like nano-banana and is
 *   silently ignored by image_size models — never sent); `seed` when
 *   set. NEVER sent: `negative_prompt` (the fal-hosted FLUX family —
 *   VT's default roster — documents none; per-model SDXL divergence is
 *   a v1 exclusion, a named decision), `num_images` (VT generates one),
 *   `output_format` / `enable_safety_checker` / prompt-expansion flags
 *   (vendor defaults stand — the params-unset discipline).
 * - Privacy: `X-Fal-Store-IO: 0` on EVERY request (opts out of the
 *   30-day request-payload storage — the card's privacy story; the
 *   google `store:false` / horde `shared:false` precedent). The
 *   `X-Fal-Object-Lifecycle-Preference` retention header stays unsent
 *   (its numeric default is UNSTATED; the download-always rule covers
 *   delivery).
 * - Response: `{images: [{url, width, height, …}], has_nsfw_concepts?,
 *   seed?}` — `v3.fal.media` signed CDN URLs, downloaded server-side
 *   WITHOUT the key (signed = self-authorizing, the BFL/dashscope
 *   precedent). **Safety-checker trap (the card's explicit demand)**:
 *   the checker is ON by vendor default and a flagged image is REPLACED
 *   by a black square with `has_nsfw_concepts[]` non-empty — surfacing
 *   that as a typed error instead of silently showing black.
 * - Model picker = live catalog: `GET https://api.fal.ai/v1/models?
 *   category=text-to-image` (anonymous-verified) → `{models:
 *   [{endpoint_id, metadata.display_name}], next_cursor, has_more}` —
 *   cursor pages of 100; the arm walks up to 5 pages (live total: 221).
 *   The catalog host is a vendor-fixed infrastructure constant, not a
 *   user-configurable endpoint.
 * - Default model `fal-ai/flux-2-pro` (the BFL-direct twin flagship;
 *   the bfl/google default-model precedent).
 * - Poll cadence: 1 s → doubling per 30 s → 5 s cap; total budget 150 s
 *   inside the 3-minute cloud timeout. The poll forwards the caller's
 *   abort and best-effort-DELETE-cancels the queued request on ANY
 *   failure path out (the aihorde precedent — a cancelled VT run frees
 *   the fal GPU queue slot instead of burning it).
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
import { normalizeOpenAiCompatibleBaseUrl } from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class FalImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "FalImageError";
    this.status = options?.status;
  }
}

export class FalImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FalImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** The pinned flagship — the BFL-direct twin on fal's own hosting. */
export const FAL_DEFAULT_MODEL = "fal-ai/flux-2-pro";

/** The vendor-fixed catalog host (infrastructure constant, not a
 *  user-configurable endpoint field). */
const FAL_CATALOG_URL = "https://api.fal.ai/v1/models";

/** Catalog walk cap — live total is 221 over 3 cursor pages; 5 pages
 *  (500) leaves growth headroom without an unbounded loop. */
const FAL_CATALOG_MAX_PAGES = 5;

/** Statuses that keep polling (the queue.md table). */
const NON_TERMINAL_STATUSES = new Set(["IN_QUEUE", "IN_PROGRESS"]);

/** Poll cadence: 1 s → doubling per 30 s → 5 s cap (the bfl shape). */
const POLL_INITIAL_INTERVAL_MS = 1_000;
const POLL_INTERVAL_CAP_MS = 5_000;
const POLL_BACKOFF_WINDOW_MS = 30_000;
/** The poll budget — inside the 3-minute cloud generation timeout. */
const POLL_TOTAL_BUDGET_MS = 150_000;

/** Real production wait (the test seam overrides this — no sleeps in
 *  tests). */
const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Config ──────────────────────────────────────────────────────────────────

interface FalImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): FalImageConfig {
  const endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  if (!endpoint) {
    throw new FalImageConfigError("fal config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new FalImageConfigError("fal config error: `apiKey` is required (the `Authorization: Key` header)");
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
    throw new FalImageError(
      `fal ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** fal auth headers — `Authorization: Key <key>` (their own format), plus
 *  the privacy opt-out `X-Fal-Store-IO: 0` on every request (opts out of
 *  the 30-day request-payload storage — the google `store:false`
 *  precedent). */
function falHeaders(apiKey: string, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    Authorization: `Key ${apiKey}`,
    "X-Fal-Store-IO": "0",
  };
  if (withBody) headers["Content-Type"] = "application/json";
  return headers;
}

/** Best-effort queue cancellation — returns instead of throwing so the
 *  original error/abort is never masked (the aihorde precedent). */
async function cancelFalRequest(
  transport: typeof fetch,
  cancelUrl: string,
  apiKey: string,
): Promise<void> {
  await fetchOrWrap(transport, cancelUrl, {
    method: "DELETE",
    headers: falHeaders(apiKey, false),
  }, "cancel").catch(() => undefined);
}

/** Poll a fal queue request until COMPLETED. Exported as the test seam:
 *  `wait` defaults to the real sleep; tests inject an instant resolver
 *  and a scripted fetch (no sleeps in tests — hygiene R5). */
export async function pollFalRequest(params: {
  statusUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const wait = params.wait ?? realWait;
  let elapsed = 0;
  for (;;) {
    const response = await fetchOrWrap(
      params.fetch,
      params.statusUrl,
      {
        method: "GET",
        headers: falHeaders(params.apiKey, false),
        signal: params.signal,
      },
      "status poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new FalImageError(
        `fal status poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new FalImageError("fal status poll returned a non-object payload");
    }
    const status = (payload as Record<string, unknown>).status;
    if (status === "COMPLETED") return;
    if (typeof status === "string" && NON_TERMINAL_STATUSES.has(status)) {
      if (elapsed >= POLL_TOTAL_BUDGET_MS) {
        throw new FalImageError(
          `fal request did not complete within ${POLL_TOTAL_BUDGET_MS / 1000}s (last status: ${status})`,
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
    // Unrecognized / error statuses (422-style task errors arrive as
    // non-2xx above) — terminal, fail closed with the status carried.
    throw new FalImageError(`fal request ended with status ${String(status)}`);
  }
}

/** Walk the live text-to-image catalog (cursor pages of 100). */
async function listFalModels(transport: typeof fetch, signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
  const models: ImageGenModelInfo[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < FAL_CATALOG_MAX_PAGES; page += 1) {
    const url = new URL(FAL_CATALOG_URL);
    url.searchParams.set("category", "text-to-image");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const response = await fetchOrWrap(transport, url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    }, "model list");
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new FalImageError(
        `fal model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new FalImageError("fal model list returned a non-object payload");
    }
    const root = payload as Record<string, unknown>;
    const entries = root.models;
    if (!Array.isArray(entries)) {
      throw new FalImageError("fal model list response is missing `models`");
    }
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = record.endpoint_id;
      if (typeof id !== "string" || id.length === 0) continue;
      const metadata = record.metadata;
      const label =
        typeof metadata === "object" && metadata !== null &&
        typeof (metadata as Record<string, unknown>).display_name === "string"
          ? ((metadata as Record<string, unknown>).display_name as string)
          : id;
      models.push({ id, label });
    }
    const next = root.next_cursor;
    if (root.has_more !== true || typeof next !== "string" || next.length === 0) break;
    cursor = next;
  }
  return models;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const falImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || FAL_DEFAULT_MODEL;

      const body: Record<string, unknown> = { prompt: request.prompt };
      if (request.width !== undefined && request.height !== undefined) {
        // The generic object form — the 6-preset strings and the
        // aspect_ratio field belong to other models' surfaces.
        body.image_size = { width: request.width, height: request.height };
      }
      if (request.seed !== undefined) {
        body.seed = request.seed;
      }
      // negative_prompt: the fal-hosted FLUX family documents none — the
      // capability flag is off, the wire never carries it (SDXL-family
      // divergence is a v1 exclusion, a named decision in the caps row).

      const submit = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/${model}`,
        {
          method: "POST",
          headers: falHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: request.signal,
        },
        "generation",
      );
      if (!submit.ok) {
        const excerpt = await readProviderErrorBody(submit);
        throw new FalImageError(
          `fal generation failed with HTTP ${submit.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: submit.status },
        );
      }
      const submitted: unknown = await submit.json().catch(() => null);
      if (typeof submitted !== "object" || submitted === null) {
        throw new FalImageError("fal generation returned a non-object payload");
      }
      const submittedRoot = submitted as Record<string, unknown>;
      const statusUrl = submittedRoot.status_url;
      const responseUrl = submittedRoot.response_url;
      const cancelUrl = submittedRoot.cancel_url;
      if (typeof statusUrl !== "string" || statusUrl.length === 0) {
        throw new FalImageError("fal submit response is missing `status_url`");
      }
      if (typeof responseUrl !== "string" || responseUrl.length === 0) {
        throw new FalImageError("fal submit response is missing `response_url`");
      }

      try {
        await pollFalRequest({
          statusUrl,
          apiKey: cfg.apiKey,
          fetch: cfg.fetch,
          signal: request.signal,
        });

        const responseFetch = await fetchOrWrap(
          cfg.fetch,
          responseUrl,
          {
            method: "GET",
            headers: falHeaders(cfg.apiKey, false),
            signal: request.signal,
          },
          "result fetch",
        );
        if (!responseFetch.ok) {
          const excerpt = await readProviderErrorBody(responseFetch);
          throw new FalImageError(
            `fal result fetch failed with HTTP ${responseFetch.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: responseFetch.status },
          );
        }
        const resultPayload: unknown = await responseFetch.json().catch(() => null);
        if (typeof resultPayload !== "object" || resultPayload === null) {
          throw new FalImageError("fal result returned a non-object payload");
        }
        const resultRoot = resultPayload as Record<string, unknown>;

        // Safety-checker trap: a flagged image is REPLACED by a black
        // square upstream — surface it, never show black silently (the
        // card's explicit demand; VT generates one image, so the first
        // entry decides).
        const nsfw = resultRoot.has_nsfw_concepts;
        if (Array.isArray(nsfw) && nsfw.length > 0) {
          const first = nsfw[0];
          if (Array.isArray(first) && first.length > 0) {
            throw new FalImageError(
              "fal safety checker flagged the image (has_nsfw_concepts non-empty) — the delivered file is the checker's black replacement, not a result",
            );
          }
        }

        const images = resultRoot.images;
        if (!Array.isArray(images) || images.length === 0) {
          throw new FalImageError("fal result carried no images");
        }
        const first = images[0];
        if (typeof first !== "object" || first === null) {
          throw new FalImageError("fal result image entry is not an object");
        }
        const image = first as Record<string, unknown>;
        const url = image.url;
        if (typeof url !== "string" || url.length === 0) {
          throw new FalImageError("fal result image entry is missing `url`");
        }

        // Signed v3.fal.media CDN URL — self-authorizing, downloaded
        // WITHOUT the key (the BFL/dashscope precedent).
        const download = await fetchOrWrap(
          cfg.fetch,
          url,
          { method: "GET", signal: request.signal },
          "image download",
        );
        if (!download.ok) {
          throw new FalImageError(`fal image download failed with HTTP ${download.status}`, {
            status: download.status,
          });
        }

        const result: ImageGenGenerateResult = {
          images: [
            {
              data: Buffer.from(await download.arrayBuffer()),
              mimeType: download.headers.get("content-type") ?? "image/png",
            },
          ],
        };
        // The response image entry reports the ACTUAL output size.
        if (typeof image.width === "number" && typeof image.height === "number") {
          result.width = image.width;
          result.height = image.height;
        }
        return result;
      } catch (error) {
        // Best-effort cancel on ANY failure path out — a cancelled VT run
        // frees the fal GPU queue slot instead of burning it (the aihorde
        // precedent). A dead cancel never masks the original error.
        if (typeof cancelUrl === "string" && cancelUrl.length > 0) {
          await cancelFalRequest(cfg.fetch, cancelUrl, cfg.apiKey);
        }
        throw error;
      }
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      return listFalModels(cfg.fetch, signal);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the default model endpoint:
      // an empty body can never generate — live ladder: 401 "Cannot
      // access application … Authentication is required" = creds
      // rejected; any other 4xx = validation reached (auth passed).
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/${FAL_DEFAULT_MODEL}`, {
          method: "POST",
          headers: falHeaders(cfg.apiKey, true),
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
          return { ok: false, detail: "404: application not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: "credentials accepted — live model catalog on discovery" };
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
registerImageGenBackend(IMAGE_GEN_BACKENDS.Fal, falImageFactory);
