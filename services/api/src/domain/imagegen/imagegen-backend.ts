/**
 * @module imagegen/imagegen-backend
 *
 * Backend contract for image generation. Each adapter protocol (openrouter,
 * openai-images, a1111) implements this interface; the registry
 * (imagegen-registry.ts) is the single source of truth for per-backend
 * capability flags and factory lookup. Mirrors the STT/TTS backend contracts
 * and the providers protocol-registry pattern (IMAGE_GENERATION_PLAN IG-4).
 *
 * v1 roster (owner-locked): OpenRouter (chat-completions transport with
 * modalities, per IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH), the OpenAI-images
 * protocol (serves Custom cloud endpoints), and the A1111-compatible local
 * dialect (per IMAGE_GEN_LOCAL_BACKENDS_RESEARCH).
 */

import type { ImageGenCapabilityFlags, ImageGenUserSizeEntry } from "@vibe-tavern/domain";

/** Factory config — resolved from the profile by the caller: the endpoint
 *  base URL, the write-only API key (absent for keyless backends), and the
 *  selected model (may be unset on a fresh profile — the request-time model
 *  or the vendor default applies). */
export interface ImageGenAdapterConfig {
  /** Base URL the adapter talks to. */
  endpoint: string;
  /** API key / credential (absent = keyless backend or endpoint without
   *  auth; the A1111 adapter additionally accepts "user:pass" here for
   *  `--api-auth` HTTP Basic, per its research card). */
  apiKey?: string;
  /** Selected model id (level-2 picker); optional per the STT P8 pattern. */
  model?: string;
  /** User-added vendor-size entries (IG-20a) — consulted AFTER the static
   *  documented table at the size-mapping seam: table hit → wire value from
   *  the table; user-entry hit → wire value from the entry (OpenRouter uses
   *  its `ratio`, the OpenAI-images family uses "WxH" verbatim); anything
   *  else stays the fail-closed mapping error. */
  userSizes?: readonly ImageGenUserSizeEntry[];
  /** Transport injection seam — the fetch function every HTTP call goes
   *  through (generation POST, model list, server-side byte download of
   *  returned images). Defaults to the global fetch. Tests inject a double
   *  through this field (tier T1 — no globalThis patching), and the route
   *  layer can hand adapters the proxy-aware provider fetch — the same
   *  seam the LLM providers use. */
  fetch?: typeof fetch;
  /** WebSocket opener seam (CG-C1, comfyui) — the live-progress listener's
   *  socket. Defaults to the global WebSocket; tests inject a double through
   *  this field (the fetch seam's twin, tier T1). */
  openWebSocket?: (url: string) => ImageGenWebSocketLike;
}

/** Minimal WebSocket surface a backend's live-progress listener needs
 *  (CG-C1) — deliberately narrow: the global WebSocket satisfies it, so
 *  tests inject doubles without a DOM. Property-handler style, not
 *  addEventListener overloads, so a fake is five lines. */
export interface ImageGenWebSocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

/** One generation request — a union over the v1 protocols' parameter
 *  surfaces. EVERY generation-value field is optional (owner's
 *  hardcoded-parameters ban): adapters send only the fields the user set,
 *  everything else falls to the vendor default. The wire fields map:
 *  A1111 `txt2img` takes them nearly verbatim; the OpenAI-images protocol
 *  consumes prompt/model/size; the OpenRouter adapter maps width/height onto
 *  its documented aspect-ratio table. */
export interface ImageGenGenerateRequest {
  /** Positive prompt (template-substituted upstream). */
  prompt: string;
  /** Negative prompt — only sent by backends with
   *  `supportsNegativePrompt`. */
  negativePrompt?: string;
  /** Per-request model override (the fine-tuning chip); falls back to the
   *  profile's selected model when absent. */
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  sampler?: string;
  /** Schedule type (PG-3, A1111 dialect) — the sampler's schedule riding
   *  the txt2img payload per request; absent = the server's own default. */
  scheduler?: string;
  /** Text-encoder sidecar file for the ComfyUI DiT template (CG-A2,
   *  comfyui dialect only): rides the request when the profile/overlay
   *  pins it; absent = the adapter's canonical live-folder resolution. */
  encoderName?: string;
  /** VAE sidecar file for the ComfyUI DiT template (CG-A2, comfyui
   *  dialect only). Absent = the adapter's canonical resolution. */
  vaeName?: string;
  seed?: number;
  clipSkip?: number;
  /** ADetailer face-fix model (IG-CF15/PG-4 v1, A1111-family only):
   *  PRESENCE = enabled — the a1111 adapter sends
   *  `alwayson_scripts: {ADetailer: {args: [true, {ad_model}]}}` (the
   *  extension script's own arg signature: a leading enable bool plus
   *  pydantic dicts whose `ad_model` names the face detector; "None" skips).
   *  Other backends ignore the field. */
  adetailerModel?: string;
  /** Enabled LoRAs of this run (CG-C2, capability-gated backends): each
   *  entry maps onto the backend's own wire — ComfyUI threads them as
   *  LoraLoader nodes (one strength feeding strength_model +
   *  strength_clip); the A1111 dialect appends <lora:name:strength> tags
   *  to the prompt (FT-A4). Other backends ignore the field. */
  loras?: Array<{ name: string; strength: number }>;
  /** Cooperative cancellation — adapters forward it to their HTTP calls.
   *  LOCAL backends carry no timeout (owner 2026-09-14: explicit cancel
   *  only); CLOUD backends are wrapped at the adapter layer with
   *  IMAGE_GENERATION_CLOUD_TIMEOUT_MS. */
  signal?: AbortSignal;
}

/** Cloud generation timeout budget (owner-approved 2026-09-14: 3 minutes).
 *  Applies ONLY to non-local backends — local servers (A1111) render as long
 *  as they render; the user's explicit cancel is the only local limit. */
export const IMAGE_GENERATION_CLOUD_TIMEOUT_MS = 180_000;

/** A timed-out CLOUD call (route → 504). Local backends never throw this —
 *  they run until the user's explicit cancel (owner 2026-09-14). */
export class ImageGenTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenTimeoutError";
  }
}

/** Wrap an async backend call with a timeout budget (owner 2026-09-14):
 *  the caller's signal is honored (immediate abort), the internal timer
 *  aborts after `ms`, and a TIMER-caused abort surfaces as a timeout error
 *  message instead of a silent user-cancel. Pure helper — no adapter state. */
export async function withImageGenTimeoutMs<T>(
  outer: AbortSignal | undefined,
  ms: number,
  operation: string,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const forwardOuter = () => controller.abort();
  if (outer?.aborted) {
    clearTimeout(timer);
    throw new DOMException("Aborted", "AbortError");
  }
  outer?.addEventListener("abort", forwardOuter);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && !(outer?.aborted ?? false)) {
      throw new ImageGenTimeoutError(
        `Image-gen ${operation} timed out after ${Math.floor(ms / 1000)}s`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forwardOuter);
  }
}

/** One generated image — RAW BYTES already downloaded server-side (the
 *  cloud-URL-expiry rule: adapters never hand remote URLs upward, the
 *  server-side byte download happens inside the adapter). */
export interface ImageGenGeneratedImage {
  /** Decoded image bytes. */
  data: Buffer;
  /** MIME type ("image/png", "image/jpeg", ...) as reported by the backend
   *  or derived from the data-URL prefix. */
  mimeType: string;
}

export interface ImageGenGenerateResult {
  /** The generated image(s) in request order. v1 requests never send a
   *  count — every protocol defaults to exactly one server-side — but the
   *  array shape keeps multi-image vendors usable in later batches. */
  images: ImageGenGeneratedImage[];
  /** The seed the backend actually used, when reported (A1111 resolves -1
   *  and returns the concrete value; cloud vendors typically omit). */
  seed?: number;
  /** Actual output size when the backend reports or decides it (cloud
   *  vendors snap requested sizes onto their fixed grid). */
  width?: number;
  height?: number;
  /** Workflow template the backend resolved for the generation (CG-A2):
   *  ComfyUI reports "checkpoint" | "krea2-dit" — the slot provenance
   *  records it (model auto-detect is adapter-side knowledge). Other
   *  backends omit. */
  resolvedTemplate?: string;
}

/** Probe outcome — normalized like STT's: failures are reported as
 *  `{ ok: false, detail }`, never thrown across the boundary. `status`
 *  carries the upstream HTTP status when the failure came from a non-2xx
 *  response. */
export interface ImageGenProbeResult {
  ok: boolean;
  detail?: string;
  status?: number;
}

/** One entry of a live model catalog: OpenRouter-style `/models` payloads
 *  carry aggregator enrichment (`isFree`, `description`); A1111
 *  `sd-models` maps `model_name`/`title`; plain OpenAI-images servers
 *  simply omit the extras. */
export interface ImageGenModelInfo {
  id: string;
  label: string;
  isFree?: boolean;
  description?: string;
  /** Model-family label (CG-A3, comfyui dialect): resolved through the
   *  metadata ladder (embedded safetensors metadata → `.cm-info.json` →
   *  `.civitai.info`), normalized to a canonical bucket when recognized
   *  and passed through verbatim otherwise. Absent = unresolved — the
   *  picker renders its "unknown family" bucket. Other backends omit. */
  family?: string;
  /** Workflow template the adapter resolves for this model (CG-A2/A3,
   *  comfyui dialect): "checkpoint" | "krea2-dit" — which loader folder
   *  owns the file. Other backends omit. */
  template?: string;
}

/** One sampler entry (A1111-compat `GET /sdapi/v1/samplers` shape:
 *  `{name, aliases, options}`). */
export interface ImageGenSamplerInfo {
  name: string;
  aliases?: string[];
}

/** One scheduler entry (A1111-compat `GET /sdapi/v1/schedulers` shape:
 *  `{name, label, aliases, options}` — PG-3; `label` is the display name
 *  when the server provides one). */
export interface ImageGenSchedulerInfo {
  name: string;
  label?: string;
}

/** DiT sidecar file lists (CG-B1, comfyui dialect): the live text-encoder
 *  and VAE folder catalogs for the advanced accordion's DiT fields. */
export interface ImageGenDitSidecars {
  encoders: string[];
  vaes: string[];
}

/** One LoRA list entry (CG-C2) — `family` NULL = the ladder found nothing
 *  (the chip's «Неизвестно» bucket), never a guessed family. */
export interface ImageGenLoraInfo {
  name: string;
  family: string | null;
}

/** Live progress (A1111-compat `GET /sdapi/v1/progress`): `progress` is
 *  0..1; `previewBase64` is the interim preview image when the server
 *  produces one. */
export interface ImageGenProgressInfo {
  progress: number;
  etaRelative?: number;
  state?: string;
  previewBase64?: string;
}

export type ImageGenBackendFactory = (config: ImageGenAdapterConfig) => ImageGenBackend;

export interface ImageGenBackend {
  /** Verify the endpoint/credential is accepted (probe-only validation —
   *  the owner rejected a test-generate button). */
  probe(signal?: AbortSignal): Promise<ImageGenProbeResult>;
  /** Live model discovery for the picker (cached at the profile by the
   *  route layer). */
  listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]>;
  /** Sampler listing — capability-gated (A1111-compat only in v1). */
  listSamplers?(signal?: AbortSignal): Promise<ImageGenSamplerInfo[]>;
  /** Scheduler (schedule type) listing — A1111-dialect only in v1 (PG-3;
   *  the extensions-arm dialect gate, not a capability flag: schedulers are
   *  an A1111-compat surface, not a cross-vendor capability). */
  listSchedulers?(signal?: AbortSignal): Promise<ImageGenSchedulerInfo[]>;
  /** DiT sidecar listing (comfyui dialect only, CG-B1) — the live
   *  text-encoder + VAE folder catalogs for the DiT advanced fields
   *  (the schedulers dialect-gate twin, not a capability flag). */
  listDitSidecars?(signal?: AbortSignal): Promise<ImageGenDitSidecars>;
  /** LoRA listing (capability-gated: ComfyUI CG-C2, A1111 with FT-A4) —
   *  names + family (null = the «Неизвестно» bucket) feeding the chip's
   *  family-filtered picker. */
  listLoras?(signal?: AbortSignal): Promise<ImageGenLoraInfo[]>;
  /** Server-extension listing (A1111-compat only in v1) — extension dir
   *  names for feature detection (IG-CF15/PG-4: the ADetailer probe). */
  listExtensions?(signal?: AbortSignal): Promise<string[]>;
  /** Generate one image request per the v1 mode recipe. Downloads bytes
   *  server-side before resolving. */
  generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult>;
  /** Local live progress polling (A1111 REST; comfyui reads the WS-fed
   *  run snapshot — CG-C1). */
  progress?(signal?: AbortSignal): Promise<ImageGenProgressInfo>;
  /** Ask the local instance to cancel its current job (A1111-compat
   *  `POST /sdapi/v1/interrupt`; comfyui `POST /interrupt` — CG-C1).
   *  Resolves on acceptance — completion is observed through the progress
   *  endpoint / the aborted request. */
  interrupt?(signal?: AbortSignal): Promise<void>;
  /** Release any held resources. Idempotent-safe. */
  dispose(): Promise<void>;
}

/** Capability flags alias — the static map the registry publishes is typed
 *  by the domain shape (a snapshot of these is persisted onto profiles). */
export type { ImageGenCapabilityFlags } from "@vibe-tavern/domain";
