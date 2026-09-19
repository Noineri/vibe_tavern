/**
 * @module imagegen/backends/ideogram
 *
 * Ideogram image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-4
 * unit 3) — the typography-first native vendor. Multipart bodies with the
 * `Api-Key` header (NOT Bearer), synchronous generation, and an
 * **EPHEMERAL signed `url`** in the response — downloaded server-side
 * per the cloud-URL-expiry rule.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Ideogram",
 * doc-verified 2026-09-07; re-verified live 2026-09-18 against
 * developer.ideogram.ai — llms.txt index, generate-v4/generate-v3 pages,
 * and the official OpenAPI 3.1 spec):
 * - `POST https://api.ideogram.ai/v1/ideogram-v4/generate` — body
 *   `{text_prompt | json_prompt, resolution, rendering_speed,
 *   enable_copyright_detection}` (OpenAPI-pinned field set: NO seed, NO
 *   negative on v4). `text_prompt` auto-enables magic-prompt;
 *   `rendering_speed=FLASH` returns 400 (coming soon).
 * - `POST https://api.ideogram.ai/v1/ideogram-v3/generate` — the full
 *   classic surface: `prompt` (required), `negative_prompt`, `seed`
 *   0–2147483647, `resolution` (69-value WxH enum), `aspect_ratio` (15
 *   values, x-notation), `rendering_speed` {FLASH|TURBO|DEFAULT|QUALITY},
 *   `magic_prompt` {AUTO|ON|OFF}, `style_type`, `style_preset`,
 *   `style_codes`, `color_palette`, `custom_model_uri`, reference-image
 *   uploads. VT wires prompt/negative_prompt/seed/resolution only —
 *   aspect_ratio is superseded by the precise resolution grid (sending
 *   both is ambiguous), the style/rendering/magic knobs have no VT seam.
 * - **Named decision (per-model divergence, the stability cfg_scale
 *   precedent): negative_prompt and seed ride ONLY v3 — v4's documented
 *   request schema has neither. The capability row keeps them (v3's real
 *   surface); the v4 wire drops them silently, test-pinned.**
 * - Resolution mapping: WxH → the NEAREST documented grid entry
 *   (exact first, else minimal |log(w/gw)| + |log(h/gh)| distance,
 *   deterministic — documented enum values only). v3 grid = 69 entries
 *   (512x1536…1536x640), v4 grid = 38 entries (2048x2048… 2K-class).
 *   The v4 grid was MISSING from the .md render (the page's `resolution`
 *   enum rendered empty) — pinned from the OpenAPI spec instead
 *   (drift-noted in the card log).
 * - Response: `{created, data: [{prompt, resolution "WxH",
 *   is_image_safe, seed, url}]}` — `url` is a signed ephemeral link
 *   ("available for a limited period") → the adapter downloads it
 *   server-side (no auth header on the signed link) and hands bytes up.
 *   `is_image_safe: false` → empty url → typed error (422 rides the
 *   same surface: "Prompt failed the safety check").
 * - Errors: RFC 7807 problem-details `{type, title, detail, status}`;
 *   live-probed 2026-09-18: `{}` + Api-Key → 400 "'prompt' is a required
 *   property"; no Api-Key → 401 "No authorization token provided";
 *   urlencoded bodies → 415 (the probe therefore sends JSON). 422 =
 *   safety check failure = credentials were accepted.
 * - Model listing: no public catalog endpoint — static {v4, v3}
 *   (the two current generate families; async/transparent/P-Image
 *   variants are the same models in different transports, out of v1).
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

export class IdeogramImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "IdeogramImageError";
    this.status = options?.status;
  }
}

export class IdeogramImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeogramImageConfigError";
  }
}

// ─── Documented surface (card + OpenAPI spec 2026-09-18) ────────────────────

function parseGrid(values: readonly string[]): { width: number; height: number }[] {
  return values.map((value) => {
    const [width, height] = value.split("x").map((part) => Number.parseInt(part, 10));
    return { width, height };
  });
}

/** The v3 resolution enum — 69 documented WxH values (OpenAPI
 *  ResolutionV3). */
export const IDEOGRAM_V3_RESOLUTIONS: readonly string[] = [
  "512x1536", "576x1408", "576x1472", "576x1536", "640x1344", "640x1408", "640x1472",
  "640x1536", "704x1152", "704x1216", "704x1280", "704x1344", "704x1408", "704x1472",
  "736x1312", "768x1088", "768x1216", "768x1280", "768x1344", "800x1280", "832x960",
  "832x1024", "832x1088", "832x1152", "832x1216", "832x1248", "864x1152", "896x960",
  "896x1024", "896x1088", "896x1120", "896x1152", "960x832", "960x896", "960x1024",
  "960x1088", "1024x832", "1024x896", "1024x960", "1024x1024", "1088x768", "1088x832",
  "1088x896", "1088x960", "1120x896", "1152x704", "1152x832", "1152x864", "1152x896",
  "1216x704", "1216x768", "1216x832", "1248x832", "1280x704", "1280x768", "1280x800",
  "1312x736", "1344x640", "1344x704", "1344x768", "1408x576", "1408x640", "1408x704",
  "1472x576", "1472x640", "1472x704", "1536x512", "1536x576", "1536x640",
];

/** The v4 resolution enum — 38 documented WxH values (OpenAPI
 *  ResolutionV4; the .md page rendered this enum EMPTY — spec-pinned). */
export const IDEOGRAM_V4_RESOLUTIONS: readonly string[] = [
  "2048x2048", "1440x2880", "2880x1440", "1664x2496", "2496x1664", "1792x2240",
  "2240x1792", "1440x2560", "2560x1440", "1600x2560", "2560x1600", "1728x2304",
  "2304x1728", "1296x3168", "3168x1296", "1152x2944", "2944x1152", "1248x3328",
  "3328x1248", "1280x3072", "3072x1280", "1184x2816", "2816x1184", "1344x2688",
  "2688x1344", "1408x2560", "2560x1408", "1536x2560", "2560x1536", "1664x2240",
  "2240x1664", "1856x2176", "2176x1856", "1920x2048", "2048x1920", "1984x2016",
  "2016x1984", "2112x1920",
];

/** Map a W×H onto a documented resolution grid: exact match first, else
 *  the entry minimizing |log(w/gw)| + |log(h/gh)| (deterministic,
 *  documented enum values only). Exported as the test seam. */
export function mapIdeogramResolution(
  grid: readonly string[],
  width: number,
  height: number,
): string {
  let best = grid[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const value of grid) {
    const [gw, gh] = value.split("x").map((part) => Number.parseInt(part, 10));
    if (gw === width && gh === height) return value;
    const distance = Math.abs(Math.log(width / gw)) + Math.abs(Math.log(height / gh));
    if (distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}

const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: "v4", label: "Ideogram 4.0 (typography-first)" },
  { id: "v3", label: "Ideogram 3.0 (full classic surface)" },
];

const DEFAULT_MODEL = "v4";

// ─── Config ──────────────────────────────────────────────────────────────────

interface IdeogramImageConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): IdeogramImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: full generate URLs and the /v1 prefix normalize to
  // the bare host (paths below own their /v1 prefix).
  for (const suffix of [
    "/v1/ideogram-v4/generate",
    "/v1/ideogram-v3/generate",
    "/v1/ideogram-v4",
    "/v1/ideogram-v3",
    "/v1",
  ]) {
    if (endpoint.endsWith(suffix)) {
      endpoint = endpoint.slice(0, -suffix.length);
      break;
    }
  }
  if (!endpoint) {
    throw new IdeogramImageConfigError("Ideogram config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new IdeogramImageConfigError(
      "Ideogram config error: `apiKey` is required (the card has no keyless surface)",
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
    throw new IdeogramImageError(
      `Ideogram ${operation} network error: ${
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

interface ParsedIdeogramResult {
  url: string;
  seed?: number;
  width?: number;
  height?: number;
}

function parseGenerateResponse(payload: unknown): ParsedIdeogramResult {
  if (typeof payload !== "object" || payload === null) {
    throw new IdeogramImageError("Ideogram generation: unexpected response shape");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== "object" || data[0] === null) {
    throw new IdeogramImageError("Ideogram generation: response carries no data entries");
  }
  const entry = data[0] as Record<string, unknown>;
  const isSafe = entry.is_image_safe;
  const url = entry.url;
  if (isSafe === false || typeof url !== "string" || url.length === 0) {
    throw new IdeogramImageError(
      "Ideogram generation returned no image URL (failed the safety check — is_image_safe false or empty url)",
    );
  }
  const parsed: ParsedIdeogramResult = { url };
  if (typeof entry.seed === "number") parsed.seed = entry.seed;
  if (typeof entry.resolution === "string") {
    const match = /^(\d+)x(\d+)$/.exec(entry.resolution);
    if (match !== null) {
      parsed.width = Number.parseInt(match[1], 10);
      parsed.height = Number.parseInt(match[2], 10);
    }
  }
  return parsed;
}

// ─── Registration ────────────────────────────────────────────────────────────

registerImageGenBackend(
  IMAGE_GEN_BACKENDS.Ideogram,
  (config: ImageGenAdapterConfig): ImageGenBackend => {
    const parsed = parseConfig(config);

    function ideogramHeaders(): Record<string, string> {
      // The Api-Key header (NOT Bearer) — the card's auth shape. The fetch
      // layer owns the multipart boundary.
      return { "Api-Key": parsed.apiKey };
    }

    function buildForm(request: ImageGenGenerateRequest, model: string): FormData {
      const form = new FormData();
      if (model === "v3") {
        form.set("prompt", request.prompt);
        // v3-only fields (the v4 request schema documents neither).
        if (request.negativePrompt !== undefined && request.negativePrompt !== "") {
          form.set("negative_prompt", request.negativePrompt);
        }
        if (request.seed !== undefined) {
          form.set("seed", String(request.seed));
        }
        if (request.width !== undefined && request.height !== undefined) {
          form.set("resolution", mapIdeogramResolution(IDEOGRAM_V3_RESOLUTIONS, request.width, request.height));
        }
      } else {
        form.set("text_prompt", request.prompt);
        if (request.width !== undefined && request.height !== undefined) {
          form.set("resolution", mapIdeogramResolution(IDEOGRAM_V4_RESOLUTIONS, request.width, request.height));
        }
      }
      // rendering_speed / magic_prompt / style_* / aspect_ratio: no VT seam
      // (aspect_ratio superseded by the resolution grid) — never sent.
      return form;
    }

    return {
      async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
        const model = request.model?.trim() || parsed.model;
        const url =
          model === "v3"
            ? `${parsed.endpoint}/v1/ideogram-v3/generate`
            : `${parsed.endpoint}/v1/ideogram-v4/generate`;
        const response = await fetchOrWrap(
          parsed.fetch,
          url,
          { method: "POST", headers: ideogramHeaders(), body: buildForm(request, model), signal: request.signal },
          "image generation",
        );
        if (!response.ok) {
          const excerpt = await readProviderErrorBody(response);
          throw new IdeogramImageError(
            `Ideogram image generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: response.status },
          );
        }
        const parsedResult = parseGenerateResponse(await response.json());
        // The ephemeral signed URL — download server-side (the cloud-URL
        // expiry rule; the signed link needs no auth header).
        const download = await fetchOrWrap(
          parsed.fetch,
          parsedResult.url,
          { method: "GET", signal: request.signal },
          "image download",
        );
        if (!download.ok) {
          throw new IdeogramImageError(
            `Ideogram image download failed with HTTP ${download.status} (the signed URL may have expired)`,
            { status: download.status },
          );
        }
        const bytes = Buffer.from(await download.arrayBuffer());
        const mimeType =
          sniffImageMime(bytes) ??
          download.headers.get("content-type")?.split(";")[0]?.trim() ??
          "image/png";
        const image: ImageGenGeneratedImage = { data: bytes, mimeType };
        return {
          images: [image],
          seed: parsedResult.seed,
          width: parsedResult.width,
          height: parsedResult.height,
        };
      },

      async listModels(): Promise<ImageGenModelInfo[]> {
        // No public catalog — the two current generate families.
        return STATIC_MODELS.map((model) => ({ ...model }));
      },

      async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
        // invalid-post creds discrimination (live-probed 2026-09-18): an
        // empty JSON body on v3 — 401 "No authorization token provided"
        // = rejected; 400 "'prompt' is a required property" = validation
        // reached = accepted; 422 (safety) = accepted; 5xx = fail.
        try {
          const response = await parsed.fetch(`${parsed.endpoint}/v1/ideogram-v3/generate`, {
            method: "POST",
            headers: { ...ideogramHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({}),
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
