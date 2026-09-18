/**
 * @module imagegen/backends/openai-images
 *
 * OpenAI Images backend adapter (IMAGE_GENERATION_PLAN IG-6) — the
 * `/v1/images/generations` arm. Serves the OpenAI protocol proper (the VT
 * `openai` preset baseUrl matches directly) and Custom cloud endpoints that
 * implement the OpenAI-images shape.
 *
 * FAMILY PARAMETERIZATION (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-1): the
 * same transport serves every OpenAI-images-shaped cloud provider — the
 * exported {@link makeOpenAiImagesFamilyBackend} builds a backend from a
 * per-provider OPTIONS row (size wire mode + documented grid,
 * `response_format` policy, response-envelope normalization, model-list
 * path + filter, request-param wire names). The PE-1 cloud rows live in
 * `openai-images-family.ts`; THIS module keeps the OpenAI-proper options
 * (`openAiImagesFactory`) plus all the shared machinery. Every wire field
 * below traces to a research card (doc-verified) or the supervisor's
 * 2026-09-18 live re-verification deltas.
 *
 * Doc gate (IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH, OpenAI card, doc-verified
 * 2026-09-07 — the source for every OpenAI-proper wire field):
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
  buildHeaders,
  normalizeOpenAiCompatibleBaseUrl,
} from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

/** HTTP / transport failure of a generation or model-list request. Shared by
 *  every backend on the OpenAI-images transport family — the route ladder
 *  (routes/image-gen.ts backendErrorResponse) maps it by class, so family
 *  rows reuse it instead of growing per-slug error classes. */
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

/** A requested size that is not on the provider's documented grid — the
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

// ─── Family parameterization (PE-1) ──────────────────────────────────────────

/** How a family backend carries the caller's size on the wire:
 *  - `grid` — a documented closed set; the table first, then the profile's
 *    IG-20a user entries (a user pair goes on the wire VERBATIM — the entry
 *    IS the vendor claim), everything else fails closed;
 *  - `verbatim` — the card documents a free-form size string and NO closed
 *    grid: a complete W×H goes on the wire as the "WxH" string verbatim,
 *    an incomplete/unset size omits the field (vendor default);
 *  - `width-height` — the card's param surface is integer `width`/`height`
 *    fields (not a size string): a complete W×H rides verbatim as the two
 *    integers, an incomplete/unset size omits both. */
export type OpenAiImagesFamilySizeMode =
  | { kind: "grid"; param: "size" | "image_size"; sizes: ReadonlyMap<string, { width: number; height: number }> }
  | { kind: "verbatim"; param: "size" }
  | { kind: "width-height" };

/** `response_format` policy: DALL-E-only (OpenAI proper — GPT Image models
 *  always return b64_json without the field), always-send a documented
 *  value (the card enumerates the enum; bytes-preferred where URL lifetime
 *  is unstated), or never (the provider's endpoint documents no such
 *  field). */
export type OpenAiImagesFamilyResponseFormat =
  | { kind: "dalle-only" }
  | { kind: "always"; value: string }
  | { kind: "never" };

/** Which response array carries the images: OpenAI's `data[]` envelope, or
 *  SiliconFlow's own `images[]` envelope (its card: the path is
 *  OpenAI-images-style but the response is `{images: [{url}], timings,
 *  seed}` — normalized here, never upstream). */
export type OpenAiImagesFamilyEnvelope = "openai-data" | "siliconflow-images";

/** One PE-1 provider's OPTIONS row — the per-card deltas over the shared
 *  OpenAI-images transport. Every member traces to a research card (or the
 *  supervisor's live re-verification where the card drifted). */
export interface OpenAiImagesFamilyOptions {
  /** Provider display name — prefixes every error/probe message (the
   *  OpenAI-proper row keeps the historical "OpenAI Images" strings). */
  readonly label: string;
  /** Size wire mode (see {@link OpenAiImagesFamilySizeMode}). */
  readonly size: OpenAiImagesFamilySizeMode;
  /** `response_format` policy (see {@link OpenAiImagesFamilyResponseFormat}). */
  readonly responseFormat: OpenAiImagesFamilyResponseFormat;
  /** Response envelope (see {@link OpenAiImagesFamilyEnvelope}). */
  readonly envelope: OpenAiImagesFamilyEnvelope;
  /** Model-list path appended to the endpoint (default "models"; NanoGPT's
   *  card documents a different image-scoped path). */
  readonly modelsPath?: string;
  /** Model-list filter over each catalog entry (default: accept all —
   *  unfiltered truth beats a guessed filter; a filter ships ONLY where the
   *  card documents a discriminator or sanctions a heuristic). */
  readonly modelFilter?: (id: string, entry: Record<string, unknown>) => boolean;
  /** Wire names for the generate request's optional numeric/param fields —
   *  an ABSENT name means the field is never put on the wire for this
   *  provider (no invented params; the value still rides only when the
   *  caller set one — owner's hardcoded-parameters ban). */
  readonly stepsWire?: string;
  readonly guidanceWire?: string;
  readonly seedWire?: string;
  /** `negative_prompt` wire name — absent means the adapter NEVER sends the
   *  field (providers whose current model catalog REJECTS it). */
  readonly negativePromptWire?: string;
  /** Static model catalog (PE-2) — providers whose card documents NO
   *  image-model list endpoint (Z.AI: chat catalog only; Volcengine Ark:
   *  none). When present, `listModels` returns these entries WITHOUT any
   *  HTTP call and the probe stops trusting a catalog count — see
   *  {@link probe}. The ids are the card's documented model enum, never a
   *  guessed filter of some other endpoint's catalog. */
  readonly staticModels?: readonly ImageGenModelInfo[];
  /** Probe strategy (PE-2). `models-list` (default): GET the models path —
   *  works wherever a list endpoint exists (Z.AI: the CHAT /models — a
   *  creds check; the image count comes from `staticModels`).
   *  `invalid-post`: POST an EMPTY body to the generations path — a body
   *  with neither model nor prompt can never generate, so 401/403 = bad
   *  credentials, 404 = wrong endpoint, and any other 4xx (validation)
   *  means auth PASSED (live-probed pattern: Volcengine returns a clean
   *  401 AuthenticationError on a missing key). */
  readonly probe?: { kind: "models-list" } | { kind: "invalid-post" };
  /** Constant generate-body params the provider documents but VT has no
   *  user seam for (PE-2) — merged verbatim into every POST body after the
   *  per-request fields. Carries a named decision in the provider's card
   *  comment (e.g. Volcengine `watermark: false` — the card flags the
   *  vendor default TRUE stamps an "AI 生成" mark; VT never ships it
   *  silently). NEVER a per-request field's home. */
  readonly constantParams?: Record<string, unknown>;
  /** Probe-detail count noun ("image models" for image-scoped listings;
   *   "models" where the unfiltered catalog includes non-image models). */
  readonly probeModelNoun?: string;
}

/** Map a complete W×H onto the documented grid — the static table first,
 *  then the profile's user-added entries (IG-20a): a user pair goes on the
 *  wire VERBATIM as the `size` string (the protocol's size field is
 *  free-form "WxH"; arbitrary W×H is the vendor-documented gpt-image
 *  surface — IG-6 — and custom endpoints document their own grids, so the
 *  ENTRY is the vendor claim, not a guess). Everything else stays the
 *  fail-closed mapping error (the adapter never sends a near-miss size). */
function mapSizeToString(
  label: string,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  width: number,
  height: number,
  userSizes: readonly ImageGenUserSizeEntry[],
): { size: string; width: number; height: number } {
  const key = `${width}x${height}`;
  const entry = sizes.get(key);
  if (entry) return { size: key, ...entry };
  const user = userSizes.find((u) => u.width === width && u.height === height);
  if (user) return { size: key, width, height };
  throw new OpenAiImagesSizeError(
    `${label} has no documented size for ${key} — ` +
      `documented sizes: ${[...sizes.keys()].join(", ")}`,
  );
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
  userSizes: readonly ImageGenUserSizeEntry[];
  fetch: typeof fetch;
}

function parseConfig(label: string, config: ImageGenAdapterConfig): OpenAiImagesConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // A pasted full generation URL (`…/v1/images/generations`) keeps working —
  // the same paste-tolerance the OpenRouter twin applies to
  // `/chat/completions` via the shared normalizer.
  if (endpoint.endsWith("/images/generations")) {
    endpoint = endpoint.slice(0, -"/images/generations".length);
  }
  if (!endpoint) {
    throw new OpenAiImagesConfigError(
      `${label} config error: \`endpoint\` is required`,
    );
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new OpenAiImagesConfigError(
      `${label} config error: \`apiKey\` is required (the card has no keyless surface)`,
    );
  }
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, userSizes: config.userSizes ?? [], fetch: config.fetch ?? fetch };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** Await a fetch call through the injected seam. Transport-level failures
 *  wrap into the adapter's typed error — EXCEPT the caller's own abort,
 *  which is rethrown untouched so cancellation stays distinguishable from
 *  a transport failure (the abort contract of the ai-assistant abort fix). */
async function fetchOrWrap(
  label: string,
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
      `${label} ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

// ─── Response parsing ────────────────────────────────────────────────────────

/** One image entry after shape validation: decoded base64 bytes, or a
 *  URL to download server-side. */
interface ParsedImageEntry {
  readonly data?: Buffer;
  readonly url?: string;
}

/** Pull the image array out of the documented envelope (`data[]` OpenAI
 *  shape, `images[]` SiliconFlow shape), then validate each entry: a
 *  `b64_json` string (the GPT Image shape — always present per the card)
 *  or a `url` string (the DALL-E / hosted-URL surface). Fails closed with a
 *  typed error on absent/malformed containers. The SiliconFlow envelope
 *  additionally reports the effective `seed` — carried onto the generate
 *  result (the contract's "seed the backend actually used"). */
function extractImageEntries(
  label: string,
  payload: unknown,
  envelope: OpenAiImagesFamilyEnvelope,
): { entries: ParsedImageEntry[]; seed?: number } {
  if (typeof payload !== "object" || payload === null) {
    throw new OpenAiImagesError(`${label} response is missing a JSON body`);
  }
  const record = payload as Record<string, unknown>;
  const data = envelope === "siliconflow-images" ? record.images : record.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new OpenAiImagesError(`${label} response carried no images`);
  }
  const seed =
    envelope === "siliconflow-images" && typeof record.seed === "number" && Number.isFinite(record.seed)
      ? record.seed
      : undefined;
  const entries: ParsedImageEntry[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) {
      throw new OpenAiImagesError(`${label} response has a malformed image entry`);
    }
    const item = entry as Record<string, unknown>;
    if (item.b64_json !== undefined) {
      if (typeof item.b64_json !== "string" || item.b64_json.length === 0) {
        throw new OpenAiImagesError(`${label} response has a non-string b64_json entry`);
      }
      const decoded = Buffer.from(item.b64_json, "base64");
      if (decoded.length === 0) {
        throw new OpenAiImagesError(`${label} response has a b64_json entry that decodes to zero bytes`);
      }
      entries.push({ data: decoded });
      continue;
    }
    if (item.url !== undefined) {
      if (typeof item.url !== "string" || item.url.length === 0) {
        throw new OpenAiImagesError(`${label} response has a non-string url entry`);
      }
      if (!/^https?:\/\//i.test(item.url) && !item.url.startsWith("data:")) {
        throw new OpenAiImagesError(
          `${label} response has an unsupported image URL: ${item.url.slice(0, 60)}`,
        );
      }
      entries.push({ url: item.url });
      continue;
    }
    throw new OpenAiImagesError(
      `${label} response has an image entry with neither b64_json nor url`,
    );
  }
  return { entries, seed };
}

/** Parse an OpenAI-compatible model catalog into picker entries. Accepts
 *  the `{data: []}` / `{models: []}` envelopes and a bare top-level array
 *  (DeepInfra's documented public listing shape). Each entry keeps its
 *  catalog enrichment (`name` as label, `description`) when present; the
 *  provider's filter decides membership (absent filter = the card
 *  documents no discriminator — unfiltered truth beats a guessed filter). */
function parseModelInfos(
  parsed: unknown,
  filter: ((id: string, entry: Record<string, unknown>) => boolean) | undefined,
): ImageGenModelInfo[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : null;
  if (data === null) return [];
  const out: ImageGenModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (filter !== undefined && !filter(id, item)) continue;
    // Label enrichment: the common `name`, or the `title` field the
    // Pollinations catalog carries (live-verified 2026-09-18: image-model
    // entries carry title/description, not name).
    const label =
      typeof item.name === "string" && item.name.length > 0
        ? item.name
        : typeof item.title === "string" && item.title.length > 0
          ? item.title
          : id;
    const info: ImageGenModelInfo = { id, label };
    if (typeof item.description === "string" && item.description.length > 0) {
      info.description = item.description;
    }
    out.push(info);
  }
  return out;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Build a backend from a family OPTIONS row + config — the shared
 *  OpenAI-images transport parameterized per provider (PE-1). Behavior for
 *  the OpenAI-proper options row is byte-identical to the historical
 *  `openAiImagesFactory` (pinned by imagegen-openai-images.test.ts). */
export function makeOpenAiImagesFamilyBackend(
  options: OpenAiImagesFamilyOptions,
  config: ImageGenAdapterConfig,
): ImageGenBackend {
  const label = options.label;
  const cfg = parseConfig(label, config);
  const modelsPath = options.modelsPath ?? "models";
  const filter = options.modelFilter;

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model;
      if (!model) {
        throw new OpenAiImagesConfigError(
          `${label} config error: \`model\` is required (the card documents no default model)`,
        );
      }

      // Size wire resolution per options.size — see the mode doc comment.
      // A request without a complete W×H omits the field(s) and the vendor
      // default applies (no invented defaults); a PARTIAL W×H (one of the
      // two set) cannot map and is treated as unset.
      let resolved: { width: number; height: number; sizeString?: string } | undefined;
      if (request.width !== undefined && request.height !== undefined) {
        if (options.size.kind === "grid") {
          const gridSize = mapSizeToString(label, options.size.sizes, request.width, request.height, cfg.userSizes);
          resolved = { width: gridSize.width, height: gridSize.height, sizeString: gridSize.size };
        } else if (options.size.kind === "verbatim") {
          resolved = { width: request.width, height: request.height, sizeString: `${request.width}x${request.height}` };
        } else {
          resolved = { width: request.width, height: request.height };
        }
      }

      // `response_format` per policy — DALL-E-only on the OpenAI card (GPT
      // Image models always return b64_json without it), or a documented
      // always-value for the family rows that enumerate the field.
      let responseFormat: string | undefined;
      if (options.responseFormat.kind === "dalle-only") {
        responseFormat = model.startsWith(DALL_E_MODEL_PREFIX) ? "b64_json" : undefined;
      } else if (options.responseFormat.kind === "always") {
        responseFormat = options.responseFormat.value;
      }

      const body: Record<string, unknown> = {
        model,
        prompt: request.prompt,
      };
      if (resolved?.sizeString !== undefined) {
        const param =
          options.size.kind === "grid" || options.size.kind === "verbatim" ? options.size.param : "size";
        body[param] = resolved.sizeString;
      } else if (resolved !== undefined && options.size.kind === "width-height") {
        body.width = resolved.width;
        body.height = resolved.height;
      }
      if (responseFormat !== undefined) {
        body.response_format = responseFormat;
      }
      // Optional numeric/param fields ride ONLY when the caller set a value
      // (owner's hardcoded-parameters ban) AND the provider's card documents
      // the wire field (absent wire name = never sent — e.g. Recraft's
      // negative_prompt, which its V4/4.1 catalog REJECTS).
      if (options.stepsWire !== undefined && request.steps !== undefined) {
        body[options.stepsWire] = request.steps;
      }
      if (options.guidanceWire !== undefined && request.cfgScale !== undefined) {
        body[options.guidanceWire] = request.cfgScale;
      }
      if (options.seedWire !== undefined && request.seed !== undefined) {
        body[options.seedWire] = request.seed;
      }
      if (
        options.negativePromptWire !== undefined &&
        request.negativePrompt !== undefined &&
        request.negativePrompt !== ""
      ) {
        body[options.negativePromptWire] = request.negativePrompt;
      }
      // Constant documented params (PE-2) — after the per-request fields so
      // a constant can never be overridden by request state (they are names
      // VT has no seam for, by construction).
      if (options.constantParams !== undefined) {
        Object.assign(body, options.constantParams);
      }

      const response = await fetchOrWrap(
        label,
        cfg.fetch,
        `${cfg.endpoint}/images/generations`,
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
        throw new OpenAiImagesError(
          `${label} generation failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      const { entries, seed } = extractImageEntries(label, payload, options.envelope);

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
        // A url entry (the hosted-URL delivery surface) downloads
        // server-side through the seam — the cloud-URL-expiry rule (adapters
        // never hand remote URLs upward; vendor URL lifetimes are unstated
        // or short across the family). Bun's fetch resolves data: URLs
        // natively, same path.
        const download = await fetchOrWrap(
          label,
          cfg.fetch,
          entry.url ?? "",
          { method: "GET", signal: request.signal },
          "image download",
        );
        if (!download.ok) {
          throw new OpenAiImagesError(
            `${label} image download failed with HTTP ${download.status}`,
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
      if (resolved !== undefined) {
        // The wire meaning of the requested size — what was sent.
        result.width = resolved.width;
        result.height = resolved.height;
      }
      if (seed !== undefined) {
        // SiliconFlow envelope: the effective seed rides the response.
        result.seed = seed;
      }
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      // Static catalog (PE-2): the card documents no image-model list
      // endpoint — the documented model enum IS the catalog, no HTTP call.
      if (options.staticModels !== undefined) {
        return options.staticModels.map((m) => ({ ...m }));
      }
      const response = await fetchOrWrap(
        label,
        cfg.fetch,
        `${cfg.endpoint}/${modelsPath}`,
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
          `${label} model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseModelInfos(parsed, filter);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post strategy (PE-2): an empty body can never generate —
      // 401/403 = auth rejected, 404 = wrong endpoint, other 4xx = the
      // request reached validation, i.e. credentials were accepted.
      if (options.probe?.kind === "invalid-post") {
        try {
          const response = await cfg.fetch(`${cfg.endpoint}/images/generations`, {
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
            return { ok: false, detail: "404: generation endpoint not found", status: 404 };
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
            detail: `credentials accepted${options.staticModels !== undefined ? ` — ${options.staticModels.length} static models` : ""}`,
          };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      }
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/${modelsPath}`, {
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
        // Static catalog rows count THEIR OWN enum, not the live chat
        // catalog the creds check happened to hit (Z.AI /models is the
        // chat list — listing chat ids as image models would be a lie).
        const count = options.staticModels?.length ?? parseModelInfos(parsed, filter).length;
        const suffix = options.staticModels !== undefined ? " (static catalog)" : "";
        return { ok: true, detail: `${count} ${options.probeModelNoun ?? "image models"}${suffix}` };
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
}

/** The OpenAI-proper OPTIONS row — the historical openAiImagesFactory
 *  behavior exactly (GPT Image size grid, DALL-E-gated response_format,
 *  image-family model filter, OpenAI data[] envelope). */
const OPENAI_FAMILY_OPTIONS: OpenAiImagesFamilyOptions = {
  label: "OpenAI Images",
  size: { kind: "grid", param: "size", sizes: OPENAI_IMAGES_SIZES },
  responseFormat: { kind: "dalle-only" },
  envelope: "openai-data",
  modelsPath: "models",
  modelFilter: (id) => IMAGE_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix)),
  probeModelNoun: "image models",
};

export const openAiImagesFactory = (config: ImageGenAdapterConfig): ImageGenBackend =>
  makeOpenAiImagesFamilyBackend(OPENAI_FAMILY_OPTIONS, config);

// Module-scope registration (protocol-registry pattern, the STT/TTS twins):
// importing this module makes the 'openai-images' image-gen slug creatable
// via the image-gen registry. The route layer (IG-8) imports this module for
// the side effect, exactly like stt-adapter.ts imports the STT backends.
registerImageGenBackend(IMAGE_GEN_BACKENDS.OpenAiImages, openAiImagesFactory);
