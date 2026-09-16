/**
 * @module imagegen/backends/a1111
 *
 * A1111-compatible local backend adapter (IMAGE_GENERATION_PLAN IG-7) —
 * the `/sdapi/v1` dialect arm. One adapter covers the whole family
 * (AUTOMATIC1111, Forge, Forge-Classic/Neo, reForge, SD.Next, and the
 * third-party runners that speak the dialect) because they share the
 * `/sdapi/v1/*` surface (IMAGE_GEN_LOCAL_BACKENDS_RESEARCH, A1111 card,
 * doc-verified 2026-09-07 — the ONLY source for every wire field below).
 *
 * Doc gate (card facts this adapter implements):
 * - generation: `POST /sdapi/v1/txt2img`. The request model is dynamically
 *   generated from the server's processing class — EVERY field optional,
 *   server-side defaults fill the rest — so this adapter sends ONLY the
 *   fields the request carries (prompt plus negative_prompt / steps /
 *   cfg_scale / width / height / seed / sampler_name when set). The one
 *   card API-only extra sent is `send_images: true` ("VT keeps true").
 *   Per-request model switching rides
 *   `override_settings.sd_model_checkpoint` (accepts title, filename with
 *   or without extension, or hash — passed through verbatim).
 * - response: `{images: [b64 PNG], parameters, info}` — pure base64
 *   strings decoded in-process; no URLs, no expiry problem.
 * - model discovery: `GET /sdapi/v1/sd-models` → `{title, model_name,
 *   hash, sha256, filename, config}` per checkpoint.
 * - samplers: `GET /sdapi/v1/samplers` → `{name, aliases, options}`.
 * - progress: `GET /sdapi/v1/progress` → `{progress: 0..1, eta_relative,
 *   state, current_image (b64 preview, needs show_progress_every_n_steps),
 *   textinfo}` — exposed as a single-fetch snapshot; the route layer owns
 *   any repetition (NO polling interval constant in code).
 * - auth: keyless by default on localhost; `--api-auth "user:pass"` puts
 *   HTTP Basic on the API routes — the optional apiKey carries the
 *   "user:pass" string and becomes an `Authorization: Basic` header.
 *
 * Card-driven deviations from the cloud twins (named, verified):
 * - NO size grid: the dialect takes free width/height integers (registry
 *   `sizeSupport: { kind: "free" }`) — the adapter validates positive
 *   integers and passes width and height through INDEPENDENTLY instead of
 *   mapping a fixed grid; an off-grid size is never an error here.
 * - NO model requirement: with no request/profile model the generation
 *   simply omits `override_settings` and the server's loaded checkpoint
 *   applies (the card's server-defaults rule).
 * - The capability-gated fields ARE sent (registry flags): negative
 *   prompt, sampler_name, seed.
 * - `override_settings_restore_afterwards` is NOT sent — the server
 *   default (true) applies; the card documents the double-reload tradeoff
 *   but no owner-approved VT value exists, and omitting keeps VT
 *   side-effect-free on shared local servers.
 * - `scheduler`, `batch_size`, `n_iter`, `restore_faces`, `tiling`,
 *   `sampler_index` (legacy alias), and `script_name`/`script_args` are
 *   never sent — the v1 request interface carries no field for them and
 *   inventing values is banned. The ONE script surface is ADetailer
 *   (IG-CF15/PG-4 v1): when the request carries `adetailerModel`, it ships
 *   as `alwayson_scripts.ADetailer.args = [true, {ad_model}]` — the
 *   extension script's own arg contract (source-pinned: a leading enable
 *   bool + pydantic dicts with `extra=forbid`, an `ad_model` of "None"
 *   means skip, all other fields default server-side). `clip_skip` is
 *   likewise absent: it is NOT in the card's enumerated core param
 *   surface (prompt, negative_prompt, steps, cfg_scale, width, height,
 *   seed, sampler_name, scheduler, batch_size, n_iter, restore_faces,
 *   tiling, override_settings).
 * - `parameters` and `info` in the response are not parsed — the card
 *   documents the envelope only, not their inner shape — so `result.seed`
 *   stays unset here even though the backend interface notes A1111 can
 *   report a resolved seed.
 * - `progress.state` passes through only when the wire value is a string;
 *   an object-valued state (shape not card-documented) is omitted rather
 *   than inventing a serialization. `textinfo` has no interface field and
 *   is not mapped.
 * - probe hits `GET /sdapi/v1/sd-models` alone; the card's probe recipe
 *   also names `/samplers`, but sampler discovery rides listSamplers —
 *   one request per probe, matching the IG-4 contract and the twins.
 *
 * House deltas from the STT/TTS adapters (per the IG-4 contract):
 * - NO timeout constants anywhere (owner's hardcoded-parameters ban) — the
 *   AbortSignal seam forwards the caller's signal, nothing wraps it;
 * - the transport is the config-injected `fetch` (tier T1 seam), not a
 *   global — one seam for the txt2img POST, model/sampler/progress GETs.
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
  ImageGenProgressInfo,
  ImageGenSamplerInfo,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

/** HTTP / transport failure of a generation or listing request. */
export class A1111ImageGenError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures — DNS, refused, aborts that
   *  are not the caller's own signal). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "A1111ImageGenError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint). */
export class A1111ImageGenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A1111ImageGenConfigError";
  }
}

/** A width/height that is not a positive integer — the free-size fail
 *  closed error (the dialect takes free W×H, but only well-formed ones). */
export class A1111ImageGenSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A1111ImageGenSizeError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a pasted base URL onto the `/sdapi/v1` root: trailing slashes
 *  and a pasted `…/txt2img` generation path are tolerated; a URL that
 *  already ends at `/sdapi/v1` passes through unchanged (the same
 *  paste-tolerance discipline as the cloud twins). */
function normalizeSdApiBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/txt2img")) {
    normalized = normalized.slice(0, -"/txt2img".length);
  }
  if (!normalized) return "";
  if (normalized.endsWith("/sdapi/v1")) return normalized;
  return `${normalized}/sdapi/v1`;
}

/** Request headers for the dialect: JSON accept, content-type on POSTs,
 *  and `Authorization: Basic base64("user:pass")` from the optional apiKey
 *  (the card's `--api-auth` mechanism). Keyless servers get no auth header. */
function buildSdApiHeaders(apiKey: string, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (withBody) {
    headers["Content-Type"] = "application/json";
  }
  if (apiKey) {
    headers.Authorization = `Basic ${Buffer.from(apiKey, "utf-8").toString("base64")}`;
  }
  return headers;
}

/** A set string field: trimmed and non-empty, else undefined (unset fields
 *  are omitted from the wire body — the card's server-defaults rule). */
function setOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Validate a free W×H integer (positive, finite, integral). */
function requirePositiveInt(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new A1111ImageGenSizeError(
      `A1111 image generation accepts a positive integer ${name} — got ${value}`,
    );
  }
  return value;
}

/** Sniff the MIME type from image bytes by format signature (png / jpeg /
 *  webp). The card documents the txt2img response as b64 PNG — the sniff
 *  tolerates fork deltas (jpeg outputs), and the fallback is the card's
 *  documented format. These are format parsers, not tunable parameters. */
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
    throw new A1111ImageGenError(
      `A1111 image-gen ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

// ─── Response parsing ────────────────────────────────────────────────────────

/** Pull `images[]` out of the documented `{images, parameters, info}`
 *  envelope — non-empty base64 PNG strings. `parameters`/`info` are not
 *  parsed (inner shape not card-documented). Fails closed on absent,
 *  malformed, or empty containers. */
function extractImages(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) {
    throw new A1111ImageGenError("A1111 image-gen response is missing a JSON body");
  }
  const images = (payload as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new A1111ImageGenError("A1111 image-gen response carried no images");
  }
  for (const entry of images) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new A1111ImageGenError("A1111 image-gen response has a non-string images[] entry");
    }
  }
  return images;
}

/** Parse the `GET /sdapi/v1/sd-models` checkpoint list — a top-level array
 *  of `{title, model_name, hash, sha256, filename, config}` records. `id`
 *  maps `model_name` (the switchable identifier), `label` maps `title`
 *  (the picker display string). Entries without a usable model_name are
 *  skipped (the twins' malformed-entry discipline). */
function parseCheckpointInfos(parsed: unknown): ImageGenModelInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenModelInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const id = item.model_name;
    if (typeof id !== "string" || id.length === 0) continue;
    const info: ImageGenModelInfo = {
      id,
      label: typeof item.title === "string" && item.title.length > 0 ? item.title : id,
    };
    out.push(info);
  }
  return out;
}

/** Parse the `GET /sdapi/v1/samplers` list — a top-level array of
 *  `{name, aliases, options}` records mapped onto `{name, aliases?}`. */
function parseSamplerInfos(parsed: unknown): ImageGenSamplerInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenSamplerInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const info: ImageGenSamplerInfo = { name };
    if (
      Array.isArray(item.aliases) &&
      item.aliases.every((alias) => typeof alias === "string")
    ) {
      info.aliases = item.aliases as string[];
    }
    out.push(info);
  }
  return out;
}

/** Parse the `GET /sdapi/v1/extensions` list — a top-level array of
 *  `{name, dirname, enabled, builtin}` records; `name` is the extension's
 *  directory identifier (the ADetailer probe's `adetailer`). Entries
 *  without a string name are skipped (the malformed-entry discipline). */
function parseExtensionNames(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) out.push(name);
  }
  return out;
}

/** Parse the `GET /sdapi/v1/progress` snapshot. `progress` (0..1) is the
 *  documented core and required; `eta_relative` maps when numeric;
 *  `state` passes through only as a string (object shape not
 *  card-documented — omitted rather than inventing a serialization);
 *  `current_image` (b64 preview, absent unless the server produces
 *  previews) maps onto `previewBase64` when non-empty. */
function parseProgressInfo(payload: unknown): ImageGenProgressInfo {
  if (typeof payload !== "object" || payload === null) {
    throw new A1111ImageGenError("A1111 progress response is missing a JSON body");
  }
  const record = payload as Record<string, unknown>;
  const progress = record.progress;
  if (typeof progress !== "number" || !Number.isFinite(progress)) {
    throw new A1111ImageGenError("A1111 progress response has no numeric progress value");
  }
  const info: ImageGenProgressInfo = { progress };
  const eta = record.eta_relative;
  if (typeof eta === "number" && Number.isFinite(eta)) {
    info.etaRelative = eta;
  }
  if (typeof record.state === "string") {
    info.state = record.state;
  }
  if (typeof record.current_image === "string" && record.current_image.length > 0) {
    info.previewBase64 = record.current_image;
  }
  return info;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface A1111ImageGenConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): A1111ImageGenConfig {
  const endpoint = normalizeSdApiBaseUrl(config.endpoint ?? "");
  if (!endpoint) {
    throw new A1111ImageGenConfigError(
      "A1111 image-gen config error: `endpoint` is required (the local server's base URL, e.g. http://127.0.0.1:7860)",
    );
  }
  // apiKey is OPTIONAL here (registry noApiKey: true) — keyless localhost is
  // the dialect default; "user:pass" turns into HTTP Basic when present.
  return {
    endpoint,
    apiKey: config.apiKey?.trim() ?? "",
    model: setOrUndefined(config.model),
    fetch: config.fetch ?? fetch,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const a1111Factory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      // Card rule: EVERY field optional, server defaults fill the rest —
      // the body carries prompt + ONLY the overrides the request sets.
      const body: Record<string, unknown> = {
        prompt: request.prompt,
        // The card's API-only extra: "send_images (bool, VT keeps true)".
        send_images: true,
      };
      const negativePrompt = setOrUndefined(request.negativePrompt);
      if (negativePrompt !== undefined) body.negative_prompt = negativePrompt;
      if (request.steps !== undefined) body.steps = request.steps;
      if (request.cfgScale !== undefined) body.cfg_scale = request.cfgScale;
      // Free W×H: validated positive integers, sent INDEPENDENTLY (unlike
      // the cloud twins' coupled complete-size rule).
      if (request.width !== undefined) body.width = requirePositiveInt("width", request.width);
      if (request.height !== undefined) body.height = requirePositiveInt("height", request.height);
      // Seed passes through verbatim — -1 is the dialect's own "random"
      // sentinel, resolved server-side.
      if (request.seed !== undefined) body.seed = request.seed;
      const sampler = setOrUndefined(request.sampler);
      if (sampler !== undefined) body.sampler_name = sampler;
      const model = setOrUndefined(request.model) ?? cfg.model;
      if (model !== undefined) {
        // Card: model switching accepts title, filename, or hash — verbatim.
        body.override_settings = { sd_model_checkpoint: model };
      }
      // ADetailer (IG-CF15/PG-4 v1): presence = enabled — the extension
      // script's own arg contract (see the module doc gate).
      const adetailerModel = setOrUndefined(request.adetailerModel);
      if (adetailerModel !== undefined) {
        body.alwayson_scripts = {
          ADetailer: { args: [true, { ad_model: adetailerModel }] },
        };
      }

      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/txt2img`,
        {
          method: "POST",
          headers: buildSdApiHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: request.signal,
        },
        "generation",
      );

      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new A1111ImageGenError(
          `A1111 image generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const encoded = extractImages(payload);

      const images: ImageGenGeneratedImage[] = [];
      for (const entry of encoded) {
        const data = Buffer.from(entry, "base64");
        if (data.length === 0) {
          throw new A1111ImageGenError("A1111 image-gen response has an images[] entry that decodes to zero bytes");
        }
        images.push({
          data,
          mimeType: sniffImageMime(data) ?? "image/png",
        });
      }

      // The wire meaning of what was sent — width/height echo independently.
      const result: ImageGenGenerateResult = { images };
      if (request.width !== undefined) result.width = request.width;
      if (request.height !== undefined) result.height = request.height;
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/sd-models`,
        {
          method: "GET",
          headers: buildSdApiHeaders(cfg.apiKey, false),
          signal,
        },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new A1111ImageGenError(
          `A1111 model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseCheckpointInfos(parsed);
    },

    async listSamplers(signal?: AbortSignal): Promise<ImageGenSamplerInfo[]> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/samplers`,
        {
          method: "GET",
          headers: buildSdApiHeaders(cfg.apiKey, false),
          signal,
        },
        "sampler list",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new A1111ImageGenError(
          `A1111 sampler list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseSamplerInfos(parsed);
    },

    async listExtensions(signal?: AbortSignal): Promise<string[]> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/extensions`,
        {
          method: "GET",
          headers: buildSdApiHeaders(cfg.apiKey, false),
          signal,
        },
        "extension list",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new A1111ImageGenError(
          `A1111 extension list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseExtensionNames(parsed);
    },

    async progress(signal?: AbortSignal): Promise<ImageGenProgressInfo> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/progress`,
        {
          method: "GET",
          headers: buildSdApiHeaders(cfg.apiKey, false),
          signal,
        },
        "progress",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new A1111ImageGenError(
          `A1111 progress failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseProgressInfo(parsed);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/sd-models`, {
          method: "GET",
          headers: buildSdApiHeaders(cfg.apiKey, false),
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
        return { ok: true, detail: `${parseCheckpointInfos(parsed).length} checkpoints` };
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
// importing this module makes the 'a1111' image-gen slug creatable via the
// image-gen registry. The route layer (IG-8) imports this module for the
// side effect, exactly like stt-adapter.ts imports the STT backends.
registerImageGenBackend(IMAGE_GEN_BACKENDS.A1111, a1111Factory);
