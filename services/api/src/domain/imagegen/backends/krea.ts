/**
 * @module imagegen/backends/krea
 *
 * Krea image backend (IF-11, IMAGEGEN_FOLLOWUP_REPORT item 11) — the
 * async-job aggregator surface: submit to
 * `POST /generate/image/{vendor}/{model}`, poll `GET /jobs/{id}`,
 * download the result URL server-side.
 *
 * Wire facts (doc-verified 2026-09-26: the live OpenAPI 3.1 spec at
 * https://api.krea.ai/openapi.json — 118 paths — plus their docs index
 * /docs/llms.txt, the Krea 2 API overview and generative-sliders pages;
 * the anonymous no-key ladder probed live 2026-09-26):
 *
 * - Transport: `Authorization: Bearer …` (securitySchemes.bearerAuth).
 *   Base https://api.krea.ai. 31 image models across 14 vendors
 *   (krea-2 ×3, BFL, nano-banana, ideogram, gpt-image, grok-imagine,
 *   seedream, qwen, z-image, runway gen-4, luma uni-1, recraft, muse).
 *   **Every request body is STRICT** (`additionalProperties: false`) —
 *   the adapter filters EVERY field against the model's own schema, so
 *   an unknown field can never 400 the request.
 * - **NO list endpoint exists** (11 GET paths total, none model-listing).
 *   Owner ruling 2026-09-23: «список моделей брать живой» — the catalog
 *   is parsed LIVE from the spec's `/generate/image/*` POST paths (the
 *   spec IS served by the API), cached in-memory 10 min (1.7 MB — never
 *   fetched per generation).
 * - Sizes: per-model dialects. Most models take `aspect_ratio` (a
 *   per-model enum, e.g. krea-2: 9 ratios incl. 2.35:1) + `resolution`
 *   (enum, currently only "1K"); some take raw `width`/`height`
 *   (nano-banana family). VT's W×H maps exact-else-nearest onto the
 *   model's OWN live enum (the replicate precedent, generalized);
 *   width/height models get the pixel pair directly.
 * - **Prompt-expansion policy (owner-approved 2026-09-26)**: VT prompts
 *   are authored full-form — the vendor default `creativity` (low per
 *   the schema, medium per the docs — either way non-raw) EXPANDS the
 *   prompt with invented style/composition/camera/palette. krea-2
 *   models get `creativity: "raw"` explicitly (their own docs: raw is
 *   "best for tightly art-directed prompts where every detail is
 *   already specified" — VT's exact case); z-image gets
 *   `skip_prompt_expansion: true`. User-tunable per model via the
 *   overlay `krea.creativity` block.
 * - K2 generative sliders: `intensity` / `complexity` / `movement`,
 *   integer −100..100, default 0 (neutral), independent of creativity
 *   and — by their docs — never touching the prompt text. Ride the
 *   per-model overlay `krea` block; unset = unsent (vendor-neutral).
 * - Job lifecycle: submit → `{job_id, status}`; poll GET /jobs/{id} →
 *   status enum backlogged | queued | scheduled | processing |
 *   sampling | intermediate-complete | completed | failed | cancelled
 *   (intermediate-complete keeps polling — partial results while the
 *   job continues). Terminal error carries `error: {code, message?}`.
 *   Result: `result.urls` — a 3-way union (string[] | {type:"model"|
 *   "preview", url}[] | a url map); preview entries are skipped.
 *   `DEL /jobs/{id}` cancels (best-effort on every failure path out).
 * - Download: URL auth is undocumented and no key was available to
 *   verify live → keyless first, keyed retry on 401/403 (the
 *   both-ways hedge; their examples print urls directly = presigned
 *   expectation). Download is immediate and server-side (house rule).
 * - No-key ladder (probed live): empty POST → 401
 *   `{"message":"Unauthorized"}` — that 401 is the probe's
 *   credentials-rejected signal; with a valid key an empty body 400s
 *   (validation reached = auth accepted). 402 = compute-units balance
 *   exhausted (API billing is separate from consumer plans).
 * - seed: 18/31 schemas carry it — sent only when the model's schema
 *   has the field. No negative prompt / steps / sampler on image
 *   schemas (a single ideogram-only negative field → capability off).
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
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

export class KreaImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "KreaImageError";
    this.status = options?.status;
  }
}

export class KreaImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KreaImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** Their docs' canonical example model — the fresh-profile default. */
export const KREA_DEFAULT_MODEL = "krea/krea-2/medium";

/** Statuses that keep polling (the schema-verified enum;
 *  `intermediate-complete` carries partial results but the job runs on). */
const NON_TERMINAL_JOB_STATUSES = new Set([
  "backlogged",
  "queued",
  "scheduled",
  "processing",
  "sampling",
  "intermediate-complete",
]);

/** Poll cadence: 1 s → doubling per 30 s → 5 s cap (the bfl/fal/replicate
 *  shape). Budget 150 s — inside the 3-minute cloud timeout. */
const POLL_INITIAL_INTERVAL_MS = 1_000;
const POLL_INTERVAL_CAP_MS = 5_000;
const POLL_BACKOFF_WINDOW_MS = 30_000;
const POLL_TOTAL_BUDGET_MS = 150_000;

/** Real production wait (the test seam overrides this — no sleeps in
 *  tests). */
const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory spec cache TTL — the spec is 1.7 MB and the model list +
 *  schemas change at vendor cadence, not per request. */
const KREA_SPEC_TTL_MS = 10 * 60_000;

// ─── Spec catalog ────────────────────────────────────────────────────────────

/** One model's request-schema digest — everything the adapter needs to
 *  build a STRICT-compliant body (fields present, aspect/resolution
 *  enums, required keys). */
export interface KreaModelCard {
  modelId: string;
  /** The spec's operation summary ("Krea 2 Medium") — the picker label. */
  summary: string;
  /** Schema property keys (the additionalProperties:false gate). */
  properties: ReadonlySet<string>;
  /** `aspect_ratio` enum when the model exposes one. */
  aspectRatios?: readonly string[];
  /** `resolution` enum when the model exposes one (["1K"] today). */
  resolutions?: readonly string[];
  /** Whether the schema declares `width`/`height` pixel fields. */
  pixelSize: boolean;
}

export interface KreaCatalog {
  models: ReadonlyMap<string, KreaModelCard>;
  list: readonly ImageGenModelInfo[];
}

/** Parse the spec's image-model surface. Defensive by design: a path
 *  without a JSON-body POST (or a schema-less body) is skipped, never
 *  thrown — the live spec is truth, not a promise. */
export function parseKreaCatalog(spec: unknown): KreaCatalog {
  const models = new Map<string, KreaModelCard>();
  const list: ImageGenModelInfo[] = [];
  if (typeof spec !== "object" || spec === null) return { models, list };
  const paths = (spec as Record<string, unknown>).paths;
  if (typeof paths !== "object" || paths === null) return { models, list };
  const prefix = "/generate/image/";
  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!path.startsWith(prefix)) continue;
    const modelId = path.slice(prefix.length);
    if (modelId.length === 0 || modelId.endsWith("/")) continue;
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const post = (pathItem as Record<string, unknown>).post;
    if (typeof post !== "object" || post === null) continue;
    const schema = readRequestSchema(post as Record<string, unknown>);
    const propertiesRecord =
      schema !== null && typeof schema.properties === "object" && schema.properties !== null
        ? (schema.properties as Record<string, unknown>)
        : {};
    const properties = new Set<string>(Object.keys(propertiesRecord));
    if (!properties.has("prompt")) continue;
    const summary =
      typeof (post as Record<string, unknown>).summary === "string"
        ? ((post as Record<string, unknown>).summary as string)
        : modelId;
    const card: KreaModelCard = {
      modelId,
      summary,
      properties,
      aspectRatios: readStringEnum(schema, "aspect_ratio"),
      resolutions: readStringEnum(schema, "resolution"),
      pixelSize: properties.has("width") && properties.has("height"),
    };
    models.set(modelId, card);
    list.push({ id: modelId, label: summary });
  }
  list.sort((a, b) => a.label.localeCompare(b.label));
  return { models, list };
}

function readRequestSchema(post: Record<string, unknown>): Record<string, unknown> | null {
  const body = post.requestBody;
  if (typeof body !== "object" || body === null) return null;
  const content = (body as Record<string, unknown>).content;
  if (typeof content !== "object" || content === null) return null;
  const json = (content as Record<string, unknown>)["application/json"];
  if (typeof json !== "object" || json === null) return null;
  const schema = (json as Record<string, unknown>).schema;
  return typeof schema === "object" && schema !== null
    ? (schema as Record<string, unknown>)
    : null;
}

function readStringEnum(
  schema: Record<string, unknown> | null,
  field: string,
): readonly string[] | undefined {
  if (schema === null) return undefined;
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const fieldSchema = (properties as Record<string, unknown>)[field];
  if (typeof fieldSchema !== "object" || fieldSchema === null) return undefined;
  const values = (fieldSchema as Record<string, unknown>).enum;
  if (!Array.isArray(values)) return undefined;
  const strings = values.filter((value): value is string => typeof value === "string");
  return strings.length > 0 ? strings : undefined;
}

// ─── Size mapping ────────────────────────────────────────────────────────────

/** Exact W:H reduction first, else the nearest ratio by log distance
 *  (the replicate/google precedent) — generalized over the MODEL'S OWN
 *  live enum (krea-2: 9 ratios; z-image: 5; per-vendor divergence is the
 *  spec's, not ours). */
export function mapKreaAspectRatio(
  ratios: readonly string[],
  width?: number,
  height?: number,
): string | undefined {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  if (ratios.length === 0) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const reduced = `${width / divisor}:${height / divisor}`;
  if (ratios.includes(reduced)) return reduced;
  const target = Math.log(width / height);
  let best = ratios[0] as string;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of ratios) {
    const parts = ratio.split(":");
    if (parts.length !== 2) continue;
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ratio;
    }
  }
  return best;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface KreaImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): KreaImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a /v1-suffixed base keeps working (Krea's API has
  // no /v1 — the OpenAI-compatible normalize appends one, strip it).
  if (endpoint.endsWith("/v1")) {
    endpoint = endpoint.slice(0, -"/v1".length);
  }
  if (!endpoint) {
    throw new KreaImageConfigError("Krea config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new KreaImageConfigError("Krea config error: `apiKey` is required (the Bearer API token)");
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
    throw new KreaImageError(
      `Krea ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** The in-memory spec cache (endpoint → {catalog, expiresAt}). Tests
 *  reset it through the exported seam. */
const specCache = new Map<string, { catalog: KreaCatalog; expiresAt: number }>();

export function resetKreaSpecCacheForTests(): void {
  specCache.clear();
}

async function getKreaCatalog(params: {
  endpoint: string;
  apiKey: string;
  transport: typeof fetch;
  signal?: AbortSignal;
  force?: boolean;
  now?: () => number;
}): Promise<KreaCatalog> {
  const now = params.now ?? Date.now;
  const cached = specCache.get(params.endpoint);
  if (!params.force && cached !== undefined && cached.expiresAt > now()) {
    return cached.catalog;
  }
  // The spec is PUBLIC (fetched anonymously for this integration's own
  // research); the Bearer key rides the call anyway — same acceptance
  // pattern as the nanogpt image-models listing.
  const response = await fetchOrWrap(
    params.transport,
    `${params.endpoint}/openapi.json`,
    { method: "GET", headers: buildHeaders(params.apiKey, false), signal: params.signal },
    "spec fetch",
  );
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new KreaImageError(
      `Krea spec fetch failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const spec: unknown = await response.json().catch(() => null);
  const catalog = parseKreaCatalog(spec);
  if (catalog.list.length === 0) {
    throw new KreaImageError("Krea spec carried no image models (unexpected shape)");
  }
  specCache.set(params.endpoint, { catalog, expiresAt: now() + KREA_SPEC_TTL_MS });
  return catalog;
}

/** Best-effort job cancel — returns instead of throwing so the original
 *  error/abort is never masked (the aihorde/fal/replicate precedent). */
async function cancelKreaJob(
  transport: typeof fetch,
  endpoint: string,
  jobId: string,
  apiKey: string,
): Promise<void> {
  await fetchOrWrap(
    transport,
    `${endpoint}/jobs/${jobId}`,
    { method: "DELETE", headers: buildHeaders(apiKey, false) },
    "job cancel",
  ).catch(() => undefined);
}

/** Poll a job until `completed`; resolves with the job root. Exported as
 *  the test seam: `wait` defaults to the real sleep; tests inject an
 *  instant resolver and a scripted fetch (no sleeps in tests — R5). */
export async function pollKreaJob(params: {
  jobId: string;
  endpoint: string;
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
      `${params.endpoint}/jobs/${params.jobId}`,
      {
        method: "GET",
        headers: buildHeaders(params.apiKey, false),
        signal: params.signal,
      },
      "job poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new KreaImageError(
        `Krea job poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new KreaImageError("Krea job poll returned a non-object payload");
    }
    const root = payload as Record<string, unknown>;
    const status = root.status;
    if (status === "completed") return root;
    if (typeof status === "string" && NON_TERMINAL_JOB_STATUSES.has(status)) {
      if (elapsed >= POLL_TOTAL_BUDGET_MS) {
        throw new KreaImageError(
          `Krea job did not complete within ${POLL_TOTAL_BUDGET_MS / 1000}s (last status: ${status})`,
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
    // failed | cancelled | unrecognized — terminal, fail closed with the
    // raw status (never an infinite poll on a schema drift).
    const errorPart = readKreaJobError(root.error);
    throw new KreaImageError(`Krea job ended with status ${String(status)}${errorPart}`);
  }
}

function readKreaJobError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : null;
  const message = typeof record.message === "string" && record.message.length > 0
    ? record.message
    : null;
  if (code === null && message === null) return "";
  return `: ${[code, message].filter((part) => part !== null).join(" — ")}`;
}

/** `result.urls` is a 3-way union (string[] | {type,url}[] | url map) —
 *  collect model URLs, skip `preview` entries, first wins. */
function extractKreaImageUrls(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const urls = (result as Record<string, unknown>).urls;
  const out: string[] = [];
  if (Array.isArray(urls)) {
    for (const entry of urls) {
      if (typeof entry === "string" && entry.length > 0) {
        out.push(entry);
      } else if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        const url = record.url;
        if (typeof url === "string" && url.length > 0 && record.type !== "preview") {
          out.push(url);
        }
      }
    }
    return out;
  }
  if (typeof urls === "object" && urls !== null) {
    const record = urls as Record<string, unknown>;
    const model = record["model"];
    if (typeof model === "string" && model.length > 0) return [model];
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value.length > 0) out.push(value);
    }
  }
  return out;
}

/** URL auth is undocumented (no key available to verify live) — keyless
 *  first, keyed retry on 401/403, downloaded immediately server-side. */
async function downloadKreaImage(
  cfg: KreaImageConfig,
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ data: Buffer; mimeType: string }> {
  let response = await fetchOrWrap(
    cfg.fetch,
    url,
    { method: "GET", signal },
    "image download",
  );
  if (response.status === 401 || response.status === 403) {
    response = await fetchOrWrap(
      cfg.fetch,
      url,
      { method: "GET", headers: buildHeaders(cfg.apiKey, false), signal },
      "image download retry",
    );
  }
  if (!response.ok) {
    throw new KreaImageError(`Krea image download failed with HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return {
    data: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") ?? "image/png",
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const kreaImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || KREA_DEFAULT_MODEL;

      // The model's own schema gates every field (additionalProperties:
      // false upstream). A miss on the cached catalog forces one refresh
      // (new vendor models land between TTLs).
      let catalog = await getKreaCatalog({
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        transport: cfg.fetch,
        signal: request.signal,
      });
      let card = catalog.models.get(model);
      if (card === undefined) {
        catalog = await getKreaCatalog({
          endpoint: cfg.endpoint,
          apiKey: cfg.apiKey,
          transport: cfg.fetch,
          signal: request.signal,
          force: true,
        });
        card = catalog.models.get(model);
      }
      if (card === undefined) {
        throw new KreaImageError(`Krea model "${model}" is not in the live spec catalog`);
      }

      // Strict-body assembly: every field checked against the model's
      // schema. Params-unset discipline — a field the user left alone is
      // not sent; the vendor default stands.
      const body: Record<string, unknown> = { prompt: request.prompt };
      const has = (field: string): boolean => card!.properties.has(field);
      if (has("aspect_ratio") && card.aspectRatios !== undefined) {
        const aspectRatio = mapKreaAspectRatio(card.aspectRatios, request.width, request.height);
        if (aspectRatio !== undefined) {
          body.aspect_ratio = aspectRatio;
        }
      }
      if (has("resolution") && card.resolutions !== undefined) {
        // The enum is a single "1K" today; the LIVE enum's first entry is
        // sent so a vendor addition rides without a code change.
        body.resolution = card.resolutions[0];
      }
      if (card.pixelSize) {
        if (request.width !== undefined) body.width = Math.round(request.width);
        if (request.height !== undefined) body.height = Math.round(request.height);
      }
      if (has("seed") && request.seed !== undefined) {
        body.seed = request.seed;
      }
      // Prompt-expansion policy (owner 2026-09-26): authored full-form
      // prompts — no vendor expansion by default, user-tunable per model.
      if (has("creativity")) {
        body.creativity = request.krea?.creativity ?? "raw";
      }
      if (has("skip_prompt_expansion")) {
        body.skip_prompt_expansion = true;
      }
      // K2 generative sliders (prompt untouched by design; unsent = 0).
      if (has("intensity") && request.krea?.intensity !== undefined) {
        body.intensity = request.krea.intensity;
      }
      if (has("complexity") && request.krea?.complexity !== undefined) {
        body.complexity = request.krea.complexity;
      }
      if (has("movement") && request.krea?.movement !== undefined) {
        body.movement = request.krea.movement;
      }
      // negative_prompt / steps / sampler: absent from the image schemas
      // (one ideogram-only exception → capability off, wire never carries).

      const submit = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/generate/image/${model}`,
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
        const balanceNote = submit.status === 402
          ? " — workspace API balance (compute units) exhausted; API billing is separate from Krea consumer plans"
          : "";
        throw new KreaImageError(
          `Krea generation failed with HTTP ${submit.status}${excerpt ? `: ${excerpt}` : ""}${balanceNote}`,
          { status: submit.status },
        );
      }
      const submitted: unknown = await submit.json().catch(() => null);
      if (typeof submitted !== "object" || submitted === null) {
        throw new KreaImageError("Krea generation returned a non-object payload");
      }
      const jobId = (submitted as Record<string, unknown>).job_id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        throw new KreaImageError("Krea submit response is missing `job_id`");
      }

      try {
        const completed = await pollKreaJob({
          jobId,
          endpoint: cfg.endpoint,
          apiKey: cfg.apiKey,
          fetch: cfg.fetch,
          signal: request.signal,
        });

        const urls = extractKreaImageUrls(completed.result);
        if (urls.length === 0) {
          throw new KreaImageError("Krea completed job carried no result URL");
        }

        const image = await downloadKreaImage(cfg, urls[0] as string, request.signal);
        return { images: [image] };
      } catch (error) {
        // Best-effort cancel on ANY failure path out (the owner's Stop
        // frees the compute slot). A dead cancel never masks the error.
        await cancelKreaJob(cfg.fetch, cfg.endpoint, jobId, cfg.apiKey);
        throw error;
      }
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      const catalog = await getKreaCatalog({
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey,
        transport: cfg.fetch,
        signal,
      });
      return [...catalog.list];
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the default krea-2 endpoint:
      // an empty body can never generate — live ladder: 401
      // {"message":"Unauthorized"} = creds rejected; any other 4xx =
      // validation reached (auth accepted).
      try {
        const response = await cfg.fetch(
          `${cfg.endpoint}/generate/image/${KREA_DEFAULT_MODEL}`,
          {
            method: "POST",
            headers: buildHeaders(cfg.apiKey, true),
            body: JSON.stringify({}),
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
          return { ok: false, detail: "404: generate endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: "credentials accepted — model catalog parsed from the live spec" };
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
registerImageGenBackend(IMAGE_GEN_BACKENDS.Krea, kreaImageFactory);
