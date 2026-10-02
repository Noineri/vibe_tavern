/**
 * @module imagegen/backends/cloudflare
 *
 * Cloudflare Workers AI image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN
 * wave PE-4 unit 4) — the account-scoped run API. The roster's first
 * backend whose ENDPOINT embeds a per-user identifier: the account id
 * lives in the URL path (`…/accounts/{ACCOUNT_ID}/ai/run/{model}`), so
 * the preset baseUrl carries a `<ACCOUNT_ID>` placeholder the user
 * replaces (a wrong id is distinguishable from a wrong token live —
 * see the probe).
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Cloudflare
 * Workers AI", doc-verified 2026-09-07; re-verified live 2026-09-18
 * against developers.cloudflare.com — model pages fetched as .md, the
 * per-model schema-input.json pulled directly, and the run endpoint
 * live-probed):
 * - `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/
 *   ai/run/{model}`, `Authorization: Bearer <API token>` (Workers AI
 *   Read+Edit), JSON body. The curl examples on the model pages use
 *   plain JSON `{"prompt": …, "seed": …}` — NOT OpenAI-shaped (the
 *   OpenAI-compat surface covers chat/embeddings only, card-verified).
 * - Response: `{result, success, errors, messages}` — image models
 *   return `result.image` as a Base64 string (their own example builds
 *   a data-URI from it); `success: false` carries `errors[]` (code +
 *   message). Live probes 2026-09-18: wrong/missing token with a
 *   valid-format account id → **401 code 10000 "Authentication
 *   error"**; malformed account id → **404 code 7003 "Could not route
 *   … perhaps your object identifier is invalid"** (routing happens
 *   BEFORE auth) — the probe distinguishes all three outcomes.
 * - Per-model parameter surfaces (schema-input.json, live 2026-09-18 —
 *   the card's "JS-collapsed, verify at adapter time" caveat CLOSED):
 *   - **schnell family** (`@cf/black-forest-labs/flux-1-schnell`):
 *     `prompt` (1–2048), `steps` ≤8 default 4, `seed`. No dimensions —
 *     fixed output.
 *   - **SDXL family** (`@cf/stabilityai/stable-diffusion-xl-lightning`,
 *     `@cf/lykon/dreamshaper-8-lcm`): `prompt`, `negative_prompt`,
 *     `width`/`height` 256–2048, `num_steps` ≤20 default 20,
 *     `guidance` default 7.5, `seed` — a full classic SD surface.
 *   - **flux-2 family** (`flux-2-dev`, `flux-2-klein-4b/9b`): the
 *     model pages render an EMPTY `multipart{}` parameter block and the
 *     schema is a generic multipart envelope — **fields remain
 *     UNDOCUMENTED** (named decision: the adapter sends `prompt` only,
 *     the universal field every Workers AI image model's own curl
 *     example uses; nothing else is invented).
 * - Named decision (per-model divergence, the ideogram/stability
 *   precedent): negative/steps/cfg/dimensions ride only the family the
 *   schema documents them on — the caps row keeps them (the SDXL
 *   family's real surface), the other families' wires drop them.
 * - Free tier: 10,000 Neurons/day on both Free and Paid plans (reset
 *   00:00 UTC) — the standout real free tier (card).
 * - Model listing: no unauthenticated catalog on the run API — static
 *   curated catalog (the card's image models minus the edit-family
 *   sd-v1.5 img2img/inpainting variants); free-text model covers the
 *   rest of the catalog.
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGeneratedImage,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenModelInfo,
  ImageGenProbeResult,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class CloudflareImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "CloudflareImageError";
    this.status = options?.status;
  }
}

export class CloudflareImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareImageConfigError";
  }
}

// ─── Documented surface (card + live schemas 2026-09-18) ────────────────────

const FLUX_1_SCHNELL = "@cf/black-forest-labs/flux-1-schnell";
const FLUX_2_DEV = "@cf/black-forest-labs/flux-2-dev";
const FLUX_2_KLEIN_4B = "@cf/black-forest-labs/flux-2-klein-4b";
const FLUX_2_KLEIN_9B = "@cf/black-forest-labs/flux-2-klein-9b";
const SDXL_LIGHTNING = "@cf/stabilityai/stable-diffusion-xl-lightning";
const DREAMSHAPER_8_LCM = "@cf/lykon/dreamshaper-8-lcm";

/** Static catalog — the card's t2i models (edit-family variants
 *  excluded); free-text model covers the rest of the catalog. */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: FLUX_1_SCHNELL, label: "FLUX.1 schnell (4 steps, cheapest)" },
  { id: FLUX_2_DEV, label: "FLUX.2 dev (multi-reference)" },
  { id: FLUX_2_KLEIN_4B, label: "FLUX.2 klein 4B" },
  { id: FLUX_2_KLEIN_9B, label: "FLUX.2 klein 9B" },
  { id: SDXL_LIGHTNING, label: "SDXL Lightning (full SD surface)" },
  { id: DREAMSHAPER_8_LCM, label: "DreamShaper 8 LCM" },
];

const DEFAULT_MODEL = FLUX_1_SCHNELL;

/** The parameter family a model id belongs to — the schema-documented
 *  surface selector (unknown ids get the minimal prompt-only wire). */
function modelFamily(model: string): "schnell" | "sdxl" | "flux2" {
  if (model.includes("schnell")) return "schnell";
  if (model.includes("stable-diffusion") || model.includes("dreamshaper") || model.includes("sdxl")) {
    return "sdxl";
  }
  return "flux2";
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface CloudflareImageConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): CloudflareImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a full run URL keeps working (…/ai/run/@cf/… cut
  // back to …/ai); the trailing /run is not part of the base.
  const runMarker = endpoint.indexOf("/ai/run/");
  if (runMarker !== -1) {
    endpoint = endpoint.slice(0, runMarker + "/ai".length);
  } else if (endpoint.endsWith("/run")) {
    endpoint = endpoint.slice(0, -"/run".length);
  }
  if (endpoint.includes("<ACCOUNT_ID>") || endpoint.includes("YOUR_ACCOUNT_ID")) {
    throw new CloudflareImageConfigError(
      "Cloudflare config error: replace <ACCOUNT_ID> in the endpoint with your account id (dashboard: Workers AI → Use REST API)",
    );
  }
  if (!endpoint.includes("/accounts/")) {
    throw new CloudflareImageConfigError(
      "Cloudflare config error: `endpoint` must be https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai",
    );
  }
  if (!endpoint) {
    throw new CloudflareImageConfigError("Cloudflare config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new CloudflareImageConfigError(
      "Cloudflare config error: `apiKey` is required (a Workers AI Read+Edit API token)",
    );
  }
  const model = config.model?.trim() || DEFAULT_MODEL;
  return { endpoint, apiKey, model, fetch: config.fetch ?? fetch };
}

// ─── HTTP + response parsing ─────────────────────────────────────────────────

/** Await a fetch call through the injected seam; the caller's own abort is
 *  rethrown untouched (the shared abort contract). */
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
    throw new CloudflareImageError(
      `Cloudflare ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** MIME sniffing (the family helper's logic, local twin). */
function sniffImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// ─── Registration ────────────────────────────────────────────────────────────

registerImageGenBackend(
  IMAGE_GEN_BACKENDS.Cloudflare,
  (config: ImageGenAdapterConfig): ImageGenBackend => {
    const parsed = parseConfig(config);

    function buildBody(request: ImageGenGenerateRequest, model: string): string {
      const body: Record<string, unknown> = { prompt: request.prompt };
      const family = modelFamily(model);
      if (family === "schnell") {
        if (request.steps !== undefined) body.steps = request.steps;
        if (request.seed !== undefined) body.seed = request.seed;
      } else if (family === "sdxl") {
        if (request.negativePrompt !== undefined && request.negativePrompt !== "") {
          body.negative_prompt = request.negativePrompt;
        }
        if (request.width !== undefined) body.width = request.width;
        if (request.height !== undefined) body.height = request.height;
        if (request.steps !== undefined) body.num_steps = request.steps;
        if (request.cfgScale !== undefined) body.guidance = request.cfgScale;
        if (request.seed !== undefined) body.seed = request.seed;
      }
      // flux2 / unknown: prompt only — fields undocumented (named
      // decision), nothing invented.
      return JSON.stringify(body);
    }

    function cloudflareHeaders(): Record<string, string> {
      return { Authorization: `Bearer ${parsed.apiKey}`, "Content-Type": "application/json" };
    }

    function runUrl(model: string): string {
      return `${parsed.endpoint}/run/${model}`;
    }

    return {
      async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
        const model = request.model?.trim() || parsed.model;
        const response = await fetchOrWrap(
          parsed.fetch,
          runUrl(model),
          {
            method: "POST",
            headers: cloudflareHeaders(),
            body: buildBody(request, model),
            signal: request.signal,
          },
          "image generation",
        );
        if (!response.ok) {
          const excerpt = await readProviderErrorBody(response);
          throw new CloudflareImageError(
            `Cloudflare image generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: response.status },
          );
        }
        const payload: unknown = await response.json();
        const imageBase64 = extractImage(payload);
        if (imageBase64 === null) {
          throw new CloudflareImageError(
            extractFailureDetail(payload) ?? "Cloudflare image generation returned no image",
          );
        }
        const bytes = Buffer.from(imageBase64, "base64");
        const image: ImageGenGeneratedImage = {
          data: bytes,
          mimeType: sniffImageMime(bytes) ?? "image/png",
        };
        return { images: [image] };
      },

      async listModels(): Promise<ImageGenModelInfo[]> {
        // No unauthenticated catalog on the run API — static curated list.
        return STATIC_MODELS.map((model) => ({ ...model }));
      },

      async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
        // invalid-post creds discrimination (live-probed 2026-09-18): {}
        // on the schnell run URL — 401 code 10000 = token rejected;
        // 404 code 7003 = the ACCOUNT ID in the endpoint is wrong (an
        // actionable config error, distinct from auth); 400 = validation
        // reached = accepted; 5xx = fail.
        try {
          const response = await parsed.fetch(runUrl(FLUX_1_SCHNELL), {
            method: "POST",
            headers: cloudflareHeaders(),
            body: JSON.stringify({}),
            signal,
          });
          if (response.ok) {
            return { ok: true, detail: "credentials accepted" };
          }
          const payloadText = await response.text();
          if (response.status === 401 || response.status === 403) {
            return {
              ok: false,
              detail: `HTTP ${response.status} authentication error — token rejected`,
              status: response.status,
            };
          }
          if (response.status === 404 && payloadText.includes("7003")) {
            return {
              ok: false,
              detail: "HTTP 404 could-not-route — the ACCOUNT ID in the endpoint is wrong",
              status: 404,
            };
          }
          if (response.status >= 500) {
            return { ok: false, detail: `HTTP ${response.status}`, status: response.status };
          }
          return {
            ok: true,
            detail: `credentials accepted — validation reached (HTTP ${response.status})`,
          };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      },

      async dispose(): Promise<void> {
        // No persistent resources — the arm is request-scoped.
      },
    };
  },
);

/** Pull the base64 image off a REST response — `{result: {image}}`
 *  (the wrapper), with the bare `{image}` binding shape as a fallback. */
function extractImage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const result = record.result;
  if (typeof result === "object" && result !== null) {
    const image = (result as Record<string, unknown>).image;
    if (typeof image === "string" && image.length > 0) return image;
  }
  if (typeof record.image === "string" && record.image.length > 0) return record.image;
  return null;
}

/** The best failure detail a wrapper carries — `success:false` renders
 *  errors[].message; anything else degrades to null. */
function extractFailureDetail(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.success !== false) {
    return "Cloudflare image generation returned no image (success flag absent)";
  }
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (typeof first === "object" && first !== null) {
      const message = (first as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) {
        return `Cloudflare error: ${message}`;
      }
    }
    if (typeof first === "string") return `Cloudflare error: ${first}`;
  }
  return "Cloudflare image generation failed (success: false, no error detail)";
}
