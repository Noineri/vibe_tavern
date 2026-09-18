/**
 * @module imagegen/backends/comfyui
 *
 * ComfyUI local backend adapter (COMFYUI_BACKEND_PLAN CG-A1) — the raw
 * HTTP API surface (`/prompt`, `/history`, `/view`), NOT the node-canvas
 * UX. One adapter covers ComfyUI proper (any launcher: Stability Matrix,
 * portable, git, comfy-cli — vanilla ComfyUI core has no auth and no
 * model-downloader state we depend on) because the wire surface is
 * version-stable across them.
 *
 * FLAT-FORM MAPPING (the plan's non-negotiable): the workflow JSON is an
 * implementation detail the adapter maps VT's flat generation fields onto.
 * v1 carries TWO templates (CG-A2): the CHECKPOINT template
 * (`CheckpointLoaderSimple → CLIPTextEncode×2 → KSampler → VAEDecode →
 * SaveImage`, plus `CLIPSetLastLayer` when clipSkip is set) and the KREA-2
 * DiT template (`UNETLoader + CLIPLoader{type:"krea2"} + VAELoader` — the
 * bare-DiT shape local setups use for Krea 2 finetunes). The template is
 * SELECTED BY MODEL AUTO-DETECT: whichever loader folder owns the resolved
 * model id (`/object_info/CheckpointLoaderSimple.ckpt_name` ∪
 * `/object_info/UNETLoader.unet_name` — the exact combo lists ComfyUI's own
 * queue validation checks against). Live sampler/model UNIONS in pickers
 * land in CG-A3; WS progress in CG-C1.
 *
 * Doc gate (every wire fact below live-verified on the owner's ComfyUI
 * 0.36.0 / Stability Matrix instance, 2026-09-18 — probe scripts in
 * reports/IMAGEGEN_POLISH_REPORT.md § PG-5):
 * - generation: `POST /prompt` with `{prompt: <workflow graph>, client_id}`
 *   → `{prompt_id, number, node_errors}`. A NON-EMPTY `node_errors` object
 *   means the graph was rejected (bad ckpt_name etc.) — surfaced as a
 *   caller-class error (status 400 on the adapter error): the request
 *   content is wrong, not the gateway.
 * - completion: `GET /history/{prompt_id}` — the response is a map keyed
 *   by prompt id; an absent key = still queued/running. Terminal success:
 *   `status.completed === true` with `outputs[nodeId].images[]` entries
 *   `{filename, subfolder, type}`. Terminal failure: `status.status_str
 *   === "error"` with the readable reason inside `status.messages[]` as
 *   the `execution_error` pair's `exception_message`.
 * - download: `GET /view?filename=&subfolder=&type=output` → raw image
 *   bytes (SaveImage emits PNG; MIME sniffs as a fallback).
 * - model list: `GET /models/checkpoints` + `GET /models/diffusion_models`
 *   → the UNION the picker serves (CG-A3): checkpoints first, then DiT
 *   models, each entry carrying its `template` marker. Ids keep the
 *   server's path VERBATIM (subfolder entries ride the server's own
 *   separator — the round-trip back into `ckpt_name`/`unet_name` must be
 *   byte-identical).
 * - model FAMILY (CG-A3): three metadata stores, first hit wins, every
 *   store degrading silently (a failed store never fails the list): (1)
 *   metadata EMBEDDED in the safetensors header via `GET
 *   /view_metadata/{folder}?filename=` (`ss_base_model_version` /
 *   `modelspec.architecture` — trainer truth, install-agnostic); (2)
 *   `.cm-info.json` sidecars (Stability Matrix, top-level `BaseModel`);
 *   (3) `.civitai.info` sidecars (the civitai download flow, top-level
 *   `baseModel`). Sidecar paths join against `GET
 *   /internal/folder_paths` (ComfyUI's own folder map — root lists per
 *   folder; on a remote host the paths don't exist locally and resolution
 *   auto-degrades to embedded-only). Raw values normalize through
 *   `normalizeComfyFamily` (canonical ecosystem buckets; unrecognized
 *   values pass through verbatim — the honest labeled bucket).
 * - sampler/scheduler lists (CG-A3): the `KSampler` node's own combo enums
 *   (`/object_info/KSampler` → `input.required.sampler_name[0]` /
 *   `scheduler[0]`) — bare strings, no aliases/labels.
 * - node input lists: `GET /object_info/{node}` → `input.required.{field}`
 *   combo values (the accepted filename enums — used for template
 *   detection). Sidecar folder lists: `GET /models/text_encoders` and
 *   `GET /models/vae` (CLIPLoader reads the text_encoders folder, NOT
 *   clip — 0.36 live-verified).
 * - KREA-2 ENCODER TYPE (owner's Stability Matrix lesson, 2026-09-18):
 *   `CLIPLoader.type` is HARDCODED to "krea2". The qwen3vl_4b text
 *   encoder runs under the krea2 wrapper for Krea-2 DiT models — a
 *   template defaulting to "qwen_image" (the Qwen-IMAGE model family's
 *   type) silently produces a broken graph, which is exactly the manual
 *   template fix the owner had to make in her launcher. The adapter's
 *   template must be correct standalone, not a mirror of any local fix.
 * - UNETLoader.weight_dtype is REQUIRED on ComfyUI 0.36+ (enum [default,
 *   fp8_e4m3fn, fp8_e4m3fn_fast, fp8_e5m2]) — the DiT graph always sends
 *   the node-class default "default" (the loader's own dtype policy). A
 *   graph omitting it is rejected `required_input_missing` (live-caught
 *   2026-09-18 — mocked transports repeat OUR shape, only a real server
 *   repeats the node's).
 * - probe: `GET /system_stats` → `{system: {comfyui_version, ...},
 *   devices: [...]}` — the cheapest always-present liveness endpoint.
 * - auth: NONE in core — a non-empty apiKey is a configuration mistake
 *   (a proxy-fronted instance is out of v1 scope) and fails closed with
 *   a clear message instead of inventing a header ComfyUI would ignore.
 *
 * Card-driven deviations from the a1111 twin (named, verified):
 * - NO sync generation POST: ComfyUI queues asynchronously, so the adapter
 *   polls `/history` until terminal. The poll cadence is a named internal
 *   constant (NOT a user-facing generation parameter — the owner's ban
 *   covers generation params; completion detection is transport mechanics,
 *   same class as the cloud timeout budget).
 * - NO server-side parameter defaults: a workflow graph must carry values
 *   for every required KSampler/EmptyLatent input, so an unset field
 *   materializes the NODE-CLASS DEFAULT exactly as the server's own
 *   /object_info declares it (steps 20, cfg 8, sampler "euler", scheduler
 *   "normal", latent 512×512, denoise 1 — live-verified constants, the
 *   comfy equivalent of a1111's "omit and the server fills").
 * - seed -1 / unset resolves IN THE ADAPTER (client-side random ≤
 *   MAX_SAFE_INTEGER): ComfyUI has no -1 sentinel. The resolved value is
 *   reported back as `result.seed` — we authored it, so it is exact.
 * - NO keyless-model path: the graph must name its model (checkpoint or
 *   diffusion model); with neither request model nor profile model the
 *   adapter fails closed (a1111's "server's loaded checkpoint" has no
 *   ComfyUI equivalent — there is no loaded-model state). A model found in
 *   NEITHER loader folder fails closed with the model named (stale
 *   profile selection, deleted file).
 * - DiT SIDECAR RESOLUTION (CG-A2): the Krea-2 template needs a text
 *   encoder and a VAE the checkpoint template gets for free. Explicit
 *   request values ride VERBATIM (server validates); unset resolves
 *   against the live folder list — the canonical Krea-2 ecosystem file
 *   (`qwen3vl_4b_fp8_scaled.*` / `qwen_image_vae.*`, extension-flexible),
 *   else the folder's SINGLE entry when only one exists, else a config
 *   error naming the candidates (never a silent guess among many — the
 *   owner's "don't lean on my local data" rule: canonical names are the
 *   ecosystem spec, not a mirror of one install).
 * - NO local timeout: the run continues until terminal state or the
 *   caller's abort (the localExecution contract; the poll delay is
 *   abortable so cancellation is prompt).
 * - clipSkip rides `CLIPSetLastLayer.stop_at_clip_layer = -clipSkip`
 *   (ComfyUI counts from the end; the node is OMITTED when clipSkip is
 *   unset — no silent layer-slicing).
 * - v1 ignores (no VT field maps yet): denoise stays the node default 1
 *   (txt2img), batch_size 1, `preview_method`, and the WS preview BINARY
 *   frames (live latent thumbs = the documented fast-follow; the step
 *   events themselves are mapped, CG-C1).
 * - krea2 FORM DEFAULTS stay FORM-side (CF5, owner decision): a bare API
 *   request with unset steps/cfg gets the NODE-CLASS defaults (20/8/…)
 *   for BOTH templates — the Krea-2 family's sane starting point
 *   (steps 8, cfg 1, euler/simple) ships as EXPLICIT form values in
 *   CG-B1, never as a hidden server-side second default ladder.
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGeneratedImage,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenDitSidecars,
  ImageGenModelInfo,
  ImageGenProbeResult,
  ImageGenProgressInfo,
  ImageGenSamplerInfo,
  ImageGenSchedulerInfo,
  ImageGenWebSocketLike,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

/** HTTP / transport / execution failure of a generation or listing request. */
export class ComfyImageGenError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures and graph rejections). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "ComfyImageGenError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint, or a key on a keyless backend). */
export class ComfyImageGenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyImageGenConfigError";
  }
}

/** A width/height that is not a positive integer — the free-size fail
 *  closed error (the a1111 twin). */
export class ComfyImageGenSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyImageGenSizeError";
  }
}

// ─── Workflow templates (checkpoint CG-A1 + Krea-2 DiT CG-A2) ───────

/** Stable node ids — part of the template contract the tests pin (the
 *  /history outputs are keyed by the SaveImage node id). Both templates
 *  share the sampler half (3,5,6,7,8,9,10); the loader half differs —
 *  checkpoint node 4 vs DiT nodes 11/12/13. */
export const COMFY_NODE_IDS = {
  kSampler: "3",
  checkpoint: "4",
  latent: "5",
  positive: "6",
  negative: "7",
  vaeDecode: "8",
  saveImage: "9",
  clipSetLastLayer: "10",
  unet: "11",
  clip: "12",
  vae: "13",
} as const;

/** The workflow graph the flat request maps onto: a record of node id →
 *  `{class_type, inputs}` — the exact `prompt` value POSTed to `/prompt`. */
export type ComfyWorkflowGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** `CLIPLoader.type` for the Krea-2 DiT template — HARDCODED (the owner's
 *  SM lesson, 2026-09-18: a qwen3vl_4b encoder under the "qwen_image"
 *  type is a silently-broken graph — the manual fix her launcher template
 *  needed; the adapter's template is correct standalone). */
export const COMFY_KREA2_CLIP_TYPE = "krea2";

/** Canonical Krea-2 ecosystem sidecar basenames for UNSET request fields
 *  (extension-flexible at resolution — the ecosystem spec, not any one
 *  install's filenames). */
export const COMFY_KREA2_DEFAULT_ENCODER = "qwen3vl_4b_fp8_scaled";
export const COMFY_KREA2_DEFAULT_VAE = "qwen_image_vae";

/** The two workflow-template ids the adapter resolves — the marker each
 *  model-picker entry carries (CG-A3) and the value recorded in the slot
 *  provenance `params.template` (CG-A2). */
export const COMFY_MODEL_TEMPLATES = {
  checkpoint: "checkpoint",
  krea2Dit: "krea2-dit",
} as const;

/** Resolved loader inputs of the Krea-2 DiT template. */
export interface ComfyKrea2Sidecars {
  /** `UNETLoader.unet_name` — the resolved model id itself. */
  unet: string;
  /** `CLIPLoader.clip_name` — the text-encoder file. */
  encoder: string;
  /** `VAELoader.vae_name`. */
  vae: string;
}

/** Node-class defaults for the graph inputs VT leaves unset — verbatim
 *  from the live /object_info KSampler/EmptyLatentImage declarations
 *  (0.36.0, research-pinned). These are the SERVER's own defaults
 *  materialized client-side because a workflow graph cannot omit a
 *  required input — the comfy equivalent of a1111's omit-and-server-fills. */
export const COMFY_NODE_DEFAULTS = {
  steps: 20,
  cfg: 8,
  samplerName: "euler",
  scheduler: "normal",
  latentWidth: 512,
  latentHeight: 512,
  denoise: 1,
  batchSize: 1,
  filenamePrefix: "vt_imagegen",
  /** UNETLoader.weight_dtype — a REQUIRED input on ComfyUI 0.36+ (live
   *  2026-09-18: enum [default, fp8_e4m3fn, fp8_e4m3fn_fast, fp8_e5m2]);
   *  "default" = the loader's own dtype policy (int8 files stay int8,
   *  bf16 stay bf16 — no forced cast). The DiT graph MUST carry it or the
   *  server rejects the prompt with `required_input_missing` (the defect
   *  the owner's live portrait test caught, 2026-09-18). */
  unetWeightDtype: "default",
} as const;

/** The SaveImage node's output-rows container (top-level node outputs ride
 *  the history entry keyed by node id). */
interface ComfyHistoryOutputImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** Validate a free W×H integer (positive, finite, integral). */
function requirePositiveInt(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ComfyImageGenSizeError(
      `ComfyUI image generation accepts a positive integer ${name} — got ${value}`,
    );
  }
  return value;
}

/** A set string field: trimmed and non-empty, else undefined. */
function setOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve the graph seed: unset or the -1 "random" sentinel becomes a
 *  client-side random (ComfyUI has no server sentinel; the resolved value
 *  is returned so the caller can report it as the exact used seed). */
function resolveComfySeed(seed: number | undefined): number {
  if (seed !== undefined && seed !== -1) return seed;
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/** Build the SAMPLER HALF both templates share (KSampler, EmptyLatent,
 *  text encoders, VAEDecode, SaveImage, optional CLIPSetLastLayer) —
 *  parameterized by the loader-half output refs the template provides:
 *  the MODEL output feeding KSampler and the CLIP output feeding the
 *  text encoders. The VAEDecode.vae ref starts as a placeholder the two
 *  wrappers overwrite (checkpoint: its bundled third output; DiT: the
 *  separate VAELoader). Pure. */
function buildComfyCommonNodes(
  request: ImageGenGenerateRequest,
  refs: { model: [string, number]; clip: [string, number] },
): { graph: ComfyWorkflowGraph; seed: number } {
  const seed = resolveComfySeed(request.seed);
  const width = request.width !== undefined ? requirePositiveInt("width", request.width) : undefined;
  const height = request.height !== undefined ? requirePositiveInt("height", request.height) : undefined;
  const clipSkip = request.clipSkip;

  // The clip source of the two text encoders: the loader output directly,
  // or through CLIPSetLastLayer when the request slices layers.
  const clipSource: [string, number] =
    clipSkip !== undefined ? [COMFY_NODE_IDS.clipSetLastLayer, 0] : refs.clip;

  const graph: ComfyWorkflowGraph = {
    [COMFY_NODE_IDS.kSampler]: {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: request.steps ?? COMFY_NODE_DEFAULTS.steps,
        cfg: request.cfgScale ?? COMFY_NODE_DEFAULTS.cfg,
        sampler_name: setOrUndefined(request.sampler) ?? COMFY_NODE_DEFAULTS.samplerName,
        scheduler: setOrUndefined(request.scheduler) ?? COMFY_NODE_DEFAULTS.scheduler,
        denoise: COMFY_NODE_DEFAULTS.denoise,
        model: refs.model,
        positive: [COMFY_NODE_IDS.positive, 0],
        negative: [COMFY_NODE_IDS.negative, 0],
        latent_image: [COMFY_NODE_IDS.latent, 0],
      },
    },
    [COMFY_NODE_IDS.latent]: {
      class_type: "EmptyLatentImage",
      inputs: {
        width: width ?? COMFY_NODE_DEFAULTS.latentWidth,
        height: height ?? COMFY_NODE_DEFAULTS.latentHeight,
        batch_size: COMFY_NODE_DEFAULTS.batchSize,
      },
    },
    [COMFY_NODE_IDS.positive]: {
      class_type: "CLIPTextEncode",
      inputs: { text: request.prompt, clip: clipSource },
    },
    [COMFY_NODE_IDS.negative]: {
      class_type: "CLIPTextEncode",
      inputs: { text: request.negativePrompt ?? "", clip: clipSource },
    },
    [COMFY_NODE_IDS.vaeDecode]: {
      class_type: "VAEDecode",
      inputs: { samples: [COMFY_NODE_IDS.kSampler, 0], vae: ["", 0] },
    },
    [COMFY_NODE_IDS.saveImage]: {
      class_type: "SaveImage",
      inputs: { filename_prefix: COMFY_NODE_DEFAULTS.filenamePrefix, images: [COMFY_NODE_IDS.vaeDecode, 0] },
    },
  };
  if (clipSkip !== undefined) {
    graph[COMFY_NODE_IDS.clipSetLastLayer] = {
      class_type: "CLIPSetLastLayer",
      // ComfyUI counts from the end: clipSkip 2 (skip one layer) → -2;
      // clipSkip 1 → -1 = the node's own no-skip default.
      inputs: { stop_at_clip_layer: -clipSkip, clip: refs.clip },
    };
  }
  return { graph, seed };
}

/** Build the CHECKPOINT-template workflow graph from the flat request +
 *  the resolved profile model. Pure — exported for the wire tests. The
 *  second return value is the seed actually placed in the graph. */
export function buildComfyCheckpointWorkflow(
  request: ImageGenGenerateRequest,
  resolvedModel: string,
): { graph: ComfyWorkflowGraph; seed: number } {
  const { graph, seed } = buildComfyCommonNodes(request, {
    model: [COMFY_NODE_IDS.checkpoint, 0],
    clip: [COMFY_NODE_IDS.checkpoint, 1],
  });
  graph[COMFY_NODE_IDS.checkpoint] = {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: resolvedModel },
  };
  // The checkpoint's own third output is its bundled VAE.
  graph[COMFY_NODE_IDS.vaeDecode]!.inputs.vae = [COMFY_NODE_IDS.checkpoint, 2];
  return { graph, seed };
}

/** Build the KREA-2 DiT-template workflow graph (CG-A2): a bare diffusion
 *  model loads through UNETLoader, and the text encoder + VAE come from
 *  SEPARATE loaders (a DiT file bundles neither). `CLIPLoader.type` is the
 *  hardcoded "krea2" — see COMFY_KREA2_CLIP_TYPE. Pure — exported for the
 *  wire tests. */
export function buildComfyKrea2Workflow(
  request: ImageGenGenerateRequest,
  sidecars: ComfyKrea2Sidecars,
): { graph: ComfyWorkflowGraph; seed: number } {
  const { graph, seed } = buildComfyCommonNodes(request, {
    model: [COMFY_NODE_IDS.unet, 0],
    clip: [COMFY_NODE_IDS.clip, 0],
  });
  graph[COMFY_NODE_IDS.unet] = {
    class_type: "UNETLoader",
    inputs: { unet_name: sidecars.unet, weight_dtype: COMFY_NODE_DEFAULTS.unetWeightDtype },
  };
  graph[COMFY_NODE_IDS.clip] = {
    class_type: "CLIPLoader",
    inputs: { clip_name: sidecars.encoder, type: COMFY_KREA2_CLIP_TYPE },
  };
  graph[COMFY_NODE_IDS.vae] = {
    class_type: "VAELoader",
    inputs: { vae_name: sidecars.vae },
  };
  graph[COMFY_NODE_IDS.vaeDecode]!.inputs.vae = [COMFY_NODE_IDS.vae, 0];
  return { graph, seed };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a pasted base URL: trailing slashes and a pasted `…/prompt`
 *  generation path are tolerated (the paste-tolerance discipline). */
function normalizeComfyBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/prompt")) {
    normalized = normalized.slice(0, -"/prompt".length);
  }
  return normalized.replace(/\/+$/, "");
}

/** Sniff the MIME type from image bytes by format signature (png / jpeg /
 *  webp) — /view serves without a reliable Content-Type; PNG is the
 *  SaveImage default and the fallback. */
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

/** Await a fetch call through the injected seam. Transport-level failures
 *  wrap into the adapter's typed error — EXCEPT the caller's own abort,
 *  which is rethrown untouched (the abort contract of the a1111 twin). */
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
    throw new ComfyImageGenError(
      `ComfyUI image-gen ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** The completion-poll cadence — transport mechanics, not a generation
 *  parameter (see the module doc gate). */
export const COMFY_HISTORY_POLL_INTERVAL_MS = 250;

/** An abort-aware delay between history polls: the caller's cancel exits
 *  the wait promptly with the raw AbortError (user cancel, not a failure). */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/** One `/history/{id}` poll response classified: pending (keep polling),
 *  done (the SaveImage output rows), or failed (the execution_error
 *  message). */
type ComfyPollOutcome =
  | { kind: "pending" }
  | { kind: "done"; images: ComfyHistoryOutputImage[] }
  | { kind: "failed"; message: string };

/** Extract the readable failure reason from a terminal error entry: the
 *  `status.messages` array of `[type, payload]` pairs carries the
 *  `execution_error` payload with `exception_message` (+ node_type /
 *  node_id for locating it). Anything unreadable degrades to the status
 *  string, never an invented message. */
function classifyHistoryEntry(entry: unknown): ComfyPollOutcome {
  if (typeof entry !== "object" || entry === null) return { kind: "pending" };
  const record = entry as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "object" || status === null) return { kind: "pending" };
  const statusRecord = status as Record<string, unknown>;
  if (statusRecord.status_str === "error") {
    let message = "ComfyUI execution error";
    const messages = statusRecord.messages;
    if (Array.isArray(messages)) {
      for (const pair of messages) {
        if (!Array.isArray(pair) || pair[0] !== "execution_error") continue;
        const payload = pair[1];
        if (typeof payload !== "object" || payload === null) continue;
        const detail = payload as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof detail.node_type === "string" && detail.node_type.length > 0) parts.push(detail.node_type);
        if (typeof detail.exception_message === "string" && detail.exception_message.length > 0) {
          parts.push(detail.exception_message);
        }
        if (parts.length > 0) {
          message = `ComfyUI execution error: ${parts.join(": ")}`;
          break;
        }
      }
    }
    return { kind: "failed", message };
  }
  if (statusRecord.completed !== true) return { kind: "pending" };
  const outputs = record.outputs;
  if (typeof outputs !== "object" || outputs === null) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the history entry carries no outputs" };
  }
  const nodeOutput = (outputs as Record<string, unknown>)[COMFY_NODE_IDS.saveImage];
  if (typeof nodeOutput !== "object" || nodeOutput === null) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the SaveImage node produced no output" };
  }
  const images = (nodeOutput as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length === 0) {
    return { kind: "failed", message: "ComfyUI completed the prompt with no saved images" };
  }
  const rows: ComfyHistoryOutputImage[] = [];
  for (const image of images) {
    if (typeof image !== "object" || image === null) continue;
    const row = image as Record<string, unknown>;
    if (typeof row.filename !== "string" || row.filename.length === 0) continue;
    rows.push({
      filename: row.filename,
      ...(typeof row.subfolder === "string" && row.subfolder.length > 0 ? { subfolder: row.subfolder } : {}),
      ...(typeof row.type === "string" && row.type.length > 0 ? { type: row.type } : {}),
    });
  }
  if (rows.length === 0) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the saved-image rows are malformed" };
  }
  return { kind: "done", images: rows };
}

/** Await prompt completion by polling `/history/{id}` until terminal —
 *  abortable, no timeout (the localExecution contract). */
async function waitForPromptCompletion(
  transport: typeof fetch,
  endpoint: string,
  promptId: string,
  signal: AbortSignal | undefined,
): Promise<ComfyHistoryOutputImage[]> {
  for (;;) {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/history/${encodeURIComponent(promptId)}`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "history poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new ComfyImageGenError(
        `ComfyUI history poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const parsed: unknown = await response.json().catch(() => null);
    const entry = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)[promptId]
      : undefined;
    const outcome = classifyHistoryEntry(entry);
    if (outcome.kind === "done") return outcome.images;
    if (outcome.kind === "failed") throw new ComfyImageGenError(outcome.message);
    await abortableDelay(COMFY_HISTORY_POLL_INTERVAL_MS, signal);
  }
}

// ─── WS live progress (CG-C1) ────────────────────────────────────────────────

/** One run's live-progress snapshot — what `progress()` publishes. */
interface ComfyRunSnapshot {
  promptId: string;
  progress: number;
  state?: string;
}

/** Run snapshots keyed by ENDPOINT, module-level on purpose: every adapter
 *  method call runs on a FRESH backend instance, so the run's generate()
 *  must leave its state where the next poll's instance can read it (the
 *  a1111 twin gets the same for free from the server's own global
 *  /sdapi/v1/progress). One entry per endpoint, overwritten per run: a
 *  local ComfyUI executes one prompt at a time on the GPU and VT drives one
 *  generation at a time (the PG-2 poll-only-while-our-run contract). */
const comfyRunSnapshots = new Map<string, ComfyRunSnapshot>();

/** Handle to a run's WS listener. */
interface ComfyProgressListener {
  /** Bind the queue response's prompt id and replay buffered events — the
   *  socket opens BEFORE the prompt is queued, so early events can arrive
   *  pre-bind. */
  bindPromptId(promptId: string): void;
  /** Stop listening and close the socket (idempotent). */
  close(): void;
}

/** The default socket opener — the global WebSocket (Bun's does NOT read
 *  env proxies, so a localhost socket is always direct; correct here).
 *  Cast: the global satisfies the seam structurally, but its overloaded
 *  close() and `this`-typed handlers don't line up with the narrow
 *  interface for the checker — one documented boundary cast. */
const defaultOpenWebSocket = (url: string): ImageGenWebSocketLike =>
  new WebSocket(url) as unknown as ImageGenWebSocketLike;

/** http(s) endpoint → ws(s) socket URL with the run's client id. */
function comfyWsUrl(endpoint: string, clientId: string): string {
  const wsBase = endpoint.replace(/^http/, "ws");
  return `${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`;
}

/** Open the run's WS listener. Best-effort by design (the A3 family-ladder
 *  degradation precedent): a socket that fails to open NEVER fails the
 *  generation — the run simply publishes no progress. */
function openComfyProgressListener(
  endpoint: string,
  clientId: string,
  openWebSocket: (url: string) => ImageGenWebSocketLike,
): ComfyProgressListener {
  let promptId: string | undefined;
  const buffer: string[] = [];
  let dead = false;

  const applyEvent = (payload: unknown): void => {
    if (dead || !isRecord(payload)) return;
    const data = payload.data;
    const dataRecord = isRecord(data) ? data : undefined;
    // ComfyUI broadcasts execution events to EVERY connected socket — only
    // this run's prompt_id counts (the cross-prompt filter).
    if (promptId === undefined || dataRecord === undefined || dataRecord.prompt_id !== promptId) return;
    if (payload.type === "progress") {
      const value = typeof dataRecord.value === "number" && Number.isFinite(dataRecord.value) ? dataRecord.value : 0;
      const max = typeof dataRecord.max === "number" && dataRecord.max > 0 ? dataRecord.max : 0;
      if (max > 0) {
        const fraction = Math.min(Math.max(value / max, 0), 1);
        comfyRunSnapshots.set(endpoint, { promptId, progress: fraction, state: `step ${value}/${max}` });
      }
      return;
    }
    // `executing` with node === null and `execution_success` both mean the
    // prompt finished executing — the bar's 100%. (execution_error is left
    // alone: the failure surfaces through generate()'s own history
    // classification; the snapshot is informational.)
    if ((payload.type === "executing" && dataRecord.node === null) || payload.type === "execution_success") {
      comfyRunSnapshots.set(endpoint, { promptId, progress: 1 });
    }
  };

  const ingest = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // a malformed frame never breaks the run's progress feed
    }
    applyEvent(parsed);
  };

  let socket: ImageGenWebSocketLike;
  try {
    socket = openWebSocket(comfyWsUrl(endpoint, clientId));
  } catch {
    // Unopenable socket → a dead listener; the run degrades silently.
    return { bindPromptId() {}, close() {} };
  }
  socket.onmessage = (event) => {
    // Binary frames are live latent previews — ignored in v1 (documented
    // fast-follow; the step events are TEXT frames).
    if (dead || typeof event.data !== "string") return;
    if (promptId === undefined) {
      buffer.push(event.data);
      return;
    }
    ingest(event.data);
  };
  socket.onclose = () => {
    dead = true;
  };
  socket.onerror = () => {
    dead = true;
  };

  return {
    bindPromptId(id: string): void {
      if (dead || promptId !== undefined) return;
      promptId = id;
      for (const raw of buffer.splice(0)) ingest(raw);
    },
    close(): void {
      if (dead) return;
      dead = true;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // The socket is already gone — nothing to release.
      }
    },
  };
}

/** `unknown` → record guard for the defensive /object_info walks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Basename without the weights extension — the label/canonical-match key
 *  (a DiT “all-in-one” file bundles both halves). */
function weightsBasename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
}

/** GET /object_info/{node} → the combo values of a required input — the
 *  accepted filename enum ComfyUI's own queue validation checks against
 *  (template detection's ground truth, live-verified 0.36.0). CG-A3: the
 *  same walk serves `KSampler.sampler_name` / `KSampler.scheduler` for
 *  the live sampler/scheduler lists. */
async function fetchComfyComboValues(
  transport: typeof fetch,
  endpoint: string,
  nodeName: string,
  inputName: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/object_info/${encodeURIComponent(nodeName)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "node input list",
  );
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ComfyImageGenError(
      `ComfyUI node input list for ${nodeName} failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  const node = isRecord(parsed) ? parsed[nodeName] : undefined;
  const input = isRecord(node) ? node.input : undefined;
  const required = isRecord(input) ? input.required : undefined;
  const slot = isRecord(required) ? required[inputName] : undefined;
  const values = Array.isArray(slot) ? slot[0] : undefined;
  if (!Array.isArray(values)) {
    throw new ComfyImageGenError(
      `ComfyUI /object_info/${nodeName} returned an unexpected shape (no input.required.${inputName} combo)`,
    );
  }
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** GET /models/{folder} → the verbatim filename list (non-array responses
 *  fail closed — a silently-empty list would make every resolution miss).
 *  CG-A3: serves `checkpoints` and `diffusion_models` for the model union
 *  in addition to the DiT sidecar folders. */
async function fetchComfyFolderNames(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/models/${encodeURIComponent(folder)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "sidecar folder list",
  );
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ComfyImageGenError(
      `ComfyUI ${folder} list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!Array.isArray(parsed)) {
    throw new ComfyImageGenError(`ComfyUI /models/${folder} returned an unexpected shape (not a filename array)`);
  }
  return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Resolve a Krea-2 sidecar file (text encoder / VAE): an EXPLICIT request
 *  value rides verbatim (the server validates it at queue time); an unset
 *  one resolves against the live folder — the canonical Krea-2 ecosystem
 *  basename (extension-flexible), else the folder's single entry, else a
 *  config error naming the candidates. Never a silent guess among many. */
async function resolveKrea2Sidecar(
  transport: typeof fetch,
  endpoint: string,
  options: {
    folder: string;
    explicit: string | undefined;
    canonical: string;
    what: string;
    signal: AbortSignal | undefined;
  },
): Promise<string> {
  const set = setOrUndefined(options.explicit);
  if (set !== undefined) return set;
  const names = await fetchComfyFolderNames(transport, endpoint, options.folder, options.signal);
  const canonical = names.find((name) => weightsBasename(name) === options.canonical);
  if (canonical !== undefined) return canonical;
  if (names.length === 1 && names[0] !== undefined) return names[0];
  const candidates =
    names.length === 0
      ? "the folder is empty"
      : `candidates: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
  throw new ComfyImageGenConfigError(
    `ComfyUI ${options.what} for the Krea-2 template is unresolved: no "${options.canonical}.*" in the ${options.folder} folder (${candidates}) — pick one in the profile's advanced fields`,
  );
}

// ─── Model family ladder (CG-A3) ─────────────────────────────────────

/** Normalize a raw base-model string from any metadata store into a
 *  canonical family label — the picker subtitle and (CG-C2/C3) the LoRA
 *  family-filter match key both sides normalize through, so a model's
 *  "Krea 2" matches a LoRA's "Krea 2" regardless of which store either
 *  side read. Recognized ecosystem buckets map to their display names
 *  (checked lowercase-substring, order matters — krea before qwen, pony
 *  before the SDXL bucket); modelspec architecture stamps map into the
 *  same buckets ("stable-diffusion-xl-v1-base" → SDXL — a merge tool's
 *  spec stamp is architecture-level truth, not ecosystem noise);
 *  anything unrecognized passes through VERBATIM (an honest labeled
 *  bucket, never a wrong guess); empty → undefined. */
export function normalizeComfyFamily(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.includes("krea")) return "Krea 2";
  if (lower.includes("qwen")) return "Qwen Image";
  if (lower.includes("pony")) return "Pony";
  if (lower.includes("illustrious") || lower.includes("noobai")) return "Illustrious";
  if (lower.includes("flux")) return "Flux";
  if (
    lower.includes("sdxl") ||
    lower.includes("sd_xl") ||
    lower.includes("sd xl") ||
    lower.includes("stable-diffusion-xl")
  ) {
    return "SDXL";
  }
  if (
    lower.includes("sd15") ||
    lower.includes("sd 1.5") ||
    lower.includes("sd1.5") ||
    lower.includes("v1-5") ||
    lower.includes("stable-diffusion-v1") ||
    lower.includes("sd-v1")
  ) {
    return "SD 1.5";
  }
  return trimmed;
}

/** Embedded-metadata fields that name a model family, in precedence order:
 *  `ss_base_model_version` (kohya-training convention, LoRAs and finetunes)
 *  and `modelspec.architecture` (AI-Toolkit modelspec convention, DiT
 *  finetunes). The key literally contains a dot. */
const COMFY_EMBEDDED_FAMILY_FIELDS = ["ss_base_model_version", "modelspec.architecture"] as const;

/** Sidecar stores after the embedded metadata misses, in precedence order
 *  (CG-A3, live-verified): `.cm-info.json` (Stability Matrix's store —
 *  top-level `BaseModel`, mirrors civitai plus the user's manual manager
 *  edits) before `.civitai.info` (the civitai download flow's de-facto
 *  standard — top-level `baseModel`). The stem rule on disk: the model
 *  filename minus its weights extension, sitting in the same directory. */
const COMFY_SIDECAR_STORES = [
  { suffix: ".cm-info.json", field: "BaseModel" },
  { suffix: ".civitai.info", field: "baseModel" },
] as const;

/** GET /view_metadata/{folder}?filename={name} → the metadata dict EMBEDDED
 *  in the safetensors header (trainer truth — the ladder's primary source).
 *  ANY failure degrades silently to undefined (the ladder's rule: an
 *  unreadable store must not fail the model list); the caller's abort is
 *  the one exception and propagates. */
async function fetchComfyEmbeddedFamily(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(name)}`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "model metadata",
    );
    if (!response.ok) return undefined;
    parsed = await response.json().catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  for (const field of COMFY_EMBEDDED_FAMILY_FIELDS) {
    const raw = parsed[field];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
}

/** GET /internal/folder_paths → the folder-name → root-paths map ComfyUI
 *  itself resolves (including launcher-shared dirs via
 *  extra_model_paths.yaml). Officially "frontend use only" — it is a BONUS
 *  source for the sidecar join, so any failure (404 on hardened remotes,
 *  transport error, unexpected shape) degrades silently to undefined and
 *  the ladder stays embedded-only (the plan's remote-host rule). */
async function fetchComfyFolderRoots(
  transport: typeof fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, string[]> | undefined> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/internal/folder_paths`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "folder map",
    );
    if (!response.ok) return undefined;
    parsed = await response.json().catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [folder, roots] of Object.entries(parsed)) {
    if (Array.isArray(roots)) {
      const clean = roots.filter((root): root is string => typeof root === "string" && root.length > 0);
      if (clean.length > 0) out[folder] = clean;
    }
  }
  return out;
}

/** Read one sidecar store's family field off the local disk: the model's
 *  directory (subfolder part of the id, separators normalized) joined
 *  against each folder root until the file exists and parses. A miss,
 *  unreadable file, or wrong shape returns undefined — the ladder
 *  continues (a remote ComfyUI's roots simply do not exist locally). */
async function readComfySidecarFamily(
  roots: readonly string[],
  name: string,
  suffix: string,
  field: string,
): Promise<string | undefined> {
  const normalized = name.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const stem = file.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
  if (stem.length === 0) return undefined;
  const relative = `${slash >= 0 ? `${normalized.slice(0, slash)}/` : ""}${stem}${suffix}`;
  for (const root of roots) {
    try {
      const text = await Bun.file(`${root.replace(/[\\/]+$/, "")}/${relative}`).text();
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const raw = parsed[field];
        if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
      }
    } catch {
      // Missing or unparseable sidecar — the ladder's next root/store.
      continue;
    }
  }
  return undefined;
}

/** Resolve one model's family through the full ladder (CG-A3):
 *  embedded safetensors metadata → `.cm-info.json` → `.civitai.info` →
 *  undefined ("unknown family" bucket). Every store degrades silently;
 *  only the caller's abort propagates. `rootsOf` lazily fetches (once per
 *  listing) the folder-roots map and only when the first sidecar lookup is
 *  actually needed — a fully-embedded resolution costs no extra call. */
async function resolveComfyModelFamily(
  transport: typeof fetch,
  endpoint: string,
  options: {
    folder: string;
    name: string;
    signal: AbortSignal | undefined;
    rootsOf: () => Promise<Record<string, string[]> | undefined>;
  },
): Promise<string | undefined> {
  const embedded = normalizeComfyFamily(
    await fetchComfyEmbeddedFamily(transport, endpoint, options.folder, options.name, options.signal),
  );
  if (embedded !== undefined) return embedded;
  const roots = (await options.rootsOf())?.[options.folder] ?? [];
  if (roots.length === 0) return undefined;
  for (const store of COMFY_SIDECAR_STORES) {
    const raw = await readComfySidecarFamily(roots, options.name, store.suffix, store.field);
    const normalized = normalizeComfyFamily(raw);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface ComfyImageGenConfig {
  endpoint: string;
  model: string | undefined;
  fetch: typeof fetch;
  openWebSocket: (url: string) => ImageGenWebSocketLike;
}

function parseConfig(config: ImageGenAdapterConfig): ComfyImageGenConfig {
  const endpoint = normalizeComfyBaseUrl(config.endpoint ?? "");
  if (!endpoint) {
    throw new ComfyImageGenConfigError(
      "ComfyUI image-gen config error: `endpoint` is required (the local server's base URL, e.g. http://127.0.0.1:8188)",
    );
  }
  if (config.apiKey !== undefined && config.apiKey.trim() !== "") {
    throw new ComfyImageGenConfigError(
      "ComfyUI image-gen config error: ComfyUI core has no authentication — clear the API key field",
    );
  }
  return {
    endpoint,
    model: setOrUndefined(config.model),
    fetch: config.fetch ?? fetch,
    openWebSocket: config.openWebSocket ?? defaultOpenWebSocket,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const comfyImageGenFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = setOrUndefined(request.model) ?? cfg.model;
      if (model === undefined) {
        throw new ComfyImageGenConfigError(
          "ComfyUI image generation requires a selected model (the workflow graph names its checkpoint or diffusion model)",
        );
      }
      // Template detection (CG-A2): which loader folder owns the model. The
      // checkpoint combo is checked first (sync checkpoints are the common
      // case — one list fetch); a miss falls through to the diffusion-model
      // combo (Krea-2-class bare DiT files) and its sidecar resolution.
      const checkpointNames = await fetchComfyComboValues(
        cfg.fetch,
        cfg.endpoint,
        "CheckpointLoaderSimple",
        "ckpt_name",
        request.signal,
      );
      let template: "checkpoint" | "krea2-dit";
      let graph: ComfyWorkflowGraph;
      let seed: number;
      if (checkpointNames.includes(model)) {
        ({ graph, seed } = buildComfyCheckpointWorkflow(request, model));
        template = COMFY_MODEL_TEMPLATES.checkpoint;
      } else {
        const unetNames = await fetchComfyComboValues(
          cfg.fetch,
          cfg.endpoint,
          "UNETLoader",
          "unet_name",
          request.signal,
        );
        if (!unetNames.includes(model)) {
          throw new ComfyImageGenConfigError(
            `ComfyUI model "${model}" is in neither the checkpoints nor the diffusion-models folder — reselect it from the model list`,
          );
        }
        const encoder = await resolveKrea2Sidecar(cfg.fetch, cfg.endpoint, {
          folder: "text_encoders",
          explicit: request.encoderName,
          canonical: COMFY_KREA2_DEFAULT_ENCODER,
          what: "text encoder",
          signal: request.signal,
        });
        const vae = await resolveKrea2Sidecar(cfg.fetch, cfg.endpoint, {
          folder: "vae",
          explicit: request.vaeName,
          canonical: COMFY_KREA2_DEFAULT_VAE,
          what: "VAE",
          signal: request.signal,
        });
        ({ graph, seed } = buildComfyKrea2Workflow(request, { unet: model, encoder, vae }));
        template = COMFY_MODEL_TEMPLATES.krea2Dit;
      }

      const clientId = crypto.randomUUID();
      // The WS live-progress listener (CG-C1): opened BEFORE the prompt is
      // queued so no early event is missed, held through execution, closed
      // at run end. Best-effort — its failure never fails the run.
      const listener = openComfyProgressListener(cfg.endpoint, clientId, cfg.openWebSocket);
      let promptId: string;
      let outputImages: ComfyHistoryOutputImage[];
      try {
        const queuedResponse = await fetchOrWrap(
          cfg.fetch,
          `${cfg.endpoint}/prompt`,
          {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: graph, client_id: clientId }),
            signal: request.signal,
          },
          "generation queue",
        );
        if (!queuedResponse.ok) {
          const excerpt = await readProviderErrorBody(queuedResponse);
          throw new ComfyImageGenError(
            `ComfyUI prompt queue failed with HTTP ${queuedResponse.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: queuedResponse.status },
          );
        }
        const queued: unknown = await queuedResponse.json().catch(() => null);
        const queuedRecord = typeof queued === "object" && queued !== null ? queued as Record<string, unknown> : {};
        const queuedPromptId = queuedRecord.prompt_id;
        if (typeof queuedPromptId !== "string" || queuedPromptId.length === 0) {
          throw new ComfyImageGenError("ComfyUI prompt queue response carried no prompt_id");
        }
        promptId = queuedPromptId;
        // A non-empty node_errors = the server rejected the graph (unknown
        // checkpoint name, wrong input types) — caller-class, mapped to the
        // 400 rung of the route ladder.
        const nodeErrors = queuedRecord.node_errors;
        if (typeof nodeErrors === "object" && nodeErrors !== null && Object.keys(nodeErrors).length > 0) {
          const details: string[] = [];
          for (const [nodeId, error] of Object.entries(nodeErrors as Record<string, unknown>)) {
            if (typeof error === "object" && error !== null) {
              const detail = error as Record<string, unknown>;
              const message = typeof detail.errors === "object" && Array.isArray(detail.errors)
                ? detail.errors.length
                : undefined;
              details.push(`node ${nodeId}${message !== undefined ? ` (${message} errors)` : ""}`);
            } else {
              details.push(`node ${nodeId}`);
            }
          }
          throw new ComfyImageGenError(
            `ComfyUI rejected the workflow graph${details.length > 0 ? `: ${details.join(", ")}` : ""}`,
            { status: 400 },
          );
        }

        listener.bindPromptId(promptId);
        outputImages = await waitForPromptCompletion(cfg.fetch, cfg.endpoint, promptId, request.signal);
      } finally {
        listener.close();
      }
      // History completion is the authoritative terminal signal — stamp the
      // bar's 100% even when the socket's own terminal event lagged or the
      // socket died mid-run (the poll ends with the run either way).
      comfyRunSnapshots.set(cfg.endpoint, { promptId, progress: 1 });

      const images: ImageGenGeneratedImage[] = [];
      for (const row of outputImages) {
        const viewUrl =
          `${cfg.endpoint}/view?filename=${encodeURIComponent(row.filename)}` +
          `&subfolder=${encodeURIComponent(row.subfolder ?? "")}` +
          `&type=${encodeURIComponent(row.type ?? "output")}`;
        const viewResponse = await fetchOrWrap(
          cfg.fetch,
          viewUrl,
          { method: "GET", headers: { Accept: "image/*" }, signal: request.signal },
          "image download",
        );
        if (!viewResponse.ok) {
          const excerpt = await readProviderErrorBody(viewResponse);
          throw new ComfyImageGenError(
            `ComfyUI image download failed with HTTP ${viewResponse.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: viewResponse.status },
          );
        }
        const data = Buffer.from(await viewResponse.arrayBuffer());
        if (data.length === 0) {
          throw new ComfyImageGenError("ComfyUI image download returned zero bytes");
        }
        images.push({ data, mimeType: sniffImageMime(data) ?? "image/png" });
      }

      // Wire meaning of what was sent (the a1111 twin): W/H echo
      // independently; the seed is the graph's own resolved value; the
      // resolved template id rides for the slot provenance (CG-A2).
      const result: ImageGenGenerateResult = { images, seed, resolvedTemplate: template };
      if (request.width !== undefined) result.width = request.width;
      if (request.height !== undefined) result.height = request.height;
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      // The model union (CG-A3): checkpoints ∪ diffusion models — the two
      // folders the two templates load from. `id` keeps the server's path
      // VERBATIM (round-trips into ckpt_name/unet_name byte-identically,
      // subfolder separators included); `label` is the basename without the
      // weights extension; `template` marks which workflow the adapter
      // resolves; `family` rides the metadata ladder with silent
      // degradation (an unreadable store never fails the list).
      const checkpointNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "checkpoints", signal);
      const unetNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "diffusion_models", signal);
      // Folder roots for the sidecar join — fetched lazily, ONCE per
      // listing, and only when the first model actually needs a sidecar.
      let folderRoots: Record<string, string[]> | undefined;
      let folderRootsFetched = false;
      const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
        if (!folderRootsFetched) {
          folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, signal);
          folderRootsFetched = true;
        }
        return folderRoots;
      };
      const entries: ImageGenModelInfo[] = [];
      const folders: Array<{ folder: string; names: string[]; template: string }> = [
        { folder: "checkpoints", names: checkpointNames, template: COMFY_MODEL_TEMPLATES.checkpoint },
        { folder: "diffusion_models", names: unetNames, template: COMFY_MODEL_TEMPLATES.krea2Dit },
      ];
      for (const { folder, names, template } of folders) {
        for (const name of names) {
          const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
            folder,
            name,
            signal,
            rootsOf,
          });
          const label = weightsBasename(name);
          entries.push({
            id: name,
            label: label.length > 0 ? label : name,
            ...(family !== undefined ? { family } : {}),
            template,
          });
        }
      }
      return entries;
    },

    async listSamplers(signal?: AbortSignal): Promise<ImageGenSamplerInfo[]> {
      // The live KSampler sampler union (CG-A3) — the same /object_info
      // combo walk template detection uses; bare enums, no aliases.
      const names = await fetchComfyComboValues(
        cfg.fetch,
        cfg.endpoint,
        "KSampler",
        "sampler_name",
        signal,
      );
      return names.map((name) => ({ name }));
    },

    async listSchedulers(signal?: AbortSignal): Promise<ImageGenSchedulerInfo[]> {
      // The live KSampler scheduler union (CG-A3) — bare enums, no labels.
      const names = await fetchComfyComboValues(
        cfg.fetch,
        cfg.endpoint,
        "KSampler",
        "scheduler",
        signal,
      );
      return names.map((name) => ({ name }));
    },

    async listDitSidecars(signal?: AbortSignal): Promise<ImageGenDitSidecars> {
      // The live DiT sidecar folders (CG-B1) — the same catalogs the
      // generate path resolves canonical sidecars against; both fetched in
      // parallel (independent folders, one round-trip each).
      const [encoders, vaes] = await Promise.all([
        fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "text_encoders", signal),
        fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "vae", signal),
      ]);
      return { encoders, vaes };
    },

    /** Publish the run's WS-fed snapshot (CG-C1). No snapshot (idle
     *  server, socket never opened) = an honest 0 — the poll only runs
     *  while a VT generation is in flight, so 0 reads as "no steps
     *  observed yet", never a fake cloud bar. */
    async progress(): Promise<ImageGenProgressInfo> {
      const snapshot = comfyRunSnapshots.get(cfg.endpoint);
      if (snapshot === undefined) return { progress: 0 };
      return snapshot.state === undefined
        ? { progress: snapshot.progress }
        : { progress: snapshot.progress, state: snapshot.state };
    },

    /** Cancel the instance's current job — POST /interrupt, the a1111
     *  twin (instance-global on a single-user local server). */
    async interrupt(signal?: AbortSignal): Promise<void> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/interrupt`,
        { method: "POST", headers: { Accept: "application/json" }, signal },
        "interrupt",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new ComfyImageGenError(
          `ComfyUI interrupt failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/system_stats`, {
          method: "GET",
          headers: { Accept: "application/json" },
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
        let detail = "ComfyUI server";
        const system = typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>).system
          : undefined;
        if (typeof system === "object" && system !== null) {
          const version = (system as Record<string, unknown>).comfyui_version;
          if (typeof version === "string" && version.length > 0) detail = `ComfyUI ${version}`;
        }
        return { ok: true, detail };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async dispose(): Promise<void> {
      // Stateless: the WS progress listener is scoped to a single
      // generate() run and closed in its finally — nothing outlives a run
      // (the registry entry it wrote is a plain map slot, GC'd on
      // overwrite by the next run).
    },
  };

  return backend;
};

// Module-scope registration (protocol-registry pattern, the a1111 twin):
// importing this module makes the 'comfyui' image-gen slug creatable via
// the image-gen registry.
registerImageGenBackend(IMAGE_GEN_BACKENDS.ComfyUI, comfyImageGenFactory);
