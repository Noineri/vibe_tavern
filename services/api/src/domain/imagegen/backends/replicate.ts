/**
 * @module imagegen/backends/replicate
 *
 * Replicate image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-5
 * unit 3) — the official-models async surface: submit to
 * `POST /v1/models/{owner}/{model}/predictions`, poll the returned
 * prediction, download the delivery URL WITH the Bearer key.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Replicate",
 * doc-verified 2026-09-07; re-verified live 2026-09-18: the full HTTP
 * reference .md re-read + no-key auth ladder probed + the default
 * model's full input/response schema extracted from its PUBLIC model
 * page's embedded openapi_schema):
 *
 * - Transport: `Authorization: Bearer r8_…` (their own docs' format);
 *   official-models create (no version pinning — always the model's
 *   latest; a named decision) `POST /v1/models/{owner}/{model}/predictions`
 *   with `{input: {…}}`; response 201 carries the prediction object
 *   (id, status, urls.get, urls.cancel). Poll `GET urls.get` until a
 *   terminal status; `POST urls.cancel` cancels. The `Prefer: wait=n`
 *   sync convenience (1–60 s) stays UNUSED — the plain async poll is
 *   the wave's shape and sync mode still needs the poll fallback.
 *   Status enum (schema-verified): starting | processing | succeeded |
 *   canceled | failed.
 * - **DRIFT pinned live 2026-09-18**: the card called `GET /v1/models`
 *   a PUBLIC list — it (and collections, and model details) now 401s
 *   anonymous: no token → 401 `{"title":"Unauthenticated","detail":"You
 *   did not pass an authentication token"}`; bogus token → 401
 *   `{"detail":"Invalid or expired API token."}`. Model listing rides
 *   the profile key on the t2i COLLECTION:
 *   `GET /v1/collections/text-to-image` → `{models: [{owner, name,
 *   description…}]}` (cursor-less nested list per the HTTP reference).
 * - Input (per-model Cog OpenAPI; the default model's schema
 *   live-extracted from its public page): flux-schnell takes `prompt`,
 *   `seed`, `aspect_ratio` (11-value enum "1:1"…"9:21", default 1:1),
 *   megapixels/num_outputs/output_format/disable_safety_checker (vendor
 *   defaults stand — params-unset). VT's W×H maps onto the RATIO grid
 *   exact-else-nearest (the google/mapSd3AspectRatio precedent — the
 *   vendor's actual size control IS the ratio; free-kind caps +
 *   mapping, not invented pixel grids). NO negative_prompt in the
 *   schema — capability off, wire never carries it (SDXL-family
 *   per-model divergence = v1 exclusion, a named decision).
 * - Output: `output` = array of URI strings (schema `items: {type:
 *   string, format: uri}`) — first URL wins (VT generates one). **The
 *   card's URL/retention trap**: delivery files live on
 *   replicate.delivery subdomains and REQUIRE the Authorization header
 *   to fetch, and everything is removed after an hour (output becomes
 *   null) — so the download sends the Bearer key and happens
 *   immediately (the download-always rule).
 * - Poll cadence: 1 s → doubling per 30 s → 5 s cap; total budget 150 s
 *   inside the 3-minute cloud timeout. Best-effort POST cancel on
 *   EVERY failure path out (the aihorde/fal precedent — a cancelled VT
 *   run frees the GPU slot).
 * - Default model `black-forest-labs/flux-schnell` (their own docs'
 *   canonical example id).
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

export class ReplicateImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "ReplicateImageError";
    this.status = options?.status;
  }
}

export class ReplicateImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplicateImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** Their docs' canonical example id — the default roster's flagship. */
export const REPLICATE_DEFAULT_MODEL = "black-forest-labs/flux-schnell";

/** The flux-schnell aspect_ratio enum (live-extracted from the model's
 *  public page openapi_schema — the vendor's actual size control). */
export const REPLICATE_ASPECT_RATIOS = [
  "1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21",
] as const;

/** Exact W:H reduction first, else the nearest ratio by log distance
 *  (the google/mapSd3AspectRatio exact-else-nearest precedent). */
export function mapReplicateAspectRatio(width?: number, height?: number): string | undefined {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const reduced = `${width / divisor}:${height / divisor}`;
  if ((REPLICATE_ASPECT_RATIOS as readonly string[]).includes(reduced)) return reduced;
  const target = Math.log(width / height);
  let best: string = REPLICATE_ASPECT_RATIOS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of REPLICATE_ASPECT_RATIOS) {
    const [w, h] = ratio.split(":").map(Number) as [number, number];
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ratio;
    }
  }
  return best;
}

/** Statuses that keep polling (the schema-verified enum). */
const NON_TERMINAL_STATUSES = new Set(["starting", "processing"]);

/** Poll cadence: 1 s → doubling per 30 s → 5 s cap (the bfl/fal shape). */
const POLL_INITIAL_INTERVAL_MS = 1_000;
const POLL_INTERVAL_CAP_MS = 5_000;
const POLL_BACKOFF_WINDOW_MS = 30_000;
/** The poll budget — inside the 3-minute cloud generation timeout. */
const POLL_TOTAL_BUDGET_MS = 150_000;

/** Real production wait (the test seam overrides this — no sleeps in
 *  tests). */
const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Config ──────────────────────────────────────────────────────────────────

interface ReplicateImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): ReplicateImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a /v1-suffixed base keeps working.
  if (endpoint.endsWith("/v1")) {
    endpoint = endpoint.slice(0, -"/v1".length);
  }
  if (!endpoint) {
    throw new ReplicateImageConfigError("Replicate config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new ReplicateImageConfigError(
      "Replicate config error: `apiKey` is required (the Bearer r8_… token)",
    );
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
    throw new ReplicateImageError(
      `Replicate ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Best-effort cancel — returns instead of throwing so the original
 *  error/abort is never masked (the aihorde/fal precedent). */
async function cancelReplicatePrediction(
  transport: typeof fetch,
  cancelUrl: string,
  apiKey: string,
): Promise<void> {
  await fetchOrWrap(transport, cancelUrl, {
    method: "POST",
    headers: buildHeaders(apiKey, false),
  }, "cancel").catch(() => undefined);
}

/** Poll a prediction until a terminal status; resolves with the
 *  SUCCEEDED prediction root. Exported as the test seam: `wait`
 *  defaults to the real sleep; tests inject an instant resolver and a
 *  scripted fetch (no sleeps in tests — hygiene R5). */
export async function pollReplicatePrediction(params: {
  getUrl: string;
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
      params.getUrl,
      {
        method: "GET",
        headers: buildHeaders(params.apiKey, false),
        signal: params.signal,
      },
      "prediction poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new ReplicateImageError(
        `Replicate prediction poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new ReplicateImageError("Replicate prediction poll returned a non-object payload");
    }
    const root = payload as Record<string, unknown>;
    const status = root.status;
    if (status === "succeeded") return root;
    if (typeof status === "string" && NON_TERMINAL_STATUSES.has(status)) {
      if (elapsed >= POLL_TOTAL_BUDGET_MS) {
        throw new ReplicateImageError(
          `Replicate prediction did not complete within ${
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
    // failed / canceled / unrecognized — terminal, carry `error` when the
    // vendor supplied one.
    const errorPart = typeof root.error === "string" && root.error.length > 0 ? `: ${root.error}` : "";
    throw new ReplicateImageError(
      `Replicate prediction ended with status ${String(status)}${errorPart}`,
    );
  }
}

/** The t2i collection listing (auth required — the 2026-09-18 drift). */
async function listReplicateModels(
  transport: typeof fetch,
  endpoint: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ImageGenModelInfo[]> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/v1/collections/text-to-image`,
    { method: "GET", headers: buildHeaders(apiKey, false), signal },
    "model list",
  );
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ReplicateImageError(
      `Replicate model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (typeof payload !== "object" || payload === null) {
    throw new ReplicateImageError("Replicate model list returned a non-object payload");
  }
  const entries = (payload as Record<string, unknown>).models;
  if (!Array.isArray(entries)) {
    throw new ReplicateImageError("Replicate model list response is missing `models`");
  }
  const models: ImageGenModelInfo[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const owner = record.owner;
    const name = record.name;
    if (typeof owner !== "string" || typeof name !== "string" || owner.length === 0 || name.length === 0) {
      continue;
    }
    models.push({ id: `${owner}/${name}`, label: name });
  }
  return models;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const replicateImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || REPLICATE_DEFAULT_MODEL;

      const input: Record<string, unknown> = { prompt: request.prompt };
      const aspectRatio = mapReplicateAspectRatio(request.width, request.height);
      if (aspectRatio !== undefined) {
        // The vendor's actual size control IS the ratio grid — W×H maps
        // exact-else-nearest (the google precedent).
        input.aspect_ratio = aspectRatio;
      }
      if (request.seed !== undefined) {
        input.seed = request.seed;
      }
      // negative_prompt: absent from the default roster's schema — the
      // capability flag is off, the wire never carries it. num_outputs /
      // megapixels / output_format / disable_safety_checker: vendor
      // defaults stand (params-unset discipline).

      const submit = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/v1/models/${model}/predictions`,
        {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify({ input }),
          signal: request.signal,
        },
        "generation",
      );
      if (!submit.ok) {
        const excerpt = await readProviderErrorBody(submit);
        throw new ReplicateImageError(
          `Replicate generation failed with HTTP ${submit.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: submit.status },
        );
      }
      const submitted: unknown = await submit.json().catch(() => null);
      if (typeof submitted !== "object" || submitted === null) {
        throw new ReplicateImageError("Replicate generation returned a non-object payload");
      }
      const submittedRoot = submitted as Record<string, unknown>;
      const id = submittedRoot.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new ReplicateImageError("Replicate submit response is missing `id`");
      }
      const urls = submittedRoot.urls;
      const getUrl =
        typeof urls === "object" && urls !== null && typeof (urls as Record<string, unknown>).get === "string"
          ? ((urls as Record<string, unknown>).get as string)
          : `${cfg.endpoint}/v1/predictions/${id}`;
      const cancelUrl =
        typeof urls === "object" && urls !== null && typeof (urls as Record<string, unknown>).cancel === "string"
          ? ((urls as Record<string, unknown>).cancel as string)
          : `${cfg.endpoint}/v1/predictions/${id}/cancel`;

      try {
        const succeeded = await pollReplicatePrediction({
          getUrl,
          apiKey: cfg.apiKey,
          fetch: cfg.fetch,
          signal: request.signal,
        });

        // output = URI string | URI string[] (schema: array of uri
        // strings; a bare string appears in the wild on single-output
        // models — both accepted, first URL wins).
        const output = succeeded.output;
        const urls2: string[] = [];
        if (typeof output === "string" && output.length > 0) {
          urls2.push(output);
        } else if (Array.isArray(output)) {
          for (const entry of output) {
            if (typeof entry === "string" && entry.length > 0) urls2.push(entry);
          }
        }
        if (urls2.length === 0) {
          throw new ReplicateImageError(
            "Replicate succeeded prediction carried no output URL (the vendor removes outputs after an hour — output becomes null)",
          );
        }

        // The card's URL/retention trap: delivery files REQUIRE the
        // Bearer key to fetch — the auth-gated download, downloaded
        // immediately (removal after an hour).
        const download = await fetchOrWrap(
          cfg.fetch,
          urls2[0],
          {
            method: "GET",
            headers: buildHeaders(cfg.apiKey, false),
            signal: request.signal,
          },
          "image download",
        );
        if (!download.ok) {
          throw new ReplicateImageError(
            `Replicate image download failed with HTTP ${download.status}`,
            { status: download.status },
          );
        }

        return {
          images: [
            {
              data: Buffer.from(await download.arrayBuffer()),
              mimeType: download.headers.get("content-type") ?? "image/png",
            },
          ],
        };
      } catch (error) {
        // Best-effort cancel on ANY failure path out (aihorde/fal
        // precedent — a cancelled VT run frees the GPU slot). A dead
        // cancel never masks the original error.
        await cancelReplicatePrediction(cfg.fetch, cancelUrl, cfg.apiKey);
        throw error;
      }
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      return listReplicateModels(cfg.fetch, cfg.endpoint, cfg.apiKey, signal);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the default model endpoint:
      // an empty input can never generate — live ladder: 401
      // "You did not pass an authentication token" / "Invalid or expired
      // API token." = creds rejected; any other 4xx = validation reached
      // (auth passed).
      try {
        const response = await cfg.fetch(
          `${cfg.endpoint}/v1/models/${REPLICATE_DEFAULT_MODEL}/predictions`,
          {
            method: "POST",
            headers: buildHeaders(cfg.apiKey, true),
            body: JSON.stringify({ input: {} }),
            signal,
          },
        );
        if (response.status === 401 || response.status === 403) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""} — credentials rejected`,
            status: response.status,
          };
        }
        if (response.status === 404) {
          return { ok: false, detail: "404: model endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: "credentials accepted — t2i collection on discovery" };
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
registerImageGenBackend(IMAGE_GEN_BACKENDS.Replicate, replicateImageFactory);
