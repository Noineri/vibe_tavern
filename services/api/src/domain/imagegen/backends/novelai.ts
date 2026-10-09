/**
 * @module imagegen/backends/novelai
 *
 * NovelAI image backend (NOVELAI_PROVIDER_PLAN NAI-5a).
 *
 * fork #1 of ideogram.ts (backends/ideogram.ts)
 * Correspondence: keeps the backend lifecycle, synchronous JSON generation,
 * config parsing, injected fetch seam, static catalog, probe, MIME sniffing,
 * and module-scope registration; differs in the JSON wire, Bearer auth,
 * subscription probe, static models/samplers/schedulers, per-model defaults,
 * and subscription-required error mapping.
 *
 * Wire facts (NOVELAI_PROVIDER_PLAN NAI-5a, research Finding 3; NovelAI web
 * client bundle `_app-a70b21aef518ab63.js`, 2026-10-05; SillyTavern
 * `novelai.js:321-375`):
 * - `POST /ai/generate-image`, Bearer JSON, responds 201
 *   `{images:[{image:<base64>, index, seed}]}`; image bytes are inline.
 * - The body is `{action:"generate", input, model, parameters}`. V4+ adds
 *   v4_prompt/v4_negative_prompt; V5 forces the karras noise schedule.
 * - There is no image catalog endpoint, so models, samplers, and schedulers
 *   are static from the bundle. The subscription probe is `GET
 *   /user/subscription`: 200 accepted, 401 rejected.
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
  ImageGenSchedulerInfo,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";
import { providerError } from "../../../shared/errors.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class NovelAiImageError extends Error {
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "NovelAiImageError";
    this.status = options?.status;
  }
}

export class NovelAiImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NovelAiImageConfigError";
  }
}

// ─── Static NovelAI surface ──────────────────────────────────────────────────

/** NovelAI web client bundle `_app-a70b21aef518ab63.js` (2026-10-05):
 * per-model unset defaults. Kept in one table so the catalog and generation
 * defaults cannot drift apart. */
export const NOVELAI_MODEL_DEFAULTS = {
  "nai-diffusion-5-curated": {
    label: "NovelAI Diffusion V5 Curated",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 7,
  },
  "nai-diffusion-5-full": {
    label: "V5 Full",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 7,
  },
  "nai-diffusion-4-5-curated": {
    label: "V4.5 Curated",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 5,
  },
  "nai-diffusion-4-5-full": {
    label: "V4.5 Full",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 5,
  },
  "nai-diffusion-4-curated-preview": {
    label: "V4 Curated",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 5.5,
  },
  "nai-diffusion-4-full": {
    label: "V4 Full",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 5.5,
  },
  "nai-diffusion-3": {
    label: "Anime V3",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 5,
  },
  "nai-diffusion-furry-3": {
    label: "Furry V3",
    width: 832,
    height: 1216,
    steps: 23,
    sampler: "k_euler_ancestral",
    scale: 6.2,
  },
} as const;

type NovelAiModelId = keyof typeof NOVELAI_MODEL_DEFAULTS;

const DEFAULT_MODEL: NovelAiModelId = "nai-diffusion-5-curated";

const STATIC_SAMPLERS: readonly ImageGenSamplerInfo[] = [
  "k_euler_ancestral",
  "k_euler",
  "k_dpmpp_2m",
  "k_dpmpp_2m_sde",
  "k_dpmpp_sde",
  "k_dpmpp_2s_ancestral",
  "k_dpm_fast",
  "ddim",
].map((name) => ({ name }));

const STATIC_SCHEDULERS: readonly ImageGenSchedulerInfo[] = [
  "karras",
  "native",
  "exponential",
  "polyexponential",
].map((name) => ({ name }));

const SUBSCRIPTION_MESSAGE = "NovelAI image generation needs an active subscription; free-trial generations work only on novelai.net";

function isNovelAiModelId(value: string): value is NovelAiModelId {
  return Object.hasOwn(NOVELAI_MODEL_DEFAULTS, value);
}

function isV4OrLaterModel(model: NovelAiModelId): boolean {
  return model.startsWith("nai-diffusion-4") || model.startsWith("nai-diffusion-5");
}

function isV5Model(model: NovelAiModelId): boolean {
  return model.startsWith("nai-diffusion-5");
}

function randomUint32(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0]!;
}

// ─── Config + wire helpers ───────────────────────────────────────────────────

interface NovelAiImageConfig {
  endpoint: string;
  apiKey: string;
  model?: NovelAiModelId;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): NovelAiImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  if (endpoint.endsWith("/ai/generate-image")) {
    endpoint = endpoint.slice(0, -"/ai/generate-image".length);
  }
  if (!endpoint) {
    throw new NovelAiImageConfigError("NovelAI config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new NovelAiImageConfigError("NovelAI config error: `apiKey` is required (the Bearer key)");
  }
  const requestedModel = config.model?.trim();
  if (requestedModel !== undefined && requestedModel !== "" && !isNovelAiModelId(requestedModel)) {
    throw new NovelAiImageConfigError(`NovelAI config error: unknown image model '${requestedModel}'`);
  }
  return {
    endpoint,
    apiKey,
    ...(requestedModel !== undefined && requestedModel !== "" ? { model: requestedModel } : {}),
    fetch: config.fetch ?? fetch,
  };
}

function resolveModel(request: ImageGenGenerateRequest, config: NovelAiImageConfig): NovelAiModelId {
  const model = request.model?.trim() || config.model || DEFAULT_MODEL;
  if (!isNovelAiModelId(model)) {
    throw new NovelAiImageError(`NovelAI image generation cannot use unknown model '${model}'`);
  }
  return model;
}

function novelAiHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
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
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function buildBody(request: ImageGenGenerateRequest, model: NovelAiModelId): Record<string, unknown> {
  const defaults = NOVELAI_MODEL_DEFAULTS[model];
  const negative = request.negativePrompt ?? "";
  const v4OrLater = isV4OrLaterModel(model);
  const requestedSampler = request.sampler ?? defaults.sampler;
  const sampler = v4OrLater && requestedSampler === "ddim" ? "k_euler_ancestral" : requestedSampler;
  const noiseSchedule = isV5Model(model) ? "karras" : (request.scheduler ?? "karras");
  const parameters: Record<string, unknown> = {
    params_version: 4,
    width: request.width ?? defaults.width,
    height: request.height ?? defaults.height,
    steps: request.steps ?? defaults.steps,
    scale: request.cfgScale ?? defaults.scale,
    cfg_rescale: request.cfgRescale ?? 0,
    sampler,
    noise_schedule: noiseSchedule,
    seed: request.seed ?? randomUint32(),
    n_samples: 1,
    negative_prompt: negative,
    ucPreset: 0,
    // NAI-6a: the vendor block's switch — absent (other backends or a
    // layer-off profile) keeps the NAI-5a wire default of false.
    qualityToggle: request.novelai?.qualityToggle ?? false,
    prefer_brownian: true,
    dynamic_thresholding: false,
    legacy: false,
    legacy_v3_extend: false,
    add_original_image: false,
    controlnet_strength: 1,
    deliberate_euler_ancestral_bug: false,
    // Variety Boost is deliberately never sent (client-side formula is
    // undocumented), so the only legal wire value remains null.
    skip_cfg_above_sigma: null,
    use_coords: false,
    characterPrompts: [],
    reference_image_multiple: [],
    reference_information_extracted_multiple: [],
    reference_strength_multiple: [],
  };
  if (v4OrLater) {
    parameters.v4_prompt = {
      caption: { base_caption: request.prompt, char_captions: [] },
      use_coords: false,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: { base_caption: negative, char_captions: [] },
    };
  }
  return { action: "generate", input: request.prompt, model, parameters };
}

function parseGenerateResponse(payload: unknown): { data: Buffer; seed?: number } {
  if (typeof payload !== "object" || payload === null) {
    throw new NovelAiImageError("NovelAI image generation returned a non-object payload");
  }
  const images = (payload as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length === 0 || typeof images[0] !== "object" || images[0] === null) {
    throw new NovelAiImageError("NovelAI image generation response carries no image entry");
  }
  const image = images[0] as Record<string, unknown>;
  if (typeof image.image !== "string" || image.image.length === 0) {
    throw new NovelAiImageError("NovelAI image generation response is missing base64 image data");
  }
  return {
    data: Buffer.from(image.image, "base64"),
    ...(typeof image.seed === "number" ? { seed: image.seed } : {}),
  };
}

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
    throw new NovelAiImageError(
      `NovelAI ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export const novelAiImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  return {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = resolveModel(request, cfg);
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/ai/generate-image`,
        {
          method: "POST",
          headers: novelAiHeaders(cfg.apiKey),
          body: JSON.stringify(buildBody(request, model)),
          signal: request.signal,
        },
        "image generation",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        if (response.status === 403 || (response.status === 400 && /recaptcha/i.test(excerpt))) {
          throw providerError(
            `NovelAI image generation failed with HTTP ${response.status}: ${excerpt} — ${SUBSCRIPTION_MESSAGE}`,
          );
        }
        throw new NovelAiImageError(
          `NovelAI image generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed = parseGenerateResponse(await response.json());
      const image: ImageGenGeneratedImage = {
        data: parsed.data,
        mimeType: sniffImageMime(parsed.data) ?? "image/png",
      };
      return { images: [image], ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}) };
    },

    async listModels(): Promise<ImageGenModelInfo[]> {
      return Object.entries(NOVELAI_MODEL_DEFAULTS).map(([id, defaults]) => ({ id, label: defaults.label }));
    },

    async listSamplers(): Promise<ImageGenSamplerInfo[]> {
      return STATIC_SAMPLERS.map((sampler) => ({ ...sampler }));
    },

    async listSchedulers(): Promise<ImageGenSchedulerInfo[]> {
      return STATIC_SCHEDULERS.map((scheduler) => ({ ...scheduler }));
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/user/subscription`, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          signal,
        });
        if (response.status === 200) return { ok: true, detail: "credentials accepted" };
        const excerpt = await readProviderErrorBody(response);
        if (response.status === 401) {
          return {
            ok: false,
            detail: `401${excerpt ? `: ${excerpt}` : ""} — credentials rejected`,
            status: 401,
          };
        }
        return { ok: false, detail: `HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`, status: response.status };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release.
    },
  };
};

registerImageGenBackend(IMAGE_GEN_BACKENDS.NovelAi, novelAiImageFactory);
