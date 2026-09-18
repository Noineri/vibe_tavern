/**
 * @module imagegen/backends/nim
 *
 * NVIDIA hosted image generation (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave
 * PE-2 unit 5) — the build.nvidia.com catalog's PER-MODEL custom JSON
 * endpoints on `ai.api.nvidia.com` (NOT OpenAI-compat /v1/images — that
 * path exists only on self-hosted NIM containers). Every request schema
 * below traces to the owner's MHTML saves of the three endpoint reference
 * pages (doc-verified 2026-09-07; the docs hub is SPA-walled for fetchers
 * — the wall re-confirmed 2026-09-18) + supervisor live probes:
 *
 * - Paths live-probed 2026-09-18 (401 auth-wall = exists, 404 = wrong
 *   slug): `black-forest-labs/flux.1-dev`, `black-forest-labs/flux.1-schnell`,
 *   `black-forest-labs/flux.2-klein-4b`, `stabilityai/stable-diffusion-xl`,
 *   `stabilityai/stable-diffusion-3-medium` — all five verified; the
 *   hyphenated `stability-ai/*` form 404s (noted so nobody "fixes" it).
 * - `flux.1-dev` schema (MHTML): `prompt` ≤10 000, `width`/`height`
 *   768–1344 (default 1024; the page's preview-API note says only 1024
 *   currently works — sent verbatim anyway, the range is the documented
 *   contract), `cfg_scale` ≤9 (5), `seed` ≥0 (0=random), `steps` 5–100
 *   (50), `mode` base|canny|depth (canny/depth need an image input — no
 *   VT seam → never sent), `samples` =1 (never sent). flux.1-schnell and
 *   flux.2-klein-4b ride the same BFL/NIM visual-genai family schema
 *   (klein's own page was not fetchable through the SPA wall — the family
 *   assumption is commented here as such).
 * - `stable-diffusion-xl` schema (MHTML): `text_prompts` array of 1–2
 *   `{text, weight}` where **weight −1 IS the negative prompt** (the only
 *   mechanism — VT's negativePrompt becomes the second entry), `width`/
 *   `height` FIXED 1024 (never sent), `cfg_scale` ≤9 (5), **`sampler`
 *   enum DDIM / K_EULER_ANCESTRAL / K_LMS / K_DPM_2_ANCESTRAL — the one
 *   hosted vendor with a sampler parameter** (default K_DPM_2_ANCESTRAL),
 *   `seed`, `steps` 5–100 (25), `clip_guidance_preset` NONE-only and
 *   `style_preset` "none"-only (never sent), `samples` =1.
 * - `stable-diffusion-3-medium` schema (MHTML): `prompt` ≤10 000,
 *   **`negative_prompt` first-class**, `aspect_ratio` enum
 *   1:1(def)/16:9/9:16/5:4/4:5/3:2/2:3 — VT's W×H maps by exact fraction
 *   match, else the NEAREST documented ratio (deterministic, documented
 *   values only — a named decision), `cfg_scale` ≤9 (5), `seed`,
 *   `steps` 5–100 (50), `output_format` jpeg-only (never sent).
 * - Response: 200 `{artifacts: [{base64, finishReason?, mime_type?}]}`
 *   (docs.nvidia.com getting-started + a real call site both read
 *   `artifacts[0].base64`); some newer endpoints mirror OpenAI's
 *   `data[].b64_json` (observed in a third-party connector) — parsed as
 *   the fallback. **202 + NVCF-REQID (async) is a real possibility on
 *   these endpoints (observed in the same connector) — NOT in v1: a clear
 *   typed error, never a silent no-op.**
 * - No model-listing endpoint on ai.api.nvidia.com (GET /v1/models is the
 *   LLM side) → STATIC catalog of the five verified models. Probe:
 *   invalid-post on the flux.1-dev path ({} — live-probed 401 without a
 *   key; an empty body can never generate).
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
  ImageGenSamplerInfo,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import {
  normalizeOpenAiCompatibleBaseUrl,
  buildHeaders,
} from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class NimImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "NimImageError";
    this.status = options?.status;
  }
}

export class NimImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** The five verified per-model paths (publisher/slug — live-probed 2026-09-18;
 *  the model id the picker offers IS the path suffix). */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: "black-forest-labs/flux.1-dev", label: "FLUX.1 Dev" },
  { id: "black-forest-labs/flux.1-schnell", label: "FLUX.1 Schnell" },
  { id: "black-forest-labs/flux.2-klein-4b", label: "FLUX.2 Klein 4B" },
  { id: "stabilityai/stable-diffusion-xl", label: "Stable Diffusion XL" },
  { id: "stabilityai/stable-diffusion-3-medium", label: "Stable Diffusion 3 Medium" },
];

/** The SDXL sampler enum — the one hosted vendor exposing a sampler
 *  parameter (static listSamplers source). */
const SDXL_SAMPLERS: readonly ImageGenSamplerInfo[] = [
  { name: "DDIM" },
  { name: "K_EULER_ANCESTRAL" },
  { name: "K_LMS" },
  { name: "K_DPM_2_ANCESTRAL" },
];

/** SD3's documented aspect-ratio enum (width:height in px for the nearest
 *  match — the ratio values are the DOCUMENTED wire strings). */
const SD3_ASPECT_RATIOS: readonly { ratio: string; width: number; height: number }[] = [
  { ratio: "1:1", width: 1, height: 1 },
  { ratio: "16:9", width: 16, height: 9 },
  { ratio: "9:16", width: 9, height: 16 },
  { ratio: "5:4", width: 5, height: 4 },
  { ratio: "4:5", width: 4, height: 5 },
  { ratio: "3:2", width: 3, height: 2 },
  { ratio: "2:3", width: 2, height: 3 },
];

/** Map a W×H onto SD3's documented ratio enum: exact fraction match, else
 *  the NEAREST ratio by |log(w/h) − log(rw/rh)| distance (deterministic,
 *  documented enum values only — the named decision from the module doc). */
export function mapSd3AspectRatio(width: number, height: number): string {
  for (const entry of SD3_ASPECT_RATIOS) {
    if (width * entry.height === height * entry.width) return entry.ratio;
  }
  const target = Math.log(width / height);
  let best = SD3_ASPECT_RATIOS[0];
  let bestDistance = Math.abs(target - Math.log(best.width / best.height));
  for (const entry of SD3_ASPECT_RATIOS.slice(1)) {
    const distance = Math.abs(target - Math.log(entry.width / entry.height));
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best.ratio;
}

function isSdxlModel(model: string): boolean {
  return model.endsWith("stable-diffusion-xl");
}

function isSd3Model(model: string): boolean {
  return model.endsWith("stable-diffusion-3-medium");
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface NimImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): NimImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a full per-model URL keeps working.
  const genaiAt = endpoint.indexOf("/genai/");
  if (genaiAt !== -1) {
    endpoint = endpoint.slice(0, genaiAt);
  }
  if (!endpoint) {
    throw new NimImageConfigError("NVIDIA config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new NimImageConfigError(
      "NVIDIA config error: `apiKey` is required (the card has no keyless surface)",
    );
  }
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, fetch: config.fetch ?? fetch };
}

// ─── Response parsing ────────────────────────────────────────────────────────

/** Pull decoded bytes out of the documented `artifacts[].base64` shape
 *  (primary) or the OpenAI-mirror `data[].b64_json` (fallback, observed on
 *  newer endpoints). mime_type rides along when the entry carries it. */
function extractArtifactImages(payload: unknown): { data: Buffer; mimeType?: string }[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as Record<string, unknown>;
  const out: { data: Buffer; mimeType?: string }[] = [];
  const artifacts = root.artifacts;
  if (Array.isArray(artifacts)) {
    for (const entry of artifacts) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const b64 = typeof item.base64 === "string" && item.base64.length > 0 ? item.base64 : undefined;
      if (b64 === undefined) continue;
      const data = Buffer.from(b64, "base64");
      if (data.length === 0) continue;
      out.push({
        data,
        mimeType: typeof item.mime_type === "string" ? item.mime_type : undefined,
      });
    }
    if (out.length > 0) return out;
  }
  const data = root.data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const b64 = typeof item.b64_json === "string" && item.b64_json.length > 0 ? item.b64_json : undefined;
      if (b64 === undefined) continue;
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) continue;
      out.push({ data: bytes });
    }
  }
  return out;
}

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
  return null;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const nimImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model;
      if (!model) {
        throw new NimImageConfigError(
          "NVIDIA config error: `model` is required (the verified catalog: " +
            STATIC_MODELS.map((m) => m.id).join(", ") +
            ")",
        );
      }
      const sdxl = isSdxlModel(model);
      const sd3 = isSd3Model(model);

      // Per-model body builders — the three MHTML-documented schemas.
      let body: Record<string, unknown>;
      if (sdxl) {
        // text_prompts: the positive entry (weight 1) + the negative as a
        // weight −1 entry — the ONLY negative mechanism on SDXL.
        const textPrompts: Array<{ text: string; weight: number }> = [
          { text: request.prompt, weight: 1 },
        ];
        if (request.negativePrompt !== undefined && request.negativePrompt !== "") {
          textPrompts.push({ text: request.negativePrompt, weight: -1 });
        }
        body = { text_prompts: textPrompts };
        // width/height are FIXED 1024 upstream — never sent.
        if (request.cfgScale !== undefined) body.cfg_scale = request.cfgScale;
        if (request.sampler !== undefined && request.sampler !== "") body.sampler = request.sampler;
      } else if (sd3) {
        body = { prompt: request.prompt };
        if (request.negativePrompt !== undefined && request.negativePrompt !== "") {
          body.negative_prompt = request.negativePrompt;
        }
        if (request.width !== undefined && request.height !== undefined) {
          body.aspect_ratio = mapSd3AspectRatio(request.width, request.height);
        }
        if (request.cfgScale !== undefined) body.cfg_scale = request.cfgScale;
      } else {
        // The BFL/FLUX family schema (flux.1-dev MHTML; schnell/klein ride
        // the same family surface — the documented range is the contract).
        body = { prompt: request.prompt };
        if (request.width !== undefined) body.width = request.width;
        if (request.height !== undefined) body.height = request.height;
        if (request.cfgScale !== undefined) body.cfg_scale = request.cfgScale;
        // Negative prompt has NO surface on FLUX — dropped (never folded).
      }
      // Shared numeric fields (all three schemas document them).
      if (request.seed !== undefined) body.seed = request.seed;
      if (request.steps !== undefined) body.steps = request.steps;
      // mode/samples/clip_guidance_preset/style_preset/output_format/
      // model(sd3): fixed-value or no-seam fields — never sent.

      const response = await cfg.fetch(`${cfg.endpoint}/genai/${model}`, {
        method: "POST",
        headers: buildHeaders(cfg.apiKey, true),
        body: JSON.stringify(body),
        signal: request.signal,
      }).catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === "AbortError") throw cause;
        throw new NimImageError(
          `NVIDIA generation network error: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      });

      if (response.status === 202) {
        // A real possibility on these endpoints (observed) — out of v1
        // scope: a clear error, never a silent no-op.
        throw new NimImageError(
          "NVIDIA returned 202 (async NVCF job) — async generation is not supported by this backend in v1",
          { status: 202 },
        );
      }
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new NimImageError(
          `NVIDIA generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const extracted = extractArtifactImages(payload);
      if (extracted.length === 0) {
        throw new NimImageError("NVIDIA response carried no artifacts (expected artifacts[].base64)");
      }
      const images: ImageGenGeneratedImage[] = extracted.map((entry) => ({
        data: entry.data,
        mimeType: entry.mimeType ?? sniffImageMime(entry.data) ?? "image/png",
      }));

      const result: ImageGenGenerateResult = { images };
      if (sdxl) {
        // Documented FIXED 1024×1024 — the only size this model produces.
        result.width = 1024;
        result.height = 1024;
      }
      return result;
    },

    async listModels(): Promise<ImageGenModelInfo[]> {
      // No model-listing endpoint on ai.api.nvidia.com — the five
      // live-verified per-model paths ARE the catalog.
      return STATIC_MODELS.map((m) => ({ ...m }));
    },

    listSamplers(): Promise<ImageGenSamplerInfo[]> {
      // SDXL's documented sampler enum — the one hosted vendor with a
      // sampler parameter (sent only for sdxl models).
      return Promise.resolve(SDXL_SAMPLERS.map((s) => ({ ...s })));
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the (probed) flux.1-dev path:
      // {} can never generate — 401/403 = bad key, 404 = wrong endpoint,
      // other 4xx = validation reached (auth passed). Live-probed: no key
      // → 401.
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/genai/black-forest-labs/flux.1-dev`, {
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
          return { ok: false, detail: "404: genai endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: `credentials accepted — 5 static models` };
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
registerImageGenBackend(IMAGE_GEN_BACKENDS.Nim, nimImageFactory);
