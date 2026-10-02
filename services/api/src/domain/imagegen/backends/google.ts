/**
 * @module imagegen/backends/google
 *
 * Google Gemini image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-4
 * unit 1) — Nano Banana through the **Interactions API**, the Gemini
 * API's primary surface (GA since June 2026).
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Google Gemini (Nano
 * Banana)", doc-verified 2026-09-07; re-verified live 2026-09-18 against
 * ai.google.dev — see the drift note):
 * - `POST https://generativelanguage.googleapis.com/v1beta/interactions`,
 *   header `x-goog-api-key` (NOT Bearer — the Gemini API key header), body
 *   `{model, input: [{type:"text", text}], response_format?, store?}`.
 * - Models (the image-gen page's own four): `gemini-3.1-flash-image`
 *   (Nano Banana 2 — the documented workhorse, the profile default),
 *   `gemini-3.1-flash-lite-image` (fastest, 1K only),
 *   `gemini-3-pro-image` (premium, interleaved text+image output),
 *   `gemini-2.5-flash-image` (legacy). Free-text model field covers the
 *   rest of the catalog.
 * - `response_format: {type:"image", aspect_ratio, image_size}` —
 *   aspect_ratio from the documented 10-value set (1:1, 3:2, 2:3, 3:4,
 *   4:3, 4:5, 5:4, 9:16, 16:9, 21:9), image_size `1K` (default) | `2K` |
 *   `4K` | `512px` — **uppercase K required** (lowercase rejected).
 * - Response (Interactions API reference, pinned from the official
 *   interaction example + ImageContent resource): an Interaction object
 *   `{status: "completed", steps: [{type: "model_output"|"thought"|…,
 *   content: [{type:"text"|"image", …}]}], usage}` — image blocks carry
 *   base64 `data` + `mime_type` (image/png|jpeg|webp|gif|bmp|tiff|…).
 *   Thought steps can hold up to two INTERIM images (not charged); the
 *   final render repeats in `model_output`. The adapter takes the LAST
 *   image across `model_output` steps (Pro interleaves text+images — the
 *   last image is the final render), falling back to thought-step images
 *   only when no model_output image exists.
 * - No negative prompt, no seed/steps/cfg/sampler surface (thinking_level
 *   exists on 3.1 Flash/Lite but has no VT seam — never sent).
 * - `store`: the API retains interactions by default (55 d paid / 1 d
 *   free). VT sends `store: false` — one-shot t2i never continues a
 *   conversation, and a local-first app should not leave prompt
 *   history on the vendor (named decision, documented opt-out).
 * - **DRIFT (live 2026-09-18, page updated 2026-09-17): Imagen is SHUT
 *   DOWN on the Gemini API** ("Imagen models are shut down… no longer
 *   available through the Gemini API") — the card's Imagen `:predict`
 *   sub-family and its EN-only hint are DEAD; this arm is
 *   Interactions-only. Card note logged in the research report.
 * - Live probes (2026-09-18): POST /v1beta/interactions without a key →
 *   403 PERMISSION_DENIED ("unregistered callers"); with an invalid key →
 *   **400 INVALID_ARGUMENT `API_KEY_INVALID`** (NOT 401 — creds rejection
 *   is a 400 carrying reason `API_KEY_INVALID`), and the error body on
 *   this endpoint arrives **JSON-array-wrapped** (`[{error: {…}}]`) —
 *   both pinned by tests.
 * - Model discovery: `GET /v1beta/models` with the same key →
 *   `{models: [{name: "models/<id>", displayName, …}]}` — filtered to
 *   image models by the `-image` suffix (the image-gen page's own naming
 *   convention: every Gemini image model id ends in `-image`).
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

export class GoogleImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "GoogleImageError";
    this.status = options?.status;
  }
}

export class GoogleImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleImageConfigError";
  }
}

// ─── Documented surface (card + live docs 2026-09-18) ───────────────────────

/** The documented aspect-ratio set (the Gemini 3.1 Flash Lite list — the
 *  docs' current superset). Ratio values are the DOCUMENTED wire strings. */
const GOOGLE_ASPECT_RATIOS: readonly { ratio: string; width: number; height: number }[] = [
  { ratio: "1:1", width: 1, height: 1 },
  { ratio: "3:2", width: 3, height: 2 },
  { ratio: "2:3", width: 2, height: 3 },
  { ratio: "3:4", width: 3, height: 4 },
  { ratio: "4:3", width: 4, height: 3 },
  { ratio: "4:5", width: 4, height: 5 },
  { ratio: "5:4", width: 5, height: 4 },
  { ratio: "9:16", width: 9, height: 16 },
  { ratio: "16:9", width: 16, height: 9 },
  { ratio: "21:9", width: 21, height: 9 },
];

/** Map a W×H onto Google's documented ratio set: exact fraction match,
 *  else the NEAREST ratio by |log(w/h) − log(rw/rh)| (deterministic,
 *  documented enum values only — the mapSd3AspectRatio precedent; first
 *  entry wins ties). Exported as the test seam. */
export function mapGoogleAspectRatio(width: number, height: number): string {
  for (const entry of GOOGLE_ASPECT_RATIOS) {
    if (width * entry.height === height * entry.width) return entry.ratio;
  }
  const target = Math.log(width / height);
  let best = GOOGLE_ASPECT_RATIOS[0];
  let bestDistance = Math.abs(target - Math.log(best.width / best.height));
  for (const entry of GOOGLE_ASPECT_RATIOS.slice(1)) {
    const distance = Math.abs(target - Math.log(entry.width / entry.height));
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best.ratio;
}

/** The image_size anchors the adapter can pick: 1K (1024), 2K (2048),
 *  4K (4096) — the general tiers every model accepts. The documented
 *  `512px` tier is 3.1-Flash-ONLY: the size seam cannot diverge per
 *  model, so the adapter NEVER sends it (a 512×512 request maps to 1K —
 *  named decision, same shape as the pollinations legacy-seed call). */
const GOOGLE_IMAGE_SIZE_ANCHORS: readonly { size: string; pixels: number }[] = [
  { size: "1K", pixels: 1024 },
  { size: "2K", pixels: 2048 },
  { size: "4K", pixels: 4096 },
];

/** Map the larger request dimension onto the nearest documented image_size
 *  tier (uppercase K — lowercase is rejected). First entry wins ties
 *  (smaller = cheaper, deterministic). Exported as the test seam. */
export function mapGoogleImageSize(width: number, height: number): string {
  const maxDim = Math.max(width, height);
  let best = GOOGLE_IMAGE_SIZE_ANCHORS[0];
  let bestDistance = Math.abs(Math.log(maxDim / best.pixels));
  for (const entry of GOOGLE_IMAGE_SIZE_ANCHORS.slice(1)) {
    const distance = Math.abs(Math.log(maxDim / entry.pixels));
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best.size;
}

/** The image-gen page's workhorse model — the profile default (the
 *  documented-default precedent). */
const DEFAULT_MODEL = "gemini-3.1-flash-image";

// ─── Config ──────────────────────────────────────────────────────────────────

interface GoogleImageConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): GoogleImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: full interaction URLs and version-carrying bases
  // normalize to the bare host (paths below own their /v1beta prefix).
  if (endpoint.endsWith("/v1beta/interactions")) {
    endpoint = endpoint.slice(0, -"/v1beta/interactions".length);
  } else if (endpoint.endsWith("/interactions")) {
    endpoint = endpoint.slice(0, -"/interactions".length);
  } else if (endpoint.endsWith("/v1beta")) {
    endpoint = endpoint.slice(0, -"/v1beta".length);
  }
  if (!endpoint) {
    throw new GoogleImageConfigError("Google config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new GoogleImageConfigError(
      "Google config error: `apiKey` is required (the card has no keyless surface)",
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
    throw new GoogleImageError(
      `Google ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** Google's error body — `{error: {code, message, status, details}}`,
 *  ARRAY-wrapped on the interactions endpoint (live 2026-09-18). Returns
 *  the inner error object, or null when the payload is not a recognizable
 *  Google error shape. */
function extractGoogleError(payload: unknown): { message?: string; reason?: string } | null {
  const errorObject =
    Array.isArray(payload) && payload.length > 0 && typeof payload[0] === "object" && payload[0] !== null
      ? (payload[0] as Record<string, unknown>).error
      : typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).error
        : undefined;
  if (typeof errorObject !== "object" || errorObject === null) return null;
  const record = errorObject as Record<string, unknown>;
  const details = Array.isArray(record.details) ? record.details : [];
  const reasonEntry = details.find(
    (detail): detail is Record<string, unknown> =>
      typeof detail === "object" && detail !== null && "reason" in detail,
  );
  return {
    message: typeof record.message === "string" ? record.message : undefined,
    reason: reasonEntry !== undefined && typeof reasonEntry.reason === "string" ? reasonEntry.reason : undefined,
  };
}

/** Read a failed response into a typed error with the best excerpt
 *  available (the array-wrapped body included). */
async function toGoogleHttpError(response: Response, operation: string): Promise<GoogleImageError> {
  const excerpt = await readProviderErrorBody(response);
  return new GoogleImageError(
    `Google ${operation} failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
    { status: response.status },
  );
}

interface ParsedImageBlock {
  data: string;
  mimeType: string | undefined;
}

/** Pull the final image off an interaction: the LAST image block across
 *  `model_output` steps; thought-step images only as a fallback (they are
 *  interim composition probes — the final render repeats in model_output). */
function findFinalImage(payload: unknown): ParsedImageBlock | null {
  if (typeof payload !== "object" || payload === null) return null;
  const steps = (payload as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return null;
  let fallback: ParsedImageBlock | null = null;
  let output: ParsedImageBlock | null = null;
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    const isOutput = record.type === "model_output";
    const isThought = record.type === "thought";
    if (!isOutput && !isThought) continue;
    const content = record.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const blockRecord = block as Record<string, unknown>;
      if (blockRecord.type !== "image") continue;
      if (typeof blockRecord.data !== "string" || blockRecord.data.length === 0) continue;
      const parsed: ParsedImageBlock = {
        data: blockRecord.data,
        mimeType: typeof blockRecord.mime_type === "string" ? blockRecord.mime_type : undefined,
      };
      if (isOutput) output = parsed;
      else if (fallback === null) fallback = parsed;
    }
  }
  return output ?? fallback;
}

function decodeImage(block: ParsedImageBlock): ImageGenGeneratedImage {
  const data = Buffer.from(block.data, "base64");
  const mimeType = block.mimeType ?? sniffImageMime(data) ?? "image/png";
  return { data, mimeType };
}

/** MIME sniffing for responses that omit mime_type (the family helper's
 *  logic, local twin). */
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
  IMAGE_GEN_BACKENDS.Google,
  (config: ImageGenAdapterConfig): ImageGenBackend => {
    const parsed = parseConfig(config);
    const interactionsUrl = `${parsed.endpoint}/v1beta/interactions`;

    function googleHeaders(): Record<string, string> {
      return {
        "x-goog-api-key": parsed.apiKey,
        "Content-Type": "application/json",
      };
    }

    return {
      async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
        const model = request.model?.trim() || parsed.model;
        const body: Record<string, unknown> = {
          model,
          input: [{ type: "text", text: request.prompt }],
          // One-shot t2i never continues a conversation — opt out of the
          // vendor's interaction retention (the documented `store: false`).
          store: false,
        };
        if (request.width !== undefined && request.height !== undefined) {
          body.response_format = {
            type: "image",
            aspect_ratio: mapGoogleAspectRatio(request.width, request.height),
            image_size: mapGoogleImageSize(request.width, request.height),
          };
        }
        const response = await fetchOrWrap(
          parsed.fetch,
          interactionsUrl,
          { method: "POST", headers: googleHeaders(), body: JSON.stringify(body), signal: request.signal },
          "image generation",
        );
        if (!response.ok) {
          throw await toGoogleHttpError(response, "image generation");
        }
        const payload: unknown = await response.json();
        const finalImage = findFinalImage(payload);
        if (finalImage === null) {
          const error = extractGoogleError(payload);
          // Failures can also ride inside HTTP 200 (safety refusals come
          // back as interactions without an image block) — surface the
          // vendor message when present, a typed error otherwise.
          throw new GoogleImageError(
            error?.message !== undefined && error.message.length > 0
              ? `Google image generation returned no image: ${error.message}`
              : "Google image generation returned no image block (possible safety refusal)",
          );
        }
        return { images: [decodeImage(finalImage)] };
      },

      async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
        const response = await fetchOrWrap(
          parsed.fetch,
          `${parsed.endpoint}/v1beta/models`,
          { method: "GET", headers: googleHeaders(), signal },
          "model listing",
        );
        if (!response.ok) {
          throw await toGoogleHttpError(response, "model listing");
        }
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Record<string, unknown>).models)) {
          throw new GoogleImageError("Google model listing: expected `{models: [...]}`");
        }
        const models = (payload as Record<string, unknown>).models as unknown[];
        return models.flatMap((entry): ImageGenModelInfo[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const record = entry as Record<string, unknown>;
          if (typeof record.name !== "string") return [];
          const id = record.name.replace(/^models\//, "");
          // The image-model discriminator: every Gemini image model id
          // ends in `-image` (the image-gen page's own naming).
          if (!id.endsWith("-image")) return [];
          const label = typeof record.displayName === "string" && record.displayName.length > 0
            ? record.displayName
            : id;
          return [{ id, label }];
        });
      },

      async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
        // invalid-post creds discrimination on the live-probed endpoint:
        // an invalid key answers 400 with reason API_KEY_INVALID (NOT 401)
        // or 403 PERMISSION_DENIED — both = rejected; any other 4xx means
        // validation was reached with working credentials; 5xx = fail.
        try {
          const response = await parsed.fetch(interactionsUrl, {
            method: "POST",
            headers: googleHeaders(),
            body: JSON.stringify({}),
            signal,
          });
          if (response.ok) {
            return { ok: true, detail: "credentials accepted" };
          }
          const payload: unknown = await response.json().catch(() => null);
          const error = extractGoogleError(payload);
          if (
            response.status === 401 ||
            response.status === 403 ||
            error?.reason === "API_KEY_INVALID"
          ) {
            const message = error?.message ?? "";
            return {
              ok: false,
              detail: `${response.status}${message.length > 0 ? `: ${message}` : ""} — credentials rejected`,
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
        // No persistent resources — the arm is request-scoped (the wave's
        // shared no-op contract).
      },
    };
  },
);
