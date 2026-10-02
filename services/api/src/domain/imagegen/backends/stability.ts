/**
 * @module imagegen/backends/stability
 *
 * Stability AI image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-4
 * unit 2) — the v2beta Stable Image generate services. The roster's FIRST
 * multipart/form-data arm: bodies are `FormData` (the fetch layer sets the
 * multipart boundary — the docs explicitly say NOT to set Content-Type by
 * hand), auth is `Authorization: Bearer sk-…`, and with
 * `accept: image/*` the service answers RAW image bytes.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Stability AI",
 * doc-verified 2026-09-07 from an owner-supplied MHTML capture; re-verified
 * live 2026-09-18 — the JS wall is gone, the full API reference scraped
 * server-side):
 * - Three text-to-image services, `POST https://api.stability.ai/v2beta/
 *   stable-image/generate/{ultra|core|sd3}`: Ultra (SD3.5-based flagship,
 *   8 credits, 1 MP out), Core (fast SDXL-next, 3 credits, 1.5 MP), SD3.5
 *   (raw base models, the `model` form field selects the variant).
 * - The VT model id ROUTES the service: `ultra`/`core` → their dedicated
 *   endpoints (no `model` field); anything else → the sd3 endpoint with
 *   the id as the `model` field (free text covers future sd3.5 releases;
 *   documented default `sd3.5-large` when nothing is set). **Soft drift
 *   pinned live 2026-09-18: `sd3.5-flash` (2.5 credits) is now documented
 *   in the model field's own description but still missing from the schema
 *   enum table** — it rides the free-text field, static catalog includes
 *   it.
 * - Shared form fields: `prompt` [1..10000] (`(word:weight)` weighting),
 *   `negative_prompt` ≤10000, `aspect_ratio` enum {16:9, 1:1 (default),
 *   21:9, 2:3, 3:2, 4:5, 5:4, 9:16, 9:21}, `seed` 0–4294967294 (omit/0 =
 *   random), `style_preset` 18 values, `output_format` jpeg|png|webp
 *   (png default). sd3-only: `cfg_scale` 1–10 (Large/Medium default 4,
 *   Turbo/Flash 1), `mode` text-to-image (default). VT has no
 *   style-preset/output-format/steps/sampler seam → those are NEVER sent
 *   (steps are baked per model); cfgScale rides ONLY the sd3 endpoint.
 * - Width/height map onto `aspect_ratio` — nearest documented ratio by
 *   log distance (the mapSd3AspectRatio precedent; the pixel output is
 *   fixed per service, so a ratio is the only size knob).
 * - Response: `accept: image/*` → the bytes of the generated image
 *   (content-type = the output_format); MIME is sniffed from magic bytes
 *   with the content-type as fallback. No URL/expiry concern.
 * - Errors: 400 invalid params (`errors` field), 403 content moderation,
 *   413 too large, 422 rejected, 429 rate limit (150 req/10 s), 500.
 *   **Probe note: api.stability.ai is TLS-unreachable from the dev
 *   machine (proxy kills the handshake), so no live probe — the
 *   invalid-post discrimination is pinned from the documented response
 *   codes: 401/403 = rejected, other 4xx = validation reached = accepted,
 *   5xx = fail** (card note logged).
 * - Model listing: NO public catalog on the v2beta API (the v1
 *   `GET /v1/engines/list` serves the LEGACY SDXL engine family, a
 *   different model generation) — static six-entry catalog.
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

export class StabilityImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "StabilityImageError";
    this.status = options?.status;
  }
}

export class StabilityImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StabilityImageConfigError";
  }
}

// ─── Documented surface (card + live scrape 2026-09-18) ─────────────────────

/** The documented aspect-ratio enum (9 values). Ratio values are the
 *  DOCUMENTED wire strings. */
const STABILITY_ASPECT_RATIOS: readonly { ratio: string; width: number; height: number }[] = [
  { ratio: "1:1", width: 1, height: 1 },
  { ratio: "16:9", width: 16, height: 9 },
  { ratio: "9:16", width: 9, height: 16 },
  { ratio: "21:9", width: 21, height: 9 },
  { ratio: "9:21", width: 9, height: 21 },
  { ratio: "3:2", width: 3, height: 2 },
  { ratio: "2:3", width: 2, height: 3 },
  { ratio: "5:4", width: 5, height: 4 },
  { ratio: "4:5", width: 4, height: 5 },
];

/** Map a W×H onto Stability's documented ratio set: exact fraction match,
 *  else the NEAREST ratio by |log(w/h) − log(rw/rh)| (deterministic,
 *  documented enum values only — the mapSd3AspectRatio precedent).
 *  Exported as the test seam. */
export function mapStabilityAspectRatio(width: number, height: number): string {
  for (const entry of STABILITY_ASPECT_RATIOS) {
    if (width * entry.height === height * entry.width) return entry.ratio;
  }
  const target = Math.log(width / height);
  let best = STABILITY_ASPECT_RATIOS[0];
  let bestDistance = Math.abs(target - Math.log(best.width / best.height));
  for (const entry of STABILITY_ASPECT_RATIOS.slice(1)) {
    const distance = Math.abs(target - Math.log(entry.width / entry.height));
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best.ratio;
}

/** Static service catalog — the three services + the four documented sd3.5
 *  variants (sd3.5-flash: documented in the model description, absent from
 *  the schema enum — soft drift pinned 2026-09-18). */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: "ultra", label: "Stable Image Ultra (SD3.5 flagship)" },
  { id: "core", label: "Stable Image Core (fast)" },
  { id: "sd3.5-large", label: "SD 3.5 Large" },
  { id: "sd3.5-large-turbo", label: "SD 3.5 Large Turbo" },
  { id: "sd3.5-medium", label: "SD 3.5 Medium" },
  { id: "sd3.5-flash", label: "SD 3.5 Flash" },
];

/** The sd3 model field's documented default (also the profile default). */
const DEFAULT_MODEL = "sd3.5-large";

// ─── Config ──────────────────────────────────────────────────────────────────

interface StabilityImageConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): StabilityImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a full service URL keeps working.
  for (const suffix of [
    "/v2beta/stable-image/generate/ultra",
    "/v2beta/stable-image/generate/core",
    "/v2beta/stable-image/generate/sd3",
    "/v2beta/stable-image/generate",
    "/v2beta/stable-image",
    "/v2beta",
  ]) {
    if (endpoint.endsWith(suffix)) {
      endpoint = endpoint.slice(0, -suffix.length);
      break;
    }
  }
  if (!endpoint) {
    throw new StabilityImageConfigError("Stability config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new StabilityImageConfigError(
      "Stability config error: `apiKey` is required (the card has no keyless surface)",
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
    throw new StabilityImageError(
      `Stability ${operation} network error: ${
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

/** The service path a model id routes to (the module doc's routing rule). */
function servicePath(model: string): string {
  if (model === "ultra" || model === "core") return `/v2beta/stable-image/generate/${model}`;
  return "/v2beta/stable-image/generate/sd3";
}

// ─── Registration ────────────────────────────────────────────────────────────

registerImageGenBackend(
  IMAGE_GEN_BACKENDS.Stability,
  (config: ImageGenAdapterConfig): ImageGenBackend => {
    const parsed = parseConfig(config);

    function buildForm(request: ImageGenGenerateRequest, model: string): FormData {
      const form = new FormData();
      form.set("prompt", request.prompt);
      if (request.negativePrompt !== undefined && request.negativePrompt !== "") {
        form.set("negative_prompt", request.negativePrompt);
      }
      if (request.width !== undefined && request.height !== undefined) {
        form.set("aspect_ratio", mapStabilityAspectRatio(request.width, request.height));
      }
      if (request.seed !== undefined) {
        form.set("seed", String(request.seed));
      }
      if (model !== "ultra" && model !== "core") {
        form.set("model", model);
        // cfg_scale is an sd3-endpoint-only field — Ultra/Core bake it.
        if (request.cfgScale !== undefined) {
          form.set("cfg_scale", String(request.cfgScale));
        }
      }
      // style_preset / output_format / steps / sampler: no VT seam or no
      // surface — NEVER sent (vendor defaults stand).
      return form;
    }

    function stabilityHeaders(): Record<string, string> {
      // accept: image/* — the raw-bytes response form. Content-Type is set
      // by the fetch layer with the multipart boundary (docs: do not set
      // it manually).
      return { Authorization: `Bearer ${parsed.apiKey}`, accept: "image/*" };
    }

    return {
      async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
        const model = request.model?.trim() || parsed.model;
        const response = await fetchOrWrap(
          parsed.fetch,
          `${parsed.endpoint}${servicePath(model)}`,
          {
            method: "POST",
            headers: stabilityHeaders(),
            body: buildForm(request, model),
            signal: request.signal,
          },
          "image generation",
        );
        if (!response.ok) {
          const excerpt = await readProviderErrorBody(response);
          throw new StabilityImageError(
            `Stability image generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: response.status },
          );
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const sniffed = sniffImageMime(bytes);
        const mimeType =
          sniffed ??
          (response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png");
        const image: ImageGenGeneratedImage = { data: bytes, mimeType };
        return { images: [image] };
      },

      async listModels(): Promise<ImageGenModelInfo[]> {
        // No public v2beta catalog — the static six-entry service list
        // (free-text model covers future sd3.5 releases).
        return STATIC_MODELS.map((model) => ({ ...model }));
      },

      async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
        // invalid-post creds discrimination (documented codes — no live
        // probe, see module doc): empty form on the core endpoint. 401/403
        // = rejected; other 4xx = validation reached (prompt missing) =
        // accepted; 5xx = fail.
        try {
          const response = await parsed.fetch(`${parsed.endpoint}/v2beta/stable-image/generate/core`, {
            method: "POST",
            headers: stabilityHeaders(),
            body: new FormData(),
            signal,
          });
          if (response.ok) {
            return { ok: true, detail: "credentials accepted" };
          }
          if (response.status === 401 || response.status === 403) {
            const excerpt = await readProviderErrorBody(response);
            return {
              ok: false,
              detail: `${response.status}${excerpt ? `: ${excerpt}` : ""} — credentials rejected`,
              status: response.status,
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
