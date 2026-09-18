/**
 * @module imagegen/backends/raw-binary
 *
 * IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-3 — the GET/raw-binary arm
 * shared by the whole wave (taxonomy class (d): endpoints that answer
 * image BYTES, not JSON). Three riders:
 *
 * - **Pollinations LEGACY tier** (PE-3 unit 1) — `GET
 *   https://image.pollinations.ai/prompt/{prompt}` returns the image
 *   binary directly; query params `model`/`width`/`height` (defaults
 *   1024 = the vendor's, never ours), `seed`, `nologo` (account),
 *   `enhance`, `private`, `safe`, `image` (kontext img2img), `referrer`.
 *   Card doc-verified 2026-09-07 (repo APIDOCS.md) + re-verified
 *   2026-09-18; supervisor live probes the same day: anonymous
 *   generation STILL WORKS post-gateway-launch (200 `image/jpeg` for a
 *   64×64 prompt, both `model=flux` and `model=sana`) — the card's
 *   "UNVERIFIED anonymous post-gateway" caveat is CLOSED. `GET /models`
 *   returns a bare string array that UNDER-REPORTS (live: `["sana"]`
 *   while `flux` also generates anonymously) → the listing is served
 *   verbatim and the model field stays free text. **Named decision
 *   (seed):** the legacy tier's documented `seed` param stays UNWIRED —
 *   capability rows are per-SLUG and this slug's other tier (the
 *   unified gateway) has no seed surface; a shared slug cannot express
 *   per-tier divergence, and a seed control that silently does nothing
 *   on the keyed tier is worse than a missing one. `nologo`/`enhance`/
 *   `private`/`safe`/`referrer` have no VT contract seam → never sent
 *   (the free-tier watermark stands unless registered upstream).
 * - **Chutes** (PE-3 unit 2) and **Hugging Face Inference Providers**
 *   (PE-3 unit 3) ride the same arm in their own units — see the
 *   CHUTES_OPTIONS / HF_OPTIONS blocks added by those commits.
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
import { normalizeOpenAiCompatibleBaseUrl, buildHeaders } from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class RawBinaryImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-200 response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "RawBinaryImageError";
    this.status = options?.status;
  }
}

export class RawBinaryImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawBinaryImageConfigError";
  }
}

// ─── The generic arm ─────────────────────────────────────────────────────────

/** Resolved per-call transport context handed to every options hook. */
export interface RawBinaryContext {
  endpoint: string;
  apiKey: string;
  fetch: typeof fetch;
}

/** One HTTP plan: a GET with optional auth, or a JSON POST. */
export type RawBinaryRequestPlan =
  | { method: "GET"; url: string }
  | { method: "POST"; url: string; body: Record<string, unknown> };

export interface RawBinaryImageOptions {
  label: string;
  /** Build the HTTP plan for one generation. Throw
   *  RawBinaryImageConfigError for config problems (e.g. missing model). */
  buildRequest(request: ImageGenGenerateRequest, ctx: RawBinaryContext): RawBinaryRequestPlan;
  /** Model listing (static catalog or a live call). */
  listModels(ctx: RawBinaryContext): Promise<ImageGenModelInfo[]>;
  /** Credentials/existence probe. */
  probe(ctx: RawBinaryContext, signal?: AbortSignal): Promise<ImageGenProbeResult>;
}

/** Sniff the image MIME from magic bytes (the payload IS the response —
 *  vendors that error sometimes answer 200 with a text body, which must
 *  surface as an error, not a corrupt "image"). */
export function sniffImageMimeFromBytes(bytes: Buffer): string | null {
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
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

async function executeBinaryPlan(
  plan: RawBinaryRequestPlan,
  ctx: RawBinaryContext,
  label: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string }> {
  const init: RequestInit =
    plan.method === "GET"
      ? {
          method: "GET",
          headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
          signal,
        }
      : {
          method: "POST",
          headers: buildHeaders(ctx.apiKey, true),
          body: JSON.stringify(plan.body),
          signal,
        };
  const response = await ctx.fetch(plan.url, init).catch((cause: unknown) => {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new RawBinaryImageError(
      `${label} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  });
  if (response.status === 202) {
    throw new RawBinaryImageError(
      `${label} returned 202 (async job) — async generation is not supported by this backend in v1`,
      { status: 202 },
    );
  }
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new RawBinaryImageError(
      `${label} failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  if (response.status !== 200) {
    throw new RawBinaryImageError(
      `${label}: expected 200 with image bytes, got HTTP ${response.status}`,
      { status: response.status },
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { bytes: buffer, contentType: response.headers.get("content-type") ?? "" };
}

export function makeRawBinaryImageBackend(
  options: RawBinaryImageOptions,
  config: ImageGenAdapterConfig,
): ImageGenBackend {
  const endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  const apiKey = config.apiKey?.trim() ?? "";
  const ctx: RawBinaryContext = {
    endpoint,
    apiKey,
    fetch: config.fetch ?? fetch,
  };

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const plan = options.buildRequest(request, ctx);
      const { bytes, contentType } = await executeBinaryPlan(plan, ctx, options.label, request.signal);
      const headerMime = contentType.toLowerCase().startsWith("image/")
        ? contentType.split(";")[0].trim()
        : null;
      const sniffed = sniffImageMimeFromBytes(bytes);
      const mimeType = headerMime ?? sniffed;
      if (mimeType === null) {
        const preview = bytes.subarray(0, 40).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
        throw new RawBinaryImageError(
          `${options.label} returned a non-image payload (content-type ${
            contentType || "unknown"
          }, first bytes: ${preview})`,
        );
      }
      const images: ImageGenGeneratedImage[] = [{ data: bytes, mimeType }];
      const result: ImageGenGenerateResult = { images };
      // Echo the requested dims only (unset = the vendor default applied).
      if (request.width !== undefined) result.width = request.width;
      if (request.height !== undefined) result.height = request.height;
      return result;
    },

    listModels(): Promise<ImageGenModelInfo[]> {
      return options.listModels(ctx);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      return options.probe(ctx, signal);
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release.
    },
  };

  return backend;
}

// ─── Pollinations legacy tier (PE-3 unit 1) ─────────────────────────────────

/** Host that selects the legacy GET tier (the preset pins it; the
 *  dispatcher in openai-images-family.ts routes on this). */
export const POLLINATIONS_LEGACY_HOST = "image.pollinations.ai";

function legacyEndpointOrigin(configured: string): string {
  const normalized = normalizeOpenAiCompatibleBaseUrl(configured);
  if (!normalized) {
    throw new RawBinaryImageConfigError("Pollinations (free) config error: `endpoint` is required");
  }
  const parsed = new URL(normalized);
  // Paste tolerance: only the origin matters — the prompt path is built
  // per request.
  return parsed.origin;
}

export const POLLINATIONS_LEGACY_OPTIONS: RawBinaryImageOptions = {
  label: "Pollinations",
  buildRequest(request, ctx) {
    const origin = legacyEndpointOrigin(ctx.endpoint);
    const query = new URLSearchParams();
    const model = request.model?.trim() || "";
    if (model) query.set("model", model);
    if (request.width !== undefined) query.set("width", String(request.width));
    if (request.height !== undefined) query.set("height", String(request.height));
    // seed/nologo/enhance/private/safe/image/referrer: no VT seam (or the
    // per-tier seed named decision) — never sent.
    const qs = query.toString();
    return {
      method: "GET",
      url: `${origin}/prompt/${encodeURIComponent(request.prompt)}${qs ? `?${qs}` : ""}`,
    };
  },
  async listModels(ctx) {
    // Documented legacy listing: bare string array. Live 2026-09-18 it
    // under-reports (["sana"] while flux also generates) — served
    // verbatim; the model field stays free text.
    const origin = legacyEndpointOrigin(ctx.endpoint);
    const response = await ctx.fetch(`${origin}/models`, {
      headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
    });
    if (!response.ok) {
      throw new RawBinaryImageError(
        `Pollinations model listing failed with HTTP ${response.status}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new RawBinaryImageError("Pollinations model listing: expected a JSON array");
    }
    return payload.flatMap((entry): ImageGenModelInfo[] =>
      typeof entry === "string" && entry.length > 0 ? [{ id: entry, label: entry }] : [],
    );
  },
  async probe(ctx, signal) {
    // The zero-config tier: the listing itself is the probe — anonymous
    // 200 live-verified 2026-09-18.
    const origin = legacyEndpointOrigin(ctx.endpoint);
    try {
      const response = await ctx.fetch(`${origin}/models`, {
        headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
        signal,
      });
      if (response.ok) {
        return { ok: true, detail: "anonymous tier reachable — no key required (rate-limited)" };
      }
      if (response.status === 429) {
        // Exists and rate-limits the anonymous tier — the profile works.
        return { ok: true, detail: "reachable — anonymous rate limit hit, retry shortly" };
      }
      const excerpt = await readProviderErrorBody(response);
      return {
        ok: false,
        detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        status: response.status,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};

// ─── Registration ────────────────────────────────────────────────────────────

// The Pollinations slug's two-tier dispatcher lives in
// openai-images-family.ts (it owns the unified-gateway row); later PE-3
// units register their riders here.
