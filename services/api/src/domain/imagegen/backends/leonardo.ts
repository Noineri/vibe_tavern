/**
 * @module imagegen/backends/leonardo
 *
 * Leonardo.Ai image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-5
 * unit 4) — the v2 SYNC surface: `POST /v2/generationssync` returns the
 * finished result in the same response (sync-capable models only, ~27 s
 * vendor service timeout — the cloud timeout still wraps the call).
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Leonardo.Ai",
 * doc-verified 2026-09-07; re-verified live 2026-09-18: llms.txt index +
 * flux-schnell guide + the v2 reference pages re-scraped through the JS
 * wall (firecrawl, the card's own prescribed method) + no-key probes):
 *
 * - Transport: `Authorization: Bearer` on
 *   `https://cloud.leonardo.ai/api/rest/v2/generationssync`; body
 *   `{model, public, parameters{…}, ephemeral, base64}`. The v2 reference
 *   exposes exactly three endpoints (async create / sync create / get
 *   models). **The card's UNVERIFIED item closed by probe**: the v2
 *   polling GET `/v2/generations/{id}` EXISTS at the gateway (401 auth
 *   wall — routing precedes auth) but its response schema is STILL
 *   undocumented → the async+poll path is NOT wired in v1 (never guess a
 *   wire shape); the documented SYNC response is the arm. A non-sync
 *   model surfaces the vendor's own error (typed passthrough).
 * - Request flags (documented on the sync endpoint): `base64: true` →
 *   results[].dataB64 inline instead of results[].url (no URL lifetime
 *   concern at all); `ephemeral: true` → the result is NOT persisted to
 *   the user's Leonardo library (the privacy posture — the google
 *   `store:false` precedent) and makes `public` moot ("ignored when
 *   ephemeral is true"). Both are ALWAYS sent as true — named
 *   decisions, not user settings.
 * - `quantity` 1–8 with vendor default **4** — VT sends `1` ALWAYS (one
 *   image per VT generation; the 4x default would burn API credits —
 *   the constant-param class, the volcengine watermark precedent).
 * - Parameters (flux-schnell guide table, live-re-read): `prompt`
 *   required 1–2000 chars; `width`/`height` 32–2048 in **multiples of
 *   8** (VT snaps — the aihorde 64-snap precedent), default 1024;
 *   `seed` 0–2147483637; `prompt_enhance` AUTO|ON|OFF (unsent — vendor
 *   default); `style_ids` (unsent — a UUID preset surface with no VT
 *   seam); `guidances` (edit-family, out of scope). NO negative/steps/
 *   sampler anywhere in v2 (per-card) — capability off.
 * - Response (card-pinned from the full OpenAPI read): `{id, cost,
 *   results[{contentType, url, dataB64, width, height}], blockedCount}`.
 *   **blockedCount surfaced** (the plan row's demand): non-zero → typed
 *   error, never silently missing images. dataB64 preferred (we asked
 *   for it); a url result is a 30-minute ephemeral presigned GET —
 *   downloaded server-side keyless if it appears anyway.
 * - Model roster: the v2 reference's live model enum (scraped
 *   2026-09-18) — a STATIC image-only catalog (the enum IS the catalog,
 *   the BFL-paths precedent; GET /v2/models is authed and its response
 *   shape is JS-collapsed in the reference — not guessed). Video
 *   (veo/kling/seedance/wan/ltxv/hailuo/grok-imagine/motion/bfl video),
 *   audio (music/sound-effects/dialogue/seed-audio), and tools
 *   (aurora-upscaler/remove-bg/rodin) families are OUT of the image
 *   roster. Default model `flux-schnell` (the guide's canonical
 *   example).
 * - Live no-key ladder (all three endpoints): 401
 *   `{"error":"Authentication hook unauthorized this request","path":
 *   "$","code":"access-denied"}` — the probe's rejected-creds shape;
 *   any other 4xx = validation reached.
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

export class LeonardoImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "LeonardoImageError";
    this.status = options?.status;
  }
}

export class LeonardoImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeonardoImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** The guide's canonical example — the default roster's fast flagship. */
export const LEONARDO_DEFAULT_MODEL = "flux-schnell";

/** The image-only catalog — every id verified against the live v2
 *  reference model enum (scraped 2026-09-18); video/audio/tool families
 *  excluded. */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: "flux-schnell", label: "FLUX.1 [schnell]" },
  { id: "flux-dev", label: "FLUX.1 [dev]" },
  { id: "flux-pro-2.0", label: "FLUX.2 [pro]" },
  { id: "flux-kontext-pro", label: "FLUX.1 Kontext [pro]" },
  { id: "flux-kontext-max", label: "FLUX.1 Kontext Max" },
  { id: "anime-xl", label: "Anime XL" },
  { id: "kino-xl", label: "Kino XL" },
  { id: "phoenix-v1.0", label: "Phoenix 1.0" },
  { id: "phoenix-v0.9", label: "Phoenix 0.9" },
  { id: "portrait-perfect", label: "Portrait Perfect" },
  { id: "concept-art", label: "Concept Art" },
  { id: "lifelike-vision", label: "Lifelike Vision" },
  { id: "lightning-xl", label: "Lightning XL" },
  { id: "stock-photography", label: "Stock Photography" },
  { id: "illustrative-albedo", label: "Illustrative Albedo" },
  { id: "graphic-design", label: "Graphic Design" },
  { id: "ideogram-v3.0", label: "Ideogram 3.0" },
  { id: "ideogram-v4.0", label: "Ideogram 4.0" },
  { id: "ideogram/p-image-ideogram", label: "P-Image (Ideogram)" },
  { id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
  { id: "gemini-image-2", label: "Gemini Image 2" },
  { id: "nano-banana-2", label: "Nano Banana 2" },
  { id: "nano-banana-2-lite", label: "Nano Banana 2 Lite" },
  { id: "lucid-origin", label: "Lucid Origin" },
  { id: "lucid-realism", label: "Lucid Realism" },
  { id: "happy-horse", label: "Happy Horse" },
  { id: "happy-horse-1.1", label: "Happy Horse 1.1" },
  { id: "seedream-4.0", label: "Seedream 4.0" },
  { id: "seedream-4.5", label: "Seedream 4.5" },
  { id: "seedream-5.0-pro", label: "Seedream 5.0 Pro" },
  { id: "gpt-image-1.5", label: "GPT Image 1.5" },
  { id: "gpt-image-2", label: "GPT Image 2" },
  { id: "openai/gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
  { id: "openai/gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
  { id: "recraft-v4", label: "Recraft V4" },
  { id: "recraft-v4-pro", label: "Recraft V4 Pro" },
  { id: "krea-2-turbo", label: "Krea 2 Turbo" },
];

/** Snap a dimension to the documented 8-multiple grid (32–2048). */
export function snapLeonardoDimension(value: number): number {
  const snapped = Math.round(value / 8) * 8;
  const bounded = Math.min(Math.max(snapped, 32), 2048);
  return bounded;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface LeonardoImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): LeonardoImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: /v1 or /v2 suffixed bases keep working.
  if (endpoint.endsWith("/v2")) {
    endpoint = endpoint.slice(0, -"/v2".length);
  } else if (endpoint.endsWith("/v1")) {
    endpoint = endpoint.slice(0, -"/v1".length);
  }
  if (!endpoint) {
    throw new LeonardoImageConfigError("Leonardo config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new LeonardoImageConfigError(
      "Leonardo config error: `apiKey` is required (API credits are purchased separately from web-app plans)",
    );
  }
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, fetch: config.fetch ?? fetch };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

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
    throw new LeonardoImageError(
      `Leonardo ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const leonardoImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || LEONARDO_DEFAULT_MODEL;

      const parameters: Record<string, unknown> = {
        prompt: request.prompt,
        // VT generates ONE image — the vendor default is 4 and would burn
        // API credits (the constant-param class).
        quantity: 1,
      };
      if (request.width !== undefined && request.height !== undefined) {
        parameters.width = snapLeonardoDimension(request.width);
        parameters.height = snapLeonardoDimension(request.height);
      }
      if (request.seed !== undefined) {
        parameters.seed = request.seed;
      }
      // negative/steps/sampler: no v2 surface at all (per-card) — the
      // capability flag is off. prompt_enhance / style_ids / guidances:
      // vendor defaults / no VT seam — never sent.

      const body: Record<string, unknown> = {
        model,
        parameters,
        // Inline delivery + library opt-out (named decisions — see the
        // module doc): dataB64 instead of a URL, nothing persisted to the
        // user's Leonardo library, `public` moot.
        ephemeral: true,
        base64: true,
      };

      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/v2/generationssync`,
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
        throw new LeonardoImageError(
          `Leonardo generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      if (typeof payload !== "object" || payload === null) {
        throw new LeonardoImageError("Leonardo generation returned a non-object payload");
      }
      const root = payload as Record<string, unknown>;

      // blockedCount surfaced (the plan row's demand) — safety blocking
      // is never silently missing images.
      const blockedCount = root.blockedCount;
      if (typeof blockedCount === "number" && blockedCount > 0) {
        throw new LeonardoImageError(
          `Leonardo safety blocking flagged ${blockedCount} result(s) (blockedCount non-zero) — nothing to show`,
        );
      }

      const results = root.results;
      if (!Array.isArray(results) || results.length === 0) {
        throw new LeonardoImageError("Leonardo generation carried no results");
      }
      const first = results[0];
      if (typeof first !== "object" || first === null) {
        throw new LeonardoImageError("Leonardo result entry is not an object");
      }
      const entry = first as Record<string, unknown>;

      const images: ImageGenGeneratedImage[] = [];
      if (typeof entry.dataB64 === "string" && entry.dataB64.length > 0) {
        // The requested inline path (base64: true).
        images.push({
          data: Buffer.from(entry.dataB64, "base64"),
          mimeType: typeof entry.contentType === "string" && entry.contentType.length > 0
            ? entry.contentType
            : "image/png",
        });
      } else if (typeof entry.url === "string" && entry.url.length > 0) {
        // The ephemeral presigned GET (30-minute) — downloaded keyless,
        // server-side, immediately.
        const download = await fetchOrWrap(
          cfg.fetch,
          entry.url,
          { method: "GET", signal: request.signal },
          "image download",
        );
        if (!download.ok) {
          throw new LeonardoImageError(
            `Leonardo image download failed with HTTP ${download.status}`,
            { status: download.status },
          );
        }
        images.push({
          data: Buffer.from(await download.arrayBuffer()),
          mimeType: download.headers.get("content-type") ?? "image/png",
        });
      } else {
        throw new LeonardoImageError("Leonardo result entry carries neither dataB64 nor url");
      }

      const result: ImageGenGenerateResult = { images };
      if (typeof entry.width === "number" && typeof entry.height === "number") {
        result.width = entry.width;
        result.height = entry.height;
      }
      return result;
    },

    async listModels(): Promise<ImageGenModelInfo[]> {
      // Static image-only catalog from the live reference enum (the BFL
      // paths precedent); GET /v2/models is authed and its response shape
      // is JS-collapsed in the current reference — not guessed.
      return STATIC_MODELS.map((m) => ({ ...m }));
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the sync endpoint: an empty
      // body (no model — required) can never generate. Live ladder: 401
      // "Authentication hook unauthorized this request" = rejected; any
      // other 4xx = validation reached (auth passed).
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/v2/generationssync`, {
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
          return { ok: false, detail: "404: sync endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return {
          ok: true,
          detail: `credentials accepted — ${STATIC_MODELS.length} static image models`,
        };
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
registerImageGenBackend(IMAGE_GEN_BACKENDS.Leonardo, leonardoImageFactory);
