/**
 * @module imagegen/backends/openai-images
 *
 * OpenAI Images backend adapter (IMAGE_GENERATION_PLAN IG-6) — the
 * `/v1/images/generations` arm. Serves the OpenAI protocol proper (the VT
 * `openai` preset baseUrl matches directly) and Custom cloud endpoints that
 * implement the OpenAI-images shape.
 *
 * Doc gate (IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH, OpenAI card, doc-verified
 * 2026-09-07 — the ONLY source for every wire field below):
 * - transport: `POST /v1/images/generations` (edits/variations out of v1
 *   scope — capability flags, not implemented);
 * - request: `prompt`, `model` (required — the card documents no default),
 *   `size` — GPT Image grid `1024x1024` / `1536x1024` / `1024x1536` (plus
 *   vendor `auto`; a request without a complete W×H omits the field and the
 *   vendor default applies — no invented defaults). `response_format:
 *   "b64_json"` is DALL-E-ONLY (the card: GPT Image models ALWAYS return
 *   `data[].b64_json` regardless), so the adapter sends it only for
 *   `dall-e*` models and never for `gpt-image*`;
 * - response: `{created, data[]}` where each entry carries `b64_json`
 *   (GPT Image always; DALL-E when asked for it) or `url` (DALL-E-only
 *   surface, URLs valid 60 min). Bytes from `b64_json` decode in-process —
 *   NO second HTTP request; a `url` entry (defensive: only reachable when
 *   a DALL-E server ignores the requested format) downloads server-side
 *   through the injected fetch seam — the cloud-URL-expiry rule: adapters
 *   never hand remote URLs upward;
 * - no negative prompt, no steps/seed/sampler — per the card, silently
 *   ignored (capability flags off in the registry);
 * - model discovery: image models are enumerable via `GET /v1/models`
 *   filtering — the image families on the card are `gpt-image*` and
 *   `dall-e*`.
 *
 * House deltas from the STT/TTS adapters (per the IG-4 contract):
 * - NO timeout constants anywhere (owner's hardcoded-parameters ban) — the
 *   AbortSignal seam forwards the caller's signal, nothing wraps it;
 * - the transport is the config-injected `fetch` (tier T1 seam), not a
 *   global.
 *
 * MIME: `b64_json` entries carry no content type — the bytes are sniffed by
 * format signature (the card's `output_format` surface is png|jpeg|webp);
 * `url` entries fall back to the download response's content-type, then
 * `application/octet-stream`.
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
export class OpenAiImagesError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, aborts that
   *  are not the caller's own signal). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "OpenAiImagesError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint / API key / model). */
export class OpenAiImagesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiImagesConfigError";
  }
}

/** A requested size that is not on the documented GPT Image grid — the
 *  fail-closed mapping error (the adapter never sends a guessed size). */
export class OpenAiImagesSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiImagesSizeError";
  }
}

// ─── Documented size grid (card: `size` on GPT Image) ───────────────────────

/** The three size strings with a DOCUMENTED grid on the OpenAI card (GPT
 *  Image models; DALL-E-only sizes are not enumerated by the card and are
 *  therefore not offered — no invented values). Keyed by the "WxH" string
 *  the capability grid publishes — the registry's vendor-set sizes and this
 *  table must stay in lockstep (pinned by imagegen-openai-images.test.ts
 *  against IMAGE_GEN_BACKEND_CAPABILITIES). */
export const OPENAI_IMAGES_SIZES: ReadonlyMap<string, { width: number; height: number }> = new Map([
  ["1024x1024", { width: 1024, height: 1024 }],
  ["1536x1024", { width: 1536, height: 1024 }],
  ["1024x1536", { width: 1024, height: 1536 }],
]);

/** Map a complete W×H onto the documented grid. Throws
 *  {@link OpenAiImagesSizeError} for a size that is not documented — the
 *  adapter never sends a near-miss size. */
function mapSizeToString(width: number, height: number): { size: string; width: number; height: number } {
  const key = `${width}x${height}`;
  const entry = OPENAI_IMAGES_SIZES.get(key);
  if (!entry) {
    throw new OpenAiImagesSizeError(
      `OpenAI Images has no documented size for ${key} — ` +
        `documented sizes: ${[...OPENAI_IMAGES_SIZES.keys()].join(", ")}`,
    );
  }
  return { size: key, ...entry };
}

// ─── MIME sniffing ───────────────────────────────────────────────────────────

/** Sniff the MIME type from image bytes by format signature. The card's
 *  `output_format` surface is png|jpeg|webp and `b64_json` entries carry no
 *  content type — the bytes themselves are the only source. Returns null
 *  when no signature matches (caller falls back to content-type /
 *  octet-stream). These are format parsers, not tunable parameters. */
function sniffImageMime(bytes: Buffer): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // WebP: "RIFF" <4-byte size> "WEBP"
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** The card's DALL-E model family prefix — `response_format` is
 *  DALL-E-only on the card, so this prefix is what gates sending it. */
const DALL_E_MODEL_PREFIX = "dall-e";

/** Model-family prefixes of the image catalog per the card (gpt-image-2,
 *  gpt-image-1.5, gpt-image-1, gpt-image-1-mini, dall-e-3, dall-e-2) —
 *  `GET /v1/models` filtering starts from these families. */
const IMAGE_MODEL_PREFIXES = ["gpt-image", "dall-e"] as const;

// ─── Config ──────────────────────────────────────────────────────────────────

interface OpenAiImagesConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): OpenAiImagesConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // A pasted full generation URL (`…/v1/images/generations`) keeps working —
  // the same paste-tolerance the OpenRouter twin applies to
  // `/chat/completions` via the shared normalizer.
  if (endpoint.endsWith("/images/generations")) {
    endpoint = endpoint.slice(0, -"/images/generations".length);
  }
  if (!endpoint) {
    throw new OpenAiImagesConfigError(
      "OpenAI Images config error: `endpoint` is required",
    );
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new OpenAiImagesConfigError(
      "OpenAI Images config error: `apiKey` is required (the card has no keyless surface)",
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
    throw new OpenAiImagesError(
      `OpenAI Images ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

// ─── Response parsing ────────────────────────────────────────────────────────

/** One `data[]` entry after shape validation: decoded base64 bytes, or a
 *  URL to download server-side. */
interface ParsedImageEntry {
  readonly data?: Buffer;
  readonly url?: string;
}

/** Pull `data[]` out of the documented `{created, data[]}` envelope, then
 *  validate each entry: a `b64_json` string (the GPT Image shape — always
 *  present per the card) or a `url` string (the DALL-E surface). Fails
 *  closed with a typed error on absent/malformed containers. */
function extractImageData(payload: unknown): ParsedImageEntry[] {
  if (typeof payload !== "object" || payload === null) {
    throw new OpenAiImagesError("OpenAI Images response is missing a JSON body");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new OpenAiImagesError("OpenAI Images response carried no images");
  }
  const entries: ParsedImageEntry[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) {
      throw new OpenAiImagesError("OpenAI Images response has a malformed data[] entry");
    }
    const item = entry as Record<string, unknown>;
    if (item.b64_json !== undefined) {
      if (typeof item.b64_json !== "string" || item.b64_json.length === 0) {
        throw new OpenAiImagesError("OpenAI Images response has a non-string b64_json entry");
      }
      const decoded = Buffer.from(item.b64_json, "base64");
      if (decoded.length === 0) {
        throw new OpenAiImagesError("OpenAI Images response has a b64_json entry that decodes to zero bytes");
      }
      entries.push({ data: decoded });
      continue;
    }
    if (item.url !== undefined) {
      if (typeof item.url !== "string" || item.url.length === 0) {
        throw new OpenAiImagesError("OpenAI Images response has a non-string url entry");
      }
      if (!/^https?:\/\//i.test(item.url) && !item.url.startsWith("data:")) {
        throw new OpenAiImagesError(
          `OpenAI Images response has an unsupported image URL: ${item.url.slice(0, 60)}`,
        );
      }
      entries.push({ url: item.url });
      continue;
    }
    throw new OpenAiImagesError(
      "OpenAI Images response has a data[] entry with neither b64_json nor url",
    );
  }
  return entries;
}

/** Filter the OpenAI-compatible `/models` catalog down to the image
 *  families documented on the card (`gpt-image*`, `dall-e*`). The plain
 *  OpenAI listing carries no display names or pricing — id doubles as
 *  label (OpenAI-images servers may add extras; anything absent stays
 *  absent, nothing is invented). */
function parseImageModelInfos(parsed: unknown): ImageGenModelInfo[] {
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
    if (!IMAGE_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix))) continue;
    const info: ImageGenModelInfo = {
      id,
      label: typeof item.name === "string" && item.name.length > 0 ? item.name : id,
    };
    if (typeof item.description === "string" && item.description.length > 0) {
      info.description = item.description;
    }
    out.push(info);
  }
  return out;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const openAiImagesFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model;
      if (!model) {
        throw new OpenAiImagesConfigError(
          "OpenAI Images config error: `model` is required (the card documents no default model)",
        );
      }

      // The documented size field: sent only when the caller set a COMPLETE
      // W×H that maps onto the grid; otherwise the field is omitted and the
      // vendor default applies (no invented defaults). Partial W×H (one of
      // the two set) cannot map and is treated as unset.
      let gridSize: { size: string; width: number; height: number } | undefined;
      if (request.width !== undefined && request.height !== undefined) {
        gridSize = mapSizeToString(request.width, request.height);
      }

      // `response_format` is DALL-E-only on the card — GPT Image models
      // always return b64_json without it, so it is never sent for them.
      const isDallE = model.startsWith(DALL_E_MODEL_PREFIX);

      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/images/generations`,
        {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify({
            model,
            prompt: request.prompt,
            ...(gridSize !== undefined ? { size: gridSize.size } : {}),
            ...(isDallE ? { response_format: "b64_json" } : {}),
          }),
          signal: request.signal,
        },
        "generation",
      );

      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new OpenAiImagesError(
          `OpenAI Images generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const entries = extractImageData(payload);

      const images: ImageGenGeneratedImage[] = [];
      for (const entry of entries) {
        if (entry.data !== undefined) {
          // b64_json decodes in-process — no second HTTP request (the card:
          // GPT Image always delivers bytes inline).
          images.push({
            data: entry.data,
            mimeType: sniffImageMime(entry.data) ?? "application/octet-stream",
          });
          continue;
        }
        // A url entry (DALL-E surface — defensive: reachable when a server
        // ignores the requested b64_json) downloads server-side through the
        // seam. Bun's fetch resolves data: URLs natively, same path.
        const download = await fetchOrWrap(
          cfg.fetch,
          entry.url ?? "",
          { method: "GET", signal: request.signal },
          "image download",
        );
        if (!download.ok) {
          throw new OpenAiImagesError(
            `OpenAI Images image download failed with HTTP ${download.status}`,
            { status: download.status },
          );
        }
        const data = Buffer.from(await download.arrayBuffer());
        images.push({
          data,
          mimeType: sniffImageMime(data) ?? download.headers.get("content-type") ?? "application/octet-stream",
        });
      }

      const result: ImageGenGenerateResult = { images };
      if (gridSize !== undefined) {
        // The grid meaning of the requested size — what was sent on the wire.
        result.width = gridSize.width;
        result.height = gridSize.height;
      }
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/models`,
        {
          method: "GET",
          headers: buildHeaders(cfg.apiKey),
          signal,
        },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new OpenAiImagesError(
          `OpenAI Images model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseImageModelInfos(parsed);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/models`, {
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
        return { ok: true, detail: `${parseImageModelInfos(parsed).length} image models` };
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
// importing this module makes the 'openai-images' image-gen slug creatable
// via the image-gen registry. The route layer (IG-8) imports this module for
// the side effect, exactly like stt-adapter.ts imports the STT backends.
registerImageGenBackend(IMAGE_GEN_BACKENDS.OpenAiImages, openAiImagesFactory);
