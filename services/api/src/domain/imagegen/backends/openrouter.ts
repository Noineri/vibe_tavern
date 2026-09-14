/**
 * @module imagegen/backends/openrouter
 *
 * OpenRouter image-generation adapter (IMAGE_GENERATION_PLAN IG-5) — the
 * chat-completions transport arm. OpenRouter image generation is NOT an
 * /v1/images/generations API: it rides POST {endpoint}/chat/completions with
 * `modalities: ["image","text"]`, and images come back as base64 data URLs
 * in `choices[0].message.images[]` (`image_url.url`, PNG). Server-side byte
 * download happens INSIDE the adapter through the injected fetch seam (the
 * cloud-URL-expiry rule: adapters never hand remote URLs upward).
 *
 * Doc gate (IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH, OpenRouter card,
 * doc-verified 2026-09-07 — the ONLY source for every wire field below):
 * - transport: `POST /api/v1/chat/completions` with
 *   `modalities: ["image","text"]` (text+image models) or `["image"]`
 *   (image-only); this adapter sends the generic text+image form;
 * - image config: `image_config.aspect_ratio` with the documented
 *   ratio→pixel grid (six ratios carry a grid; 3:2/4:3/4:5/5:4 exist
 *   upstream but document no grid, so they are not offered — no invented
 *   values). `image_config.image_size` (`1K` default) is Gemini-model-only
 *   and is NOT sent — the documented default applies;
 * - response: `choices[0].message.images[].image_url.url` data URLs;
 * - model discovery: `GET /api/v1/models?output_modalities=image`.
 *
 * House deltas from the STT/TTS adapters (per the IG-4 contract):
 * - NO timeout constants anywhere (owner's hardcoded-parameters ban) — the
 *   AbortSignal seam forwards the caller's signal, nothing wraps it;
 * - the transport is the config-injected `fetch` (tier T1 seam), not a
 *   global — one seam for the completions POST, the model list, AND the
 *   image byte download (Bun's fetch resolves `data:` URLs natively, so a
 *   data URL and a remote URL take the same download path).
 *
 * Capability-gated request fields (negative prompt, steps, cfg, sampler,
 * seed, clip skip) are silently ignored — the OpenRouter card documents no
 * surface for them and the UI never offers them
 * (IMAGE_GEN_BACKEND_CAPABILITIES.openrouter).
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
import {
  buildHeaders,
  normalizeOpenAiCompatibleBaseUrl,
} from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

/** HTTP / transport failure of a generation or model-list request. */
export class OpenRouterImageGenError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, aborts that
   *  are not the caller's own signal). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "OpenRouterImageGenError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint / API key / model). */
export class OpenRouterImageGenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterImageGenConfigError";
  }
}

/** A requested size that is not on the documented OpenRouter grid — the
 *  fail-closed mapping error (the adapter never guesses a ratio). */
export class OpenRouterImageGenSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterImageGenSizeError";
  }
}

// ─── Documented size grid (card: image_config.aspect_ratio) ─────────────────

/** The six ratio→pixel pairs with a DOCUMENTED grid on the OpenRouter card.
 *  Keyed by the "WxH" string the capability grid publishes — the registry's
 *  vendor-set sizes and this table must stay in lockstep (pinned by
 *  imagegen-openrouter.test.ts against IMAGE_GEN_BACKEND_CAPABILITIES). */
export const OPENROUTER_IMAGE_SIZES: ReadonlyMap<string, { ratio: string; width: number; height: number }> = new Map([
  ["1024x1024", { ratio: "1:1", width: 1024, height: 1024 }],
  ["832x1248", { ratio: "2:3", width: 832, height: 1248 }],
  ["864x1184", { ratio: "3:4", width: 864, height: 1184 }],
  ["768x1344", { ratio: "9:16", width: 768, height: 1344 }],
  ["1344x768", { ratio: "16:9", width: 1344, height: 768 }],
  ["1536x672", { ratio: "21:9", width: 1536, height: 672 }],
]);

/** Map a complete W×H onto the documented grid. Throws
 *  {@link OpenRouterImageGenSizeError} for a size that is not documented —
 *  the adapter never guesses a nearby ratio. */
function mapSizeToRatio(width: number, height: number): { ratio: string; width: number; height: number } {
  const key = `${width}x${height}`;
  const entry = OPENROUTER_IMAGE_SIZES.get(key);
  if (!entry) {
    throw new OpenRouterImageGenSizeError(
      `OpenRouter image generation has no documented aspect ratio for ${key} — ` +
        `documented sizes: ${[...OPENROUTER_IMAGE_SIZES.keys()].join(", ")}`,
    );
  }
  return entry;
}

// ─── Data-URL / download helpers ─────────────────────────────────────────────

/** Documented data-URL prefix: "data:<image mime>;base64," (the card's
 *  `image_url.url` shape — PNG). */
const DATA_IMAGE_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/i;
const HTTP_URL_PATTERN = /^https?:\/\//i;

/** Extract the MIME type from a documented data-URL prefix, or null when
 *  the URL is not a data URL. */
function dataUrlMimeType(url: string): string | null {
  const match = DATA_IMAGE_URL_PATTERN.exec(url);
  return match ? match[1].toLowerCase() : null;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface OpenRouterImageGenConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): OpenRouterImageGenConfig {
  const endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  if (!endpoint) {
    throw new OpenRouterImageGenConfigError(
      "OpenRouter image-gen config error: `endpoint` is required",
    );
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new OpenRouterImageGenConfigError(
      "OpenRouter image-gen config error: `apiKey` is required (the OpenRouter card has no keyless surface)",
    );
  }
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, fetch: config.fetch ?? fetch };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Await a fetch call through the injected seam. Transport-level failures
 *  wrap into the adapter's typed error — EXCEPT the caller's own abort,
 *  which is rethrown untouched so cancellation stays distinguishable from
 *  a transport failure (the abort contract of the ai-assistant abort fix). */
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
    throw new OpenRouterImageGenError(
      `OpenRouter image-gen ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Pull `choices[0].message.images[].image_url.url` — the documented image
 *  container. Fail closed with a typed error when the container is absent,
 *  malformed, or empty. */
function extractImageUrls(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) {
    throw new OpenRouterImageGenError("OpenRouter image-gen response is missing a JSON body");
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OpenRouterImageGenError("OpenRouter image-gen response has no choices");
  }
  const choice = choices[0] as Record<string, unknown> | null;
  if (typeof choice !== "object" || choice === null) {
    throw new OpenRouterImageGenError("OpenRouter image-gen response has a malformed choice");
  }
  const message = choice.message;
  if (typeof message !== "object" || message === null) {
    throw new OpenRouterImageGenError("OpenRouter image-gen response has no message");
  }
  const images = (message as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new OpenRouterImageGenError("OpenRouter image-gen response carried no images");
  }
  const urls: string[] = [];
  for (const entry of images) {
    if (typeof entry !== "object" || entry === null) {
      throw new OpenRouterImageGenError("OpenRouter image-gen response has a malformed images[] entry");
    }
    const imageUrl = (entry as Record<string, unknown>).image_url;
    if (typeof imageUrl !== "object" || imageUrl === null) {
      throw new OpenRouterImageGenError("OpenRouter image-gen response has an images[] entry without image_url");
    }
    const url = (imageUrl as Record<string, unknown>).url;
    if (typeof url !== "string" || url.length === 0) {
      throw new OpenRouterImageGenError("OpenRouter image-gen response has an image_url without a url string");
    }
    urls.push(url);
  }
  return urls;
}

/** Parse the OpenAI-compatible models catalog — the same two shapes and the
 *  same aggregator enrichment the STT/TTS openai-compat adapters parse
 *  (`{data:[…]}"` / `{models:[…]}`, OpenRouter-style `pricing` zero = free
 *  tier); forked from stt/backends/openai-stt.ts. */
function parseModelInfos(parsed: unknown): ImageGenModelInfo[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (data === null) return [];
  const out: ImageGenModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const info: ImageGenModelInfo = {
      id,
      label: typeof item.name === "string" && item.name.length > 0 ? item.name : id,
    };
    if (typeof item.description === "string" && item.description.length > 0) {
      info.description = item.description;
    }
    const pricing = item.pricing;
    if (typeof pricing === "object" && pricing !== null) {
      const p = pricing as Record<string, unknown>;
      const toNumber = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string" && v.trim() !== "") {
          const value = Number(v);
          return Number.isFinite(value) ? value : null;
        }
        return null;
      };
      const prompt = toNumber(p.prompt);
      const completion = toNumber(p.completion);
      if (prompt !== null && completion !== null) info.isFree = prompt === 0 && completion === 0;
    }
    out.push(info);
  }
  return out;
}

function countModelInfos(parsed: unknown): number {
  return parseModelInfos(parsed).length;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const openRouterImageGenFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model;
      if (!model) {
        throw new OpenRouterImageGenConfigError(
          "OpenRouter image-gen config error: `model` is required (no documented vendor default for the image transport)",
        );
      }

      // The documented image config: aspect_ratio only when the caller set a
      // COMPLETE W×H that maps onto the grid; otherwise the field is omitted
      // and the vendor default applies (no invented defaults). Partial
      // W×H (one of the two set) cannot map and is treated as unset.
      let imageConfig: { aspect_ratio: string } | undefined;
      let gridSize: { ratio: string; width: number; height: number } | undefined;
      if (request.width !== undefined && request.height !== undefined) {
        gridSize = mapSizeToRatio(request.width, request.height);
        imageConfig = { aspect_ratio: gridSize.ratio };
      }

      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/chat/completions`,
        {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify({
            model,
            modalities: ["image", "text"],
            messages: [{ role: "user", content: request.prompt }],
            ...(imageConfig !== undefined ? { image_config: imageConfig } : {}),
          }),
          signal: request.signal,
        },
        "generation",
      );

      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new OpenRouterImageGenError(
          `OpenRouter image-gen generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const urls = extractImageUrls(payload);

      const images: ImageGenGeneratedImage[] = [];
      for (const url of urls) {
        const isDataUrl = url.startsWith("data:");
        if (isDataUrl && dataUrlMimeType(url) === null) {
          throw new OpenRouterImageGenError(
            "OpenRouter image-gen returned a malformed data URL (expected 'data:<image mime>;base64,…')",
          );
        }
        if (!isDataUrl && !HTTP_URL_PATTERN.test(url)) {
          throw new OpenRouterImageGenError(
            `OpenRouter image-gen returned an unsupported image URL: ${url.slice(0, 60)}`,
          );
        }
        // Server-side byte download through the seam — Bun's fetch resolves
        // data: URLs natively, so documented data URLs and defensive remote
        // URLs take the same path (the cloud-URL-expiry rule).
        const download = await fetchOrWrap(cfg.fetch, url, { method: "GET", signal: request.signal }, "image download");
        if (!download.ok) {
          throw new OpenRouterImageGenError(
            `OpenRouter image-gen image download failed with HTTP ${download.status}`,
            { status: download.status },
          );
        }
        const data = Buffer.from(await download.arrayBuffer());
        // MIME: the data-URL prefix (documented shape) first, then the
        // response header, then the HTTP-standard unknown-type fallback.
        const mimeType = dataUrlMimeType(url) ?? download.headers.get("content-type") ?? "application/octet-stream";
        images.push({ data, mimeType });
      }

      const result: ImageGenGenerateResult = { images };
      if (gridSize !== undefined) {
        // The ratio's documented grid meaning — the size the request implies.
        result.width = gridSize.width;
        result.height = gridSize.height;
      }
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/models?output_modalities=image`,
        {
          method: "GET",
          headers: buildHeaders(cfg.apiKey),
          signal,
        },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new OpenRouterImageGenError(
          `OpenRouter image-gen model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseModelInfos(parsed);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/models?output_modalities=image`, {
          method: "GET",
          headers: buildHeaders(cfg.apiKey),
          signal,
        });
        if (!response.ok) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        const parsed: unknown = await response.json().catch(() => null);
        return { ok: true, detail: `${countModelInfos(parsed)} image models` };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release.
    },
  };

  return backend;
};

// Module-scope registration (protocol-registry pattern, the STT/TTS twins):
// importing this module makes the 'openrouter' image-gen slug creatable via
// the image-gen registry. The route layer (IG-8) imports this module for the
// side effect, exactly like stt-adapter.ts imports the STT backends.
registerImageGenBackend(IMAGE_GEN_BACKENDS.OpenRouter, openRouterImageGenFactory);
