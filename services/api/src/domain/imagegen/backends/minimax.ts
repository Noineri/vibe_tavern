/**
 * @module imagegen/backends/minimax
 *
 * MiniMax image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-2 unit 2)
 * — the `image-01` model through MiniMax's own JSON surface (NOT the
 * OpenAI-images transport: different path, aspect-ratio-first sizing, and
 * the in-band `base_resp` error convention). The TTS twin
 * (`tts/backends/minimax-tts.ts`) is the fork sibling: same host, same
 * Bearer key, same base_resp-inside-HTTP-200 contract.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "MiniMax image-01",
 * doc-verified 2026-09-07 against platform.minimax.io; re-verified unchanged
 * 2026-09-18; response schema re-read in full via a JS-rendered fetch
 * 2026-09-18 + live no-key probe):
 * - `POST https://api.minimax.io/v1/image_generation`, Bearer. CN twin
 *   api.minimax.cn exists (adds image-01-live + aigc_watermark) — NOT
 *   preset; the intl host matches the existing VT minimax TTS profile.
 * - body: `model` (enum `image-01` ONLY on intl — the documented
 *   single-value enum, so it is also the profile's default, the TTS twin's
 *   documented-default precedent), `prompt` (≤1500 chars), sizing by
 *   `aspect_ratio` enum (8 values with a documented pixel map) OR
 *   `width`+`height` [512,2048] divisible by 8 (aspect_ratio wins when both
 *   are present — the pixel-map values ARE aspect-ratio values, so the
 *   adapter always prefers the ratio form and only a user-added IG-20a size
 *   rides as width+height), `response_format` url(default, expires 24 h) |
 *   base64 → VT requests `base64` (bytes inline; the URL form's 24 h
 *   expiry fits the download-always rule but costs a second request),
 *   `seed` int64 (reproducible), `n` 1–9, `prompt_optimizer` (default
 *   false). `n`/`prompt_optimizer` have no VT seam → never sent.
 * - response: HTTP 200 with `{id, data:{image_urls[]|image_base64s[]},
 *   metadata, base_resp}` — **failures ride as base_resp.status_code !== 0
 *   INSIDE HTTP 200** (live-probed: a missing key returns 200 +
 *   status_code 1004 "login fail" — pinned by test). With
 *   response_format=base64 the entries ride `data.image_base64s` (verified
 *   from a real third-party call site reading image_base64s with
 *   image_urls as the fallback field); entries are https URLs (url mode) or
 *   bare base64 strings — https entries download server-side, everything
 *   else decodes in-process and is MIME-sniffed.
 * - model discovery: MiniMax documents an OpenAI-compatible
 *   `GET /v1/models` ("a list of all available models" — the TTS twin's
 *   owner-audit precedent: static catalogs out). The image family is the
 *   `image-*` prefix (the t2i page's own enum names image-01) — a filter
 *   criterion, not a list: new image releases appear without a code
 *   change. A catalog without image entries returns [] (picker degrades to
 *   manual input).
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import type { ImageGenUserSizeEntry } from "@vibe-tavern/domain";

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
  normalizeOpenAiCompatibleBaseUrl,
  buildHeaders,
} from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class MinimaxImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for base_resp-level failures inside HTTP 200). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "MinimaxImageError";
    this.status = options?.status;
  }
}

export class MinimaxImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinimaxImageConfigError";
  }
}

/** A requested size that maps to no documented ratio and no user entry —
 *  the fail-closed mapping error (the adapter never sends a guessed size). */
export class MinimaxImageSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinimaxImageSizeError";
  }
}

// ─── Documented surface (card) ───────────────────────────────────────────────

/** The documented aspect-ratio pixel map — keyed by the "WxH" the capability
 *  grid publishes, value the ratio string that rides the wire. The
 *  registry's vendor-set sizes and this table must stay in lockstep (pinned
 *  by imagegen-pe2-providers.test.ts against IMAGE_GEN_BACKEND_CAPABILITIES). */
export const MINIMAX_ASPECT_RATIOS: ReadonlyMap<string, string> = new Map([
  ["1024x1024", "1:1"],
  ["1280x720", "16:9"],
  ["1152x864", "4:3"],
  ["1248x832", "3:2"],
  ["832x1248", "2:3"],
  ["864x1152", "3:4"],
  ["720x1280", "9:16"],
  ["1344x576", "21:9"],
]);

/** The intl page's model enum — a single documented value (also the
 *  profile default, the minimax-tts documented-default precedent). */
const DEFAULT_MODEL = "image-01";

// ─── MIME sniffing (the shared family helper's logic, local twin) ───────────

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

// ─── Config ──────────────────────────────────────────────────────────────────

interface MinimaxImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  userSizes: readonly ImageGenUserSizeEntry[];
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): MinimaxImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a full generation URL keeps working, and a baseUrl
  // carrying the /v1 suffix normalizes to the bare host (paths below
  // always include their own /v1 prefix).
  if (endpoint.endsWith("/v1/image_generation")) {
    endpoint = endpoint.slice(0, -"/v1/image_generation".length);
  } else if (endpoint.endsWith("/image_generation")) {
    endpoint = endpoint.slice(0, -"/image_generation".length);
  } else if (endpoint.endsWith("/v1")) {
    endpoint = endpoint.slice(0, -"/v1".length);
  }
  if (!endpoint) {
    throw new MinimaxImageConfigError("MiniMax config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new MinimaxImageConfigError(
      "MiniMax config error: `apiKey` is required (the card has no keyless surface)",
    );
  }
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, userSizes: config.userSizes ?? [], fetch: config.fetch ?? fetch };
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
    throw new MinimaxImageError(
      `MiniMax ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Parse a JSON body and enforce MiniMax's in-band status: failures ride as
 *  base_resp.status_code !== 0 INSIDE HTTP 200 (the TTS twin's
 *  parseJsonWithBaseResp contract — live-probed on this endpoint too:
 *  a missing key returns 200 + status_code 1004 "login fail"). */
function parseJsonWithBaseResp(payload: unknown, operation: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw new MinimaxImageError(`MiniMax ${operation} returned a non-object payload`);
  }
  const root = payload as Record<string, unknown>;
  const baseResp = root.base_resp;
  if (typeof baseResp === "object" && baseResp !== null) {
    const statusCode = (baseResp as Record<string, unknown>).status_code;
    const statusMsg = (baseResp as Record<string, unknown>).status_msg;
    if (typeof statusCode === "number" && statusCode !== 0) {
      throw new MinimaxImageError(
        `MiniMax ${operation} failed with status ${statusCode}: ${
          typeof statusMsg === "string" ? statusMsg : "(no message)"
        }`,
      );
    }
  }
  return root;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const minimaxImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || DEFAULT_MODEL;

      // Size: the documented ratio pixel map first (the ratio form always
      // wins upstream), then the profile's IG-20a user entries (width+height
      // [512,2048] div 8 — the entry IS the vendor claim, rides verbatim),
      // everything else fails closed.
      let ratio: string | undefined;
      let pixelSize: { width: number; height: number } | undefined;
      if (request.width !== undefined && request.height !== undefined) {
        const key = `${request.width}x${request.height}`;
        const hit = MINIMAX_ASPECT_RATIOS.get(key);
        if (hit !== undefined) {
          ratio = hit;
        } else {
          const user = cfg.userSizes.find(
            (u) => u.width === request.width && u.height === request.height,
          );
          if (user) {
            pixelSize = { width: user.width, height: user.height };
          } else {
            throw new MinimaxImageSizeError(
              `MiniMax has no documented size for ${key} — documented sizes: ${[
                ...MINIMAX_ASPECT_RATIOS.keys(),
              ].join(", ")}`,
            );
          }
        }
      }

      const body: Record<string, unknown> = {
        model,
        prompt: request.prompt,
        response_format: "base64",
      };
      if (ratio !== undefined) body.aspect_ratio = ratio;
      if (pixelSize !== undefined) {
        body.width = pixelSize.width;
        body.height = pixelSize.height;
      }
      if (request.seed !== undefined) body.seed = request.seed;

      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/v1/image_generation`,
        {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: request.signal,
        },
        "generation",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new MinimaxImageError(
          `MiniMax generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const root = parseJsonWithBaseResp(payload, "generation");

      const data = root.data;
      const entries =
        typeof data === "object" && data !== null
          ? ((data as Record<string, unknown>).image_base64s ??
            (data as Record<string, unknown>).image_urls)
          : undefined;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new MinimaxImageError("MiniMax response carried no images");
      }

      const images: ImageGenGeneratedImage[] = [];
      for (const entry of entries) {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new MinimaxImageError("MiniMax response has a non-string image entry");
        }
        if (/^https?:\/\//i.test(entry)) {
          // A hosted URL (url-mode delivery or a base64-mode server deciding
          // otherwise) — downloaded server-side, the cloud-URL-expiry rule.
          const download = await fetchOrWrap(
            cfg.fetch,
            entry,
            { method: "GET", signal: request.signal },
            "image download",
          );
          if (!download.ok) {
            throw new MinimaxImageError(
              `MiniMax image download failed with HTTP ${download.status}`,
              { status: download.status },
            );
          }
          const bytes = Buffer.from(await download.arrayBuffer());
          images.push({
            data: bytes,
            mimeType: sniffImageMime(bytes) ?? download.headers.get("content-type") ?? "application/octet-stream",
          });
          continue;
        }
        // Bare base64 string (the documented base64-mode delivery).
        const bytes = Buffer.from(entry, "base64");
        if (bytes.length === 0) {
          throw new MinimaxImageError("MiniMax response has a base64 entry that decodes to zero bytes");
        }
        images.push({ data: bytes, mimeType: sniffImageMime(bytes) ?? "application/octet-stream" });
      }

      const result: ImageGenGenerateResult = { images };
      if (ratio !== undefined && request.width !== undefined && request.height !== undefined) {
        result.width = request.width;
        result.height = request.height;
      }
      if (pixelSize !== undefined) {
        result.width = pixelSize.width;
        result.height = pixelSize.height;
      }
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/v1/models`,
        { method: "GET", headers: buildHeaders(cfg.apiKey), signal },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new MinimaxImageError(
          `MiniMax model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const root = parseJsonWithBaseResp(payload, "model list");
      const data = root.data;
      if (!Array.isArray(data)) return [];
      const out: ImageGenModelInfo[] = [];
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) continue;
        const id = (entry as Record<string, unknown>).id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (!id.startsWith("image-")) continue;
        out.push({ id, label: id });
      }
      return out;
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/v1/models`, {
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
        const payload: unknown = await response.json().catch(() => null);
        // base_resp-level failures ride inside HTTP 200 — honored here too
        // (a wrong key answers 200 + status_code 1004, live-probed).
        const root = parseJsonWithBaseResp(payload, "probe");
        const data = root.data;
        const count = Array.isArray(data)
          ? data.filter(
              (e) =>
                typeof e === "object" &&
                e !== null &&
                typeof (e as Record<string, unknown>).id === "string" &&
                ((e as Record<string, unknown>).id as string).startsWith("image-"),
            ).length
          : 0;
        return { ok: true, detail: `${count} image models` };
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

// Module-scope registration (protocol-registry pattern, the STT/TTS twins):
// importing this module makes the 'minimax' image-gen slug creatable via
// the image-gen registry. The route layer imports this module for the side
// effect, exactly like the openai-images family module.
registerImageGenBackend(IMAGE_GEN_BACKENDS.MiniMax, minimaxImageFactory);
