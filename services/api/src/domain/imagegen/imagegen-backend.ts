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

import type { ImageGenCapabilityFlags } from "@vibe-tavern/domain";

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
  /** Transport injection seam — the fetch function every HTTP call goes
   *  through (generation POST, model list, server-side byte download of
   *  returned images). Defaults to the global fetch. Tests inject a double
   *  through this field (tier T1 — no globalThis patching), and the route
   *  layer can hand adapters the proxy-aware provider fetch — the same
   *  seam the LLM providers use. */
  fetch?: typeof fetch;
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
  seed?: number;
  clipSkip?: number;
  /** Cooperative cancellation — adapters forward it to their HTTP calls.
   *  No default timeout ships in code (the owner's constants batch is
   *  pending approval); routes inject signals once approved. */
  signal?: AbortSignal;
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
}

/** One sampler entry (A1111-compat `GET /sdapi/v1/samplers` shape:
 *  `{name, aliases, options}`). */
export interface ImageGenSamplerInfo {
  name: string;
  aliases?: string[];
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
  /** Generate one image request per the v1 mode recipe. Downloads bytes
   *  server-side before resolving. */
  generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult>;
  /** Local live progress polling (A1111-compat only in v1). */
  progress?(signal?: AbortSignal): Promise<ImageGenProgressInfo>;
  /** Release any held resources. Idempotent-safe. */
  dispose(): Promise<void>;
}

/** Capability flags alias — the static map the registry publishes is typed
 *  by the domain shape (a snapshot of these is persisted onto profiles). */
export type { ImageGenCapabilityFlags } from "@vibe-tavern/domain";
