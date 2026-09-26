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
 *   IPT-3 reuses the SAME stores for family detection: `readModelDetectionMetadata`
 *   surfaces the RAW embedded label for one model (mapping happens
 *   detection-side — no picker bucket collapse) plus the folder-roots
 *   sidecar anchor; core ComfyUI exposes NO hash, so the Civitai by-hash
 *   source stays structurally unavailable on this dialect.
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
 * - clipSkip >= 2 rides `CLIPSetLastLayer.stop_at_clip_layer = -clipSkip`
 *   (ComfyUI counts from the end; the node is OMITTED for clipSkip 1 or
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
 *
 * Second passes (IF-6 live gate — verified 2026-09-24 on ComfyUI 0.37.0,
 * read-only probes against the owner's install, the PG-5 evidence
 * standard; her install is a verification probe, never a product
 * assumption — files discovered, never hardcoded):
 * - MISSING NODE = `GET /object_info/{node}` answers 200 with `{}` — node
 *   presence is the response carrying the node-class key, never 404.
 * - PER-NODE COMBO TRUNCATION: large combos come back as the literal
 *   string "COMBO" (observed: UpscaleModelLoader.model_name truncated
 *   while a 4-entry detector combo and LoraLoader's full list pass) —
 *   list sources prefer the /models/{folder} route where a verbatim
 *   filename list is needed (upscale_models), with the combo as the
 *   primary source only where the queue validates against the combo
 *   itself (detectors), falling back to /models/ultralytics with
 *   backslash→slash normalization when truncation/absence empties it.
 * - HIRES (FT-A4 comfy): no single API flag — the pass is a conditional
 *   subgraph injected after the template build (LatentUpscaleBy for the
 *   unset/Auto upscaler; UpscaleModelLoader → ImageUpscaleWithModel →
 *   VAEEncode for a named upscale model), then a second KSampler with
 *   lowered denoise and the first pass's resolved sampler knobs.
 * - FACE DETAILING (IF-6): the ADetailer equivalent is the Impact Pack's
 *   self-contained FaceDetailer node + UltralyticsDetectorProvider — the
 *   chain is DISCOVERED (node presence + face bbox combo), never assumed.
 *   FaceDetailer carries EVERY required input explicitly (the API graph
 *   cannot rely on server-side default filling — the weight_dtype
 *   lesson), values = the node's own declared defaults except the knobs
 *   VT owns (detector model, inherited sampler/steps/cfg/seed).
 */

import { IMAGE_GEN_BACKENDS, type ImagePromptFamilyId } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGeneratedImage,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenDitSidecars,
  ImageGenModelDetectionMetadata,
  ImageGenModelInfo,
  ImageGenProbeResult,
  ImageGenProgressInfo,
  ImageGenLoraInfo,
  ImageGenSamplerInfo,
  ImageGenSchedulerInfo,
  ImageGenWebSocketLike,
  ImageGenUpscalerInfo,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";
import {
  COMFY_DIT_WORKFLOW_SHAPES,
  COMFY_TEMPLATE_SPECS,
  comfyWeightsBasename,
  resolveComfySidecar,
} from "./comfy-workflow-templates.js";
import type { ComfyDitTemplateSpec } from "./comfy-workflow-templates.js";

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
  modelSamplingAuraFlow: "14",
  conditioningZeroOut: "15",
  hiresLatentUpscale: "30",
  hiresUpscaleModel: "31",
  hiresImageUpscale: "32",
  /** A1111-parity resize (2026-09-27 fix): the model upscaler's native
   *  output (e.g. 4x) is resampled down to base × hr_scale BEFORE the
   *  re-encode — without it the second KSampler samples the upscaler's
   *  full native latent (a 4x RRDB off a 1024×1536 base = 25 MP on a
   *  12 GB GPU = ~100 s/step of VRAM thrash — the owner's live report). */
  hiresImageScale: "37",
  hiresVaeEncode: "33",
  hiresKSampler: "34",
  hiresVaeDecode: "35",
  /** Checkpoint-template VAE swap (IF-7b): exists ONLY when the request
   *  pins a VAE — the no-swap graph stays byte-identical to the bundled
   * third output (the CG no-lora precedent). */
  checkpointVaeLoader: "36",
  faceDetector: "40",
  faceDetailer: "41",
  /** Segmentation arm (segm/ picks): the SEGS hop and its detailer —
   *  ids 42/43 keep the face arm's 40/41 untouched. */
  segmDetectorSegs: "42",
  segmDetailer: "43",
} as const;

/** First LoraLoader node id of the CG-C2 chain — loras append ABOVE the
 *  base ids (dynamic count, stable per index: 20, 21, …). */
export const COMFY_LORA_NODE_ID_BASE = 20;

/** One enabled LoRA of a generation request (CG-C2) — the flat chip draft
 *  mapped onto LoraLoader nodes. `strength` feeds BOTH strength_model and
 *  strength_clip (single-slider chip, the FT-A5 surface). */
export interface ComfyLoraChainEntry {
  name: string;
  strength: number;
}

/** Build the LoraLoader chain threaded between the loader half and the
 *  sampler half (CG-C2): the loader's MODEL/CLIP outputs → lora₀ → … →
 *  loraₙ → KSampler.model + the text encoders' clip source. Pure; an
 *  empty list returns the origin refs verbatim with NO nodes (the
 *  no-lora graph is byte-identical to the pre-C2 template). Node ids run
 *  from COMFY_LORA_NODE_ID_BASE — part of the wire contract the tests
 *  pin. The VAE never threads through the chain (LoraLoader has no VAE
 *  input — the checkpoint's bundled third output / the VAELoader stay
 *  wired directly). */
export function buildComfyLoraChain(
  loras: readonly ComfyLoraChainEntry[],
  origin: { model: [string, number]; clip: [string, number] },
): { nodes: ComfyWorkflowGraph; model: [string, number]; clip: [string, number] } {
  const nodes: ComfyWorkflowGraph = {};
  let model = origin.model;
  let clip = origin.clip;
  for (const [index, lora] of loras.entries()) {
    const id = String(COMFY_LORA_NODE_ID_BASE + index);
    nodes[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: lora.name,
        strength_model: lora.strength,
        strength_clip: lora.strength,
        model,
        clip,
      },
    };
    model = [id, 0];
    clip = [id, 1];
  }
  return { nodes, model, clip };
}

/** The workflow graph the flat request maps onto: a record of node id →
 *  `{class_type, inputs}` — the exact `prompt` value POSTed to `/prompt`. */
export type ComfyWorkflowGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Backward-compatible aliases for the Krea-2 registry fields. */
export const COMFY_KREA2_CLIP_TYPE = COMFY_TEMPLATE_SPECS.krea2Dit.clipType;
export const COMFY_KREA2_DEFAULT_ENCODER = COMFY_TEMPLATE_SPECS.krea2Dit.canonicalEncoder;
export const COMFY_KREA2_DEFAULT_VAE = COMFY_TEMPLATE_SPECS.krea2Dit.canonicalVae;

/** The workflow-template ids the adapter resolves — the marker each
 *  model-picker entry carries (CG-A3) and the value recorded in the slot
 *  provenance `params.template` (CG-A2). */
export const COMFY_MODEL_TEMPLATES = {
  checkpoint: "checkpoint",
  krea2Dit: "krea2-dit",
  animaDit: "anima-dit",
  qwenImage21: "qwen-image-2.1",
  qwenImage: "qwen-image",
  zImage: "z-image",
  fluxDev: "flux-dev",
  fluxSchnell: "flux-schnell",
} as const;

type ComfySelectedTemplateSpec = (typeof COMFY_TEMPLATE_SPECS)[keyof typeof COMFY_TEMPLATE_SPECS];
type ComfyPinnedDitTemplateSpec = Exclude<ComfySelectedTemplateSpec, typeof COMFY_TEMPLATE_SPECS.checkpoint>;

function isComfyPinnedDitTemplate(
  spec: ComfySelectedTemplateSpec,
): spec is ComfyPinnedDitTemplateSpec {
  return spec !== COMFY_TEMPLATE_SPECS.checkpoint;
}

/** Map the profile's authoritative manual family pin to a workflow template. */
function resolveComfyPinnedTemplate(family: ImagePromptFamilyId): ComfySelectedTemplateSpec {
  if (family === "krea2") return COMFY_TEMPLATE_SPECS.krea2Dit;
  if (family === "anima") return COMFY_TEMPLATE_SPECS.animaDit;
  if (
    family === "prose" ||
    family === "pony" ||
    family === "illustrious" ||
    family === "noobai" ||
    family === "sdxl-realism" ||
    family === "hybrid"
  ) {
    return COMFY_TEMPLATE_SPECS.checkpoint;
  }
  throw new ComfyImageGenConfigError(
    `ComfyUI prompt family "${family}" has no workflow template yet`,
  );
}

/** Map a sampler-set manual workflow pick to its ComfyUI template.
 * The executor checks this before profile prompt pins and metadata so an
 * explicit set is authoritative. The string parameter deliberately remains
 * runtime-wide: direct adapter callers bypass the Zod route boundary. */
function resolveComfyManualWorkflowTemplate(family: string): ComfySelectedTemplateSpec {
  if (family === "qwen-image-2.1") return COMFY_TEMPLATE_SPECS.qwenImage21;
  if (family === "qwen-image") return COMFY_TEMPLATE_SPECS.qwenImage;
  if (family === "z-image") return COMFY_TEMPLATE_SPECS.zImage;
  if (family === "flux-dev") return COMFY_TEMPLATE_SPECS.fluxDev;
  if (family === "flux-schnell") return COMFY_TEMPLATE_SPECS.fluxSchnell;
  if (family === "krea2-dit") return COMFY_TEMPLATE_SPECS.krea2Dit;
  if (family === "anima-dit") return COMFY_TEMPLATE_SPECS.animaDit;
  if (family === "checkpoint") return COMFY_TEMPLATE_SPECS.checkpoint;
  throw new ComfyImageGenConfigError(
    `ComfyUI workflow family "${family}" has no workflow template`,
  );
}

/** Registry spec → its typed picker/provenance marker. */
function comfyTemplateMarker(spec: ComfyDitTemplateSpec): (typeof COMFY_MODEL_TEMPLATES)[keyof typeof COMFY_MODEL_TEMPLATES] {
  if (spec === COMFY_TEMPLATE_SPECS.krea2Dit) return COMFY_MODEL_TEMPLATES.krea2Dit;
  if (spec === COMFY_TEMPLATE_SPECS.animaDit) return COMFY_MODEL_TEMPLATES.animaDit;
  if (spec === COMFY_TEMPLATE_SPECS.qwenImage21) return COMFY_MODEL_TEMPLATES.qwenImage21;
  if (spec === COMFY_TEMPLATE_SPECS.qwenImage) return COMFY_MODEL_TEMPLATES.qwenImage;
  if (spec === COMFY_TEMPLATE_SPECS.zImage) return COMFY_MODEL_TEMPLATES.zImage;
  if (spec === COMFY_TEMPLATE_SPECS.fluxDev) return COMFY_MODEL_TEMPLATES.fluxDev;
  if (spec === COMFY_TEMPLATE_SPECS.fluxSchnell) return COMFY_MODEL_TEMPLATES.fluxSchnell;
  throw new ComfyImageGenConfigError(`ComfyUI ${spec.familyLabel} template has no registry marker`);
}

/** Resolve a metadata-detected diffusion family without guessing from its filename. */
function resolveComfyAutoDiffusionTemplate(
  family: string | undefined,
  model: string,
): ComfyDitTemplateSpec {
  if (family === "Krea 2") return COMFY_TEMPLATE_SPECS.krea2Dit;
  if (family === "Anima") return COMFY_TEMPLATE_SPECS.animaDit;
  if (family === "qwen-image-2.1") return COMFY_TEMPLATE_SPECS.qwenImage21;
  if (family === "qwen-image") return COMFY_TEMPLATE_SPECS.qwenImage;
  if (family === "z-image") return COMFY_TEMPLATE_SPECS.zImage;
  if (family === "flux-dev") return COMFY_TEMPLATE_SPECS.fluxDev;
  if (family === "flux-schnell") return COMFY_TEMPLATE_SPECS.fluxSchnell;
  if (family === undefined) {
    throw new ComfyImageGenConfigError(
      `ComfyUI model "${model}" has no detected family — pin the family on the profile`,
    );
  }
  throw new ComfyImageGenConfigError(
    `ComfyUI model "${model}" resolves to the "${family}" family, which has no workflow template yet`,
  );
}

/** The listing marker mirrors only metadata-resolved diffusion templates. */
function resolveComfyListedDiffusionTemplate(family: string | undefined): string | undefined {
  if (family === "Krea 2") return COMFY_MODEL_TEMPLATES.krea2Dit;
  if (family === "Anima") return COMFY_MODEL_TEMPLATES.animaDit;
  if (family === "qwen-image-2.1") return COMFY_MODEL_TEMPLATES.qwenImage21;
  if (family === "qwen-image") return COMFY_MODEL_TEMPLATES.qwenImage;
  if (family === "z-image") return COMFY_MODEL_TEMPLATES.zImage;
  if (family === "flux-dev") return COMFY_MODEL_TEMPLATES.fluxDev;
  if (family === "flux-schnell") return COMFY_MODEL_TEMPLATES.fluxSchnell;
  return undefined;
}

/** Resolved loader inputs of the Krea-2 DiT template. */
export interface ComfyKrea2Sidecars {
  /** `UNETLoader.unet_name` — the resolved model id itself. */
  unet: string;
  /** `CLIPLoader.clip_name` — the text-encoder file. */
  encoder: string;
  /** `VAELoader.vae_name`. */
  vae: string;
}

/** Resolved loader inputs for a DiT template with an optional second CLIP. */
export interface ComfyDitSidecars extends ComfyKrea2Sidecars {
  /** `DualCLIPLoader.clip_name2`, required by FLUX templates only. */
  secondaryEncoder?: string;
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
): { graph: ComfyWorkflowGraph; resolved: ComfySamplerResolved } {
  const seed = resolveComfySeed(request.seed);
  const width = request.width !== undefined ? requirePositiveInt("width", request.width) : undefined;
  const height = request.height !== undefined ? requirePositiveInt("height", request.height) : undefined;
  const clipSkip = request.clipSkip;
  const steps = request.steps ?? COMFY_NODE_DEFAULTS.steps;
  const cfg = request.cfgScale ?? COMFY_NODE_DEFAULTS.cfg;
  const samplerName = setOrUndefined(request.sampler) ?? COMFY_NODE_DEFAULTS.samplerName;
  const scheduler = setOrUndefined(request.scheduler) ?? COMFY_NODE_DEFAULTS.scheduler;

  // The clip source of the two text encoders: the loader output directly,
  // or through CLIPSetLastLayer when the request slices layers (clipSkip >=
  // 2 — clipSkip 1 is a1111's no-skip and must not emit the node).
  const clipSource: [string, number] =
    clipSkip !== undefined && clipSkip >= 2 ? [COMFY_NODE_IDS.clipSetLastLayer, 0] : refs.clip;

  const graph: ComfyWorkflowGraph = {
    [COMFY_NODE_IDS.kSampler]: {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: request.steps ?? COMFY_NODE_DEFAULTS.steps,
        cfg: request.cfgScale ?? COMFY_NODE_DEFAULTS.cfg,
        sampler_name: samplerName,
        scheduler: scheduler,
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
  if (clipSkip !== undefined && clipSkip >= 2) {
    graph[COMFY_NODE_IDS.clipSetLastLayer] = {
      class_type: "CLIPSetLastLayer",
      // ComfyUI counts from the end: clipSkip 2 (skip one layer) → -2.
      // clipSkip 1 (a1111's "no skip") must OMIT the node entirely: SDXL's
      // no-node default IS its trained penultimate layer, while an explicit
      // -1 shifts the hidden state one block off-distribution → garbage
      // conditioning → mush images (live-diagnosed 2026-09-27: every run
      // with the node at -1 produced mush, every run without it — including
      // a controlled default-workflow probe on the same checkpoint — was
      // clean).
      inputs: { stop_at_clip_layer: -clipSkip, clip: refs.clip },
    };
  }
  return { graph, resolved: { seed, steps, cfg, samplerName, scheduler, clipSource, width: width ?? COMFY_NODE_DEFAULTS.latentWidth, height: height ?? COMFY_NODE_DEFAULTS.latentHeight } };
}

/** The first-pass resolved values the second-pass subgraphs inherit —
 *  what `buildComfyCommonNodes` resolved plus the loader-half refs the
 *  template wrapper owns (the post-LoRA-chain model, the post-clipSkip
 *  clip, the template's VAE). The seed is the SAME resolved value the
 *  first KSampler carries: a deterministic chain (ComfyUI has no
 *  A1111-style second-seed concept wired in v1). */
export interface ComfySecondPassCtx {
  model: [string, number];
  clip: [string, number];
  vae: [string, number];
  seed: number;
  steps: number;
  /** Explicit detail-pass steps; absent inherits the first pass. */
  adetailerSteps?: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  /** The first-pass latent's resolved pixel size — the hires model path
   *  resizes to base × hr_scale before re-encoding (the sampled resolution
   *  IS the target, never the upscaler's native factor). */
  width: number;
  height: number;
}

/** The first-pass resolved params (sampler half) — buildComfyCommonNodes's
 *  return shape. */
interface ComfySamplerResolved {
  seed: number;
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  clipSource: [string, number];
  /** The first-pass latent's resolved pixel size (request value or the
   *  EmptyLatentImage defaults) — the hires model path's resize target
   * base (base × hr_scale, the A1111 sampled-resolution semantics). */
  width: number;
  height: number;
}

/** Build the CHECKPOINT-template workflow graph from the flat request +
 *  the resolved profile model. Pure — exported for the wire tests. The
 *  second return value is the second-pass ctx (seed included). */
export function buildComfyCheckpointWorkflow(
  request: ImageGenGenerateRequest,
  resolvedModel: string,
): { graph: ComfyWorkflowGraph; seed: number; ctx: ComfySecondPassCtx } {
  // LoRA chain (CG-C2): the checkpoint's MODEL/CLIP outputs thread through
  // the LoraLoaders before reaching the sampler half; its VAE (third
  // output) never does.
  const chain = buildComfyLoraChain(request.loras ?? [], {
    model: [COMFY_NODE_IDS.checkpoint, 0],
    clip: [COMFY_NODE_IDS.checkpoint, 1],
  });
  const { graph, resolved } = buildComfyCommonNodes(request, { model: chain.model, clip: chain.clip });
  Object.assign(graph, chain.nodes);
  graph[COMFY_NODE_IDS.checkpoint] = {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: resolvedModel },
  };
  // VAE swap (IF-7b): a pinned `request.vae` replaces the checkpoint's
  // bundled third output with a VAELoader — the KREA-2 template's own
  // wiring pattern. Absent → the bundled output, byte-identical to the
  // pre-swap template (the no-lora rule).
  let vaeRef: [string, number] = [COMFY_NODE_IDS.checkpoint, 2];
  if (request.vae !== undefined && request.vae !== "") {
    graph[COMFY_NODE_IDS.checkpointVaeLoader] = {
      class_type: "VAELoader",
      inputs: { vae_name: request.vae },
    };
    vaeRef = [COMFY_NODE_IDS.checkpointVaeLoader, 0];
  }
  // The checkpoint's own third output is its bundled VAE (or the swap's
  // VAELoader output above).
  graph[COMFY_NODE_IDS.vaeDecode]!.inputs.vae = vaeRef;
  return {
    graph,
    seed: resolved.seed,
    ctx: {
      model: chain.model,
      clip: resolved.clipSource,
      vae: vaeRef,
      seed: resolved.seed,
      steps: resolved.steps,
      adetailerSteps: request.adetailerSteps,
      cfg: resolved.cfg,
      samplerName: resolved.samplerName,
      scheduler: resolved.scheduler,
      width: resolved.width,
      height: resolved.height,
    },
  };
}

/** The unet loader node for a resolved model FILE: GGUF quants load
 *  through UnetLoaderGGUF (ComfyUI-GGUF; no weight_dtype — the quant
 *  carries its own dtype), safetensors/ckpt through UNETLoader. The split
 *  keys on the file EXTENSION — a format fact, never name-guessing
 *  (owner's flux fleet: artsyLite_v1Q4KS.gguf, a Flux.1 S finetune). */
function buildComfyUnetLoader(unet: string): { class_type: string; inputs: Record<string, unknown> } {
  if (unet.toLowerCase().endsWith(".gguf")) {
    return { class_type: "UnetLoaderGGUF", inputs: { unet_name: unet } };
  }
  return {
    class_type: "UNETLoader",
    inputs: { unet_name: unet, weight_dtype: COMFY_NODE_DEFAULTS.unetWeightDtype },
  };
}

/** Build the KREA-2 DiT-template workflow graph (CG-A2): a bare diffusion
 *  model loads through UNETLoader, and the text encoder + VAE come from
 *  SEPARATE loaders (a DiT file bundles neither). `CLIPLoader.type` comes
 *  from the selected template spec. Pure — exported for the wire tests. The
 *  second return value is the second-pass ctx. */
export function buildComfyKrea2Workflow(
  request: ImageGenGenerateRequest,
  sidecars: ComfyKrea2Sidecars,
  spec: ComfyDitTemplateSpec = COMFY_TEMPLATE_SPECS.krea2Dit,
): { graph: ComfyWorkflowGraph; seed: number; ctx: ComfySecondPassCtx } {
  // LoRA chain (CG-C2): UNETLoader's MODEL and CLIPLoader's CLIP thread
  // through the LoraLoaders; the VAELoader stays wired directly.
  const chain = buildComfyLoraChain(request.loras ?? [], {
    model: [COMFY_NODE_IDS.unet, 0],
    clip: [COMFY_NODE_IDS.clip, 0],
  });
  const { graph, resolved } = buildComfyCommonNodes(request, { model: chain.model, clip: chain.clip });
  Object.assign(graph, chain.nodes);
  graph[COMFY_NODE_IDS.unet] = buildComfyUnetLoader(sidecars.unet);
  graph[COMFY_NODE_IDS.clip] = {
    class_type: "CLIPLoader",
    inputs: { clip_name: sidecars.encoder, type: spec.clipType },
  };
  graph[COMFY_NODE_IDS.vae] = {
    class_type: "VAELoader",
    inputs: { vae_name: sidecars.vae },
  };
  graph[COMFY_NODE_IDS.vaeDecode]!.inputs.vae = [COMFY_NODE_IDS.vae, 0];
  return {
    graph,
    seed: resolved.seed,
    ctx: {
      model: chain.model,
      clip: resolved.clipSource,
      vae: [COMFY_NODE_IDS.vae, 0],
      seed: resolved.seed,
      steps: resolved.steps,
      adetailerSteps: request.adetailerSteps,
      cfg: resolved.cfg,
      samplerName: resolved.samplerName,
      scheduler: resolved.scheduler,
      width: resolved.width,
      height: resolved.height,
    },
  };
}

/** Build one of IF-12/IF-16c/d's non-Krea DiT graphs from its registry spec.
 *  The existing Krea-2 builder stays untouched so its wire shape remains
 *  byte-identical. */
export function buildComfyDitWorkflow(
  request: ImageGenGenerateRequest,
  sidecars: ComfyDitSidecars,
  spec: ComfyDitTemplateSpec,
): { graph: ComfyWorkflowGraph; seed: number; ctx: ComfySecondPassCtx } {
  const defaults = spec.defaults;
  if (defaults === undefined) {
    throw new ComfyImageGenConfigError(`ComfyUI ${spec.familyLabel} template has no graph defaults`);
  }
  const requestWithDefaults: ImageGenGenerateRequest = {
    ...request,
    width: request.width ?? defaults.width,
    height: request.height ?? defaults.height,
    steps: request.steps ?? defaults.steps,
    cfgScale: request.cfgScale ?? defaults.cfg,
    sampler: request.sampler ?? defaults.sampler,
    scheduler: request.scheduler ?? defaults.scheduler,
  };
  const chain = buildComfyLoraChain(request.loras ?? [], {
    model: [COMFY_NODE_IDS.unet, 0],
    clip: [COMFY_NODE_IDS.clip, 0],
  });
  const { graph, resolved } = buildComfyCommonNodes(requestWithDefaults, { model: chain.model, clip: chain.clip });
  Object.assign(graph, chain.nodes);
  graph[COMFY_NODE_IDS.unet] = buildComfyUnetLoader(sidecars.unet);
  if (spec.canonicalSecondaryEncoder !== undefined) {
    if (sidecars.secondaryEncoder === undefined) {
      throw new ComfyImageGenConfigError(`ComfyUI ${spec.familyLabel} template needs its second text encoder`);
    }
    graph[COMFY_NODE_IDS.clip] = {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: sidecars.encoder,
        clip_name2: sidecars.secondaryEncoder,
        type: spec.clipType,
      },
    };
  } else {
    graph[COMFY_NODE_IDS.clip] = {
      class_type: "CLIPLoader",
      inputs: { clip_name: sidecars.encoder, type: spec.clipType },
    };
  }
  graph[COMFY_NODE_IDS.vae] = {
    class_type: "VAELoader",
    inputs: { vae_name: sidecars.vae },
  };
  graph[COMFY_NODE_IDS.latent]!.class_type = spec.latentNode ?? "EmptyLatentImage";
  graph[COMFY_NODE_IDS.vaeDecode]!.inputs.vae = [COMFY_NODE_IDS.vae, 0];

  let modelRef: [string, number] = chain.model;
  if (spec.auraFlowShift !== undefined) {
    graph[COMFY_NODE_IDS.modelSamplingAuraFlow] = {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: modelRef, shift: spec.auraFlowShift },
    };
    modelRef = [COMFY_NODE_IDS.modelSamplingAuraFlow, 0];
    graph[COMFY_NODE_IDS.kSampler]!.inputs.model = modelRef;
  }

  if (spec.workflowShape === COMFY_DIT_WORKFLOW_SHAPES.QwenImage21) {
    graph[COMFY_NODE_IDS.positive] = {
      class_type: "TextEncodeQwenImage21",
      inputs: {
        clip: resolved.clipSource,
        prompt: request.prompt,
        negative_prompt: request.negativePrompt ?? "",
        resolution: 1024,
      },
    };
    delete graph[COMFY_NODE_IDS.negative];
    graph[COMFY_NODE_IDS.kSampler]!.inputs.positive = [COMFY_NODE_IDS.positive, 0];
    graph[COMFY_NODE_IDS.kSampler]!.inputs.negative = [COMFY_NODE_IDS.positive, 1];
  } else if (spec.workflowShape === COMFY_DIT_WORKFLOW_SHAPES.FluxDev) {
    graph[COMFY_NODE_IDS.negative] = {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: [COMFY_NODE_IDS.positive, 0] },
    };
  } else if (spec.workflowShape === COMFY_DIT_WORKFLOW_SHAPES.FluxSchnell) {
    graph[COMFY_NODE_IDS.positive] = {
      class_type: "CLIPTextEncodeFlux",
      inputs: {
        clip: resolved.clipSource,
        clip_l: request.prompt,
        t5xxl: request.prompt,
        guidance: defaults.guidance ?? 3.5,
      },
    };
    delete graph[COMFY_NODE_IDS.negative];
    delete graph[COMFY_NODE_IDS.kSampler]!.inputs.negative;
  }
  return {
    graph,
    seed: resolved.seed,
    ctx: {
      model: modelRef,
      clip: resolved.clipSource,
      vae: [COMFY_NODE_IDS.vae, 0],
      seed: resolved.seed,
      steps: resolved.steps,
      adetailerSteps: request.adetailerSteps,
      cfg: resolved.cfg,
      samplerName: resolved.samplerName,
      scheduler: resolved.scheduler,
      width: resolved.width,
      height: resolved.height,
    },
  };
}

// ─── Second passes: hires fix + face detailing (IF-6, FT-A4 comfy) ────

/** Hires-fix defaults for unset knobs (FT-A6 anchors, A1111 parity):
 *  scale 2.0 = the hr_scale display anchor; denoise 0.75 = the A1111
 *  server's own default; latent upscale method "nearest-exact" = the
 *  node's first combo entry (the classic hires latent default). */
export const COMFY_HIRES_DEFAULTS = {
  scale: 2.0,
  denoise: 0.75,
  latentMethod: "nearest-exact",
  /** The model path's post-upscale resample (a1111 parity): lanczos —
   *  the sharp filter for downsampling the native-factor output to the
   *  base × hr_scale target. */
  imageResizeMethod: "lanczos",
} as const;

/** FaceDetailer's node-declared defaults (live-verified 0.37.0 — the
 *  Impact Pack node's own INPUT_TYPES values, the COMFY_NODE_DEFAULTS
 *  class: the API graph must carry every required input explicitly, so
 *  the node's declared defaults are materialized client-side). denoise
 *  0.5 is the node's own low-denoise inpaint default — the ADetailer
 *  behavior twin. */
export const COMFY_FACE_DETAILER_DEFAULTS = {
  denoise: 0.5,
  guideSize: 512,
  guideSizeFor: true,
  maxSize: 1024,
  feather: 5,
  noiseMask: true,
  forceInpaint: true,
  bboxThreshold: 0.5,
  bboxDilation: 10,
  bboxCropFactor: 3.0,
  samDetectionHint: "mask-area",
  samDilation: 0,
  samThreshold: 0.93,
  samBboxExpansion: 0,
  samMaskHintThreshold: 0.7,
  samMaskHintUseNegative: "False",
  dropSize: 10,
  cycle: 1,
} as const;

/** SegmDetectorSEGS's node-declared defaults (live-verified 0.37.0 — the
 *  same materialize-declared-defaults discipline). DetailerForEach reuses
 *  COMFY_FACE_DETAILER_DEFAULTS: the per-detection knobs are the same node
 *  family values (512/1024/0.5). */
const COMFY_SEGM_DETECTOR_DEFAULTS = {
  threshold: 0.5,
  dilation: 10,
  cropFactor: 3.0,
  dropSize: 10,
  labels: "all",
} as const;

/** Inject the hires-fix second pass (FT-A4, comfy dialect) into a built
 *  template graph and rewire SaveImage to the second decode. The upscaler
 *  maps by name: unset (the chip's Auto) → the LATENT path
 *  (LatentUpscaleBy on the first sampler's latent — no model file needed,
 *  the A1111 "Latent" upscaler analog); a real name → the model path
 *  (UpscaleModelLoader → ImageUpscaleWithModel → ImageScale → VAEEncode;
 *  the native-factor output is resampled to base × hr_scale — the sampled
 *  resolution is the TARGET, never the upscaler's native factor, the
 *  2026-09-27 fix). Steps inherit
 *  the first pass when unset or 0 (A1111 hr_second_pass_steps=0
 *  semantics); sampler/scheduler/cfg/seed are the first pass's own
 *  resolved values — a deterministic chain. Mutates the passed graph;
 *  returns the final image ref (the second VAEDecode output). Pure. */
export function applyComfyHiresPass(
  graph: ComfyWorkflowGraph,
  request: ImageGenGenerateRequest,
  ctx: ComfySecondPassCtx,
): { finalImage: [string, number] } {
  const hires = request.hires;
  if (hires === undefined) throw new Error("applyComfyHiresPass called without a hires object");
  const upscaler = setOrUndefined(hires.upscaler);
  const scale = hires.scale ?? COMFY_HIRES_DEFAULTS.scale;
  const denoise = hires.denoisingStrength ?? COMFY_HIRES_DEFAULTS.denoise;
  const steps = (hires.steps ?? 0) > 0 ? hires.steps! : ctx.steps;
  let secondLatent: [string, number];
  if (upscaler === undefined) {
    graph[COMFY_NODE_IDS.hiresLatentUpscale] = {
      class_type: "LatentUpscaleBy",
      inputs: {
        samples: [COMFY_NODE_IDS.kSampler, 0],
        upscale_method: COMFY_HIRES_DEFAULTS.latentMethod,
        scale_by: scale,
      },
    };
    secondLatent = [COMFY_NODE_IDS.hiresLatentUpscale, 0];
  } else {
    graph[COMFY_NODE_IDS.hiresUpscaleModel] = {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: upscaler },
    };
    graph[COMFY_NODE_IDS.hiresImageUpscale] = {
      class_type: "ImageUpscaleWithModel",
      inputs: {
        upscale_model: [COMFY_NODE_IDS.hiresUpscaleModel, 0],
        image: [COMFY_NODE_IDS.vaeDecode, 0],
      },
    };
    // A1111 hr semantics: resize to the TARGET (base × hr_scale) — the
    // upscaler's native factor (4x, 2x…) only builds detail; the second
    // sampler never sees it.
    graph[COMFY_NODE_IDS.hiresImageScale] = {
      class_type: "ImageScale",
      inputs: {
        image: [COMFY_NODE_IDS.hiresImageUpscale, 0],
        upscale_method: COMFY_HIRES_DEFAULTS.imageResizeMethod,
        width: Math.round(ctx.width * scale),
        height: Math.round(ctx.height * scale),
        crop: "disabled",
      },
    };
    graph[COMFY_NODE_IDS.hiresVaeEncode] = {
      class_type: "VAEEncode",
      inputs: { pixels: [COMFY_NODE_IDS.hiresImageScale, 0], vae: ctx.vae },
    };
    secondLatent = [COMFY_NODE_IDS.hiresVaeEncode, 0];
  }
  graph[COMFY_NODE_IDS.hiresKSampler] = {
    class_type: "KSampler",
    inputs: {
      seed: ctx.seed,
      steps,
      cfg: ctx.cfg,
      sampler_name: ctx.samplerName,
      scheduler: ctx.scheduler,
      denoise,
      model: ctx.model,
      positive: [COMFY_NODE_IDS.positive, 0],
      negative: [COMFY_NODE_IDS.negative, 0],
      latent_image: secondLatent,
    },
  };
  graph[COMFY_NODE_IDS.hiresVaeDecode] = {
    class_type: "VAEDecode",
    inputs: { samples: [COMFY_NODE_IDS.hiresKSampler, 0], vae: ctx.vae },
  };
  graph[COMFY_NODE_IDS.saveImage]!.inputs.images = [COMFY_NODE_IDS.hiresVaeDecode, 0];
  return { finalImage: [COMFY_NODE_IDS.hiresVaeDecode, 0] };
}

/** Inject the detail second pass (IF-6, comfy dialect — the
 *  ADetailer equivalent). The pick's ultralytics folder decides the arm
 *  (live-verified 0.37.0 — the provider's slot 0 is BBOX_DETECTOR, slot 1
 *  is SEGM_DETECTOR; a bbox model nulls slot 1, a segm model nulls slot 0,
 *  and every detailer's bbox_detector is required, so segm models cannot
 *  ride it): bbox/ picks feed FaceDetailer's bbox_detector (the
 *  self-contained detect → crop → low-denoise inpaint → paste); segm/
 *  picks ride the SEGS hop — SegmDetectorSEGS consumes provider slot 1,
 *  DetailerForEach consumes its SEGS. Owner ruling 2026-09-27: the full
 *  detector vocabulary is pickable, no filter — both arms built. All
 *  required inputs ride explicitly (the weight_dtype lesson); sampler
 *  knobs inherit the first pass's resolved values; denoise is the node's
 *  0.5. Mutates the passed graph and rewires SaveImage to the detailer's
 *  image output. Pure. */
export function applyComfyFaceDetailerPass(
  graph: ComfyWorkflowGraph,
  request: ImageGenGenerateRequest,
  ctx: ComfySecondPassCtx & { finalImage: [string, number]; detector: string },
): void {
  const d = COMFY_FACE_DETAILER_DEFAULTS;
  const s = COMFY_SEGM_DETECTOR_DEFAULTS;
  graph[COMFY_NODE_IDS.faceDetector] = {
    class_type: "UltralyticsDetectorProvider",
    inputs: { model_name: ctx.detector },
  };
  if (ctx.detector.replace(/\\/g, "/").startsWith("segm/")) {
    graph[COMFY_NODE_IDS.segmDetectorSegs] = {
      class_type: "SegmDetectorSEGS",
      inputs: {
        segm_detector: [COMFY_NODE_IDS.faceDetector, 1],
        image: ctx.finalImage,
        threshold: s.threshold,
        dilation: s.dilation,
        crop_factor: s.cropFactor,
        drop_size: s.dropSize,
        labels: s.labels,
      },
    };
    graph[COMFY_NODE_IDS.segmDetailer] = {
      class_type: "DetailerForEach",
      inputs: {
        image: ctx.finalImage,
        segs: [COMFY_NODE_IDS.segmDetectorSegs, 0],
        model: ctx.model,
        clip: ctx.clip,
        vae: ctx.vae,
        positive: [COMFY_NODE_IDS.positive, 0],
        negative: [COMFY_NODE_IDS.negative, 0],
        seed: ctx.seed,
        steps: ctx.adetailerSteps ?? ctx.steps,
        cfg: ctx.cfg,
        sampler_name: ctx.samplerName,
        scheduler: ctx.scheduler,
        denoise: d.denoise,
        guide_size: d.guideSize,
        guide_size_for: d.guideSizeFor,
        max_size: d.maxSize,
        feather: d.feather,
        noise_mask: d.noiseMask,
        force_inpaint: d.forceInpaint,
        wildcard: "",
        cycle: d.cycle,
      },
    };
    graph[COMFY_NODE_IDS.saveImage]!.inputs.images = [COMFY_NODE_IDS.segmDetailer, 0];
    return;
  }
  graph[COMFY_NODE_IDS.faceDetailer] = {
    class_type: "FaceDetailer",
    inputs: {
      image: ctx.finalImage,
      model: ctx.model,
      clip: ctx.clip,
      vae: ctx.vae,
      positive: [COMFY_NODE_IDS.positive, 0],
      negative: [COMFY_NODE_IDS.negative, 0],
      bbox_detector: [COMFY_NODE_IDS.faceDetector, 0],
      wildcard: "",
      seed: ctx.seed,
      steps: ctx.adetailerSteps ?? ctx.steps,
      cfg: ctx.cfg,
      sampler_name: ctx.samplerName,
      scheduler: ctx.scheduler,
      denoise: d.denoise,
      guide_size: d.guideSize,
      guide_size_for: d.guideSizeFor,
      max_size: d.maxSize,
      feather: d.feather,
      noise_mask: d.noiseMask,
      force_inpaint: d.forceInpaint,
      bbox_threshold: d.bboxThreshold,
      bbox_dilation: d.bboxDilation,
      bbox_crop_factor: d.bboxCropFactor,
      sam_detection_hint: d.samDetectionHint,
      sam_dilation: d.samDilation,
      sam_threshold: d.samThreshold,
      sam_bbox_expansion: d.samBboxExpansion,
      sam_mask_hint_threshold: d.samMaskHintThreshold,
      sam_mask_hint_use_negative: d.samMaskHintUseNegative,
      drop_size: d.dropSize,
      cycle: d.cycle,
    },
  };
  graph[COMFY_NODE_IDS.saveImage]!.inputs.images = [COMFY_NODE_IDS.faceDetailer, 0];
}

/** GET /object_info/{node} presence probe — a MISSING node answers 200
 *  with `{}` (live-verified 0.37.0), so presence = the response object
 *  carries the node-class key. A non-OK response reads as absent on this
 *  cheap probe: a genuinely broken server fails at queue time with its
 *  own error, and a capability question must not crash on it. Transport
 *  failures still throw the typed error (server unreachable). */
async function comfyNodeClassExists(
  transport: typeof fetch,
  endpoint: string,
  nodeClass: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/object_info/${encodeURIComponent(nodeClass)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "node presence probe",
  );
  if (!response.ok) return false;
  const parsed: unknown = await response.json().catch(() => null);
  return isRecord(parsed) && parsed[nodeClass] !== undefined;
}

/** The pickable detector models (the IF-6 chain discovery): the FULL
 *  UltralyticsDetectorProvider vocabulary, verbatim — no face filter, no
 *  bbox filter (owner ruling 2026-09-27; the pick's folder routes the
 *  detail arm: bbox/ → FaceDetailer, segm/ → SegmDetectorSEGS +
 *  DetailerForEach). The combo is the node's own live list (small lists
 *  come through whole — live 4-entry verification); a /models/ultralytics
 *  fallback normalizes Windows separators to the combo's forward-slash
 *  form when 0.37+ combo truncation ("COMBO") or an absent node empties
 *  the first source. */
async function fetchComfyFaceDetectors(
  transport: typeof fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await fetchComfyComboValues(transport, endpoint, "UltralyticsDetectorProvider", "model_name", signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // Node absent (the {} shape) or the combo truncated — the folder
    // fallback below is the second source, never a silent empty.
    names = [];
  }
  if (names.length === 0) {
    names = (await fetchComfyFolderNames(transport, endpoint, "ultralytics", signal)).map((name) =>
      name.replace(/\\/g, "/"),
    );
  }
  // The FULL detector vocabulary, verbatim (owner ruling 2026-09-27: no
  // face filter, no bbox filter) — the builder wires BOTH arms: bbox/
  // picks ride FaceDetailer's bbox_detector, segm/ picks ride the
  // SegmDetectorSEGS → DetailerForEach hop. The chosen detector defines
  // what the pass details (a face model details faces, a hand model
  // details hands).
  return names;
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
  onJobStarted?: () => void,
): ComfyProgressListener {
  let promptId: string | undefined;
  const buffer: string[] = [];
  let dead = false;
  // MR-11: the first step event attributed to THIS run's prompt_id flips
  // the phase registry to "steps" — exactly once, no matter how many
  // buffered events replay at bind time.
  let jobAnnounced = false;

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
        if (!jobAnnounced) {
          jobAnnounced = true;
          onJobStarted?.();
        }
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

// ─── Model family ladder (CG-A3) ────────────────────────────────────

// Shared with the A1111 dialect since FT-A4: the family buckets and the
// embedded-metadata field precedence are ecosystem facts — one definition
// in model-family.ts keeps cross-dialect filter keys identical. The
// legacy export name stays for the pinned test surface.
export { normalizeModelFamily as normalizeComfyFamily } from "../model-family.js";
import { readEmbeddedFamilyValue, normalizeModelFamily } from "../model-family.js";

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
  return readEmbeddedFamilyValue(parsed);
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

/** IPT-3 detection twin of fetchComfyEmbeddedFamily: a 404 IS the honest
 *  no-label answer (the installed core's /view_metadata 404s when the
 *  safetensors header carries no `__metadata__` — server.py returns 404
 *  by design there), so it resolves undefined; every OTHER failure
 *  (non-404 status, transport, unparseable 200 body) THROWS the typed
 *  error so the ladder records the real reason at source (a). The
 *  listing twin keeps its silent degradation — both behaviors are
 *  intentional, one per consumer. */
async function fetchComfyEmbeddedFamilyForDetection(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(name)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "model metadata",
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ComfyImageGenError(
      `ComfyUI model metadata failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!isRecord(parsed)) {
    throw new ComfyImageGenError("ComfyUI /view_metadata response was not a JSON object");
  }
  return readEmbeddedFamilyValue(parsed);
}

/** IPT-3 detection twin of fetchComfyFolderRoots: a 404 is the structural
 *  no-anchor answer (hardened remotes legitimately expose no folder map —
 *  roots stay absent); every other failure returns its REASON so the
 *  reader records it on `sidecarError` and source (b) tells the real
 *  story instead of the structural "no path exposed" text. */
async function fetchComfyFolderRootsForDetection(
  transport: typeof fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<{ roots?: Record<string, string[]>; error?: string }> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/internal/folder_paths`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "folder map",
    );
    if (response.status === 404) return {};
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      return {
        error: `ComfyUI folder map failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      };
    }
    parsed = await response.json().catch(() => null);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      error: `ComfyUI folder map fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { error: "ComfyUI /internal/folder_paths response was not a JSON object" };
  }
  const out: Record<string, string[]> = {};
  for (const [folder, roots] of Object.entries(parsed)) {
    if (Array.isArray(roots)) {
      const clean = roots.filter((root): root is string => typeof root === "string" && root.length > 0);
      if (clean.length > 0) out[folder] = clean;
    }
  }
  return { roots: out };
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
  const embedded = normalizeModelFamily(
    await fetchComfyEmbeddedFamily(transport, endpoint, options.folder, options.name, options.signal),
  );
  if (embedded !== undefined) return embedded;
  const roots = (await options.rootsOf())?.[options.folder] ?? [];
  if (roots.length === 0) return undefined;
  for (const store of COMFY_SIDECAR_STORES) {
    const raw = await readComfySidecarFamily(roots, options.name, store.suffix, store.field);
    const normalized = normalizeModelFamily(raw);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/** Trigger-word sidecar stores, in precedence order (CG-C2, live-verified
 *  on the owner's install 2026-09-18): `.cm-info.json` `TrainedWords`
 *  (Stability Matrix's mirror — populated on civitai imports, null on
 *  manual adds) before `.civitai.info` `trainedWords` (the download
 *  flow's own store). No embedded rung: kohya's `ss_tag_frequency` is a
 *  frequency heuristic the owner's leading lora doesn't even carry —
 *  deliberately out (recorded, CG-C3 decision log). */
const COMFY_LORA_TRIGGER_STORES = [
  { suffix: ".cm-info.json", field: "TrainedWords" },
  { suffix: ".civitai.info", field: "trainedWords" },
] as const;

/** Read one sidecar store's trigger-word array off the local disk — the
 *  same stem/subfolder join as the family store. A missing field, wrong
 *  shape, or all-empty strings returns undefined (the ladder continues);
 *  entries are kept VERBATIM (civitai comma-phrases included). */
async function readComfySidecarTriggerWords(
  roots: readonly string[],
  name: string,
  suffix: string,
  field: string,
): Promise<string[] | undefined> {
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
        if (Array.isArray(raw)) {
          const words = raw.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
            .map((w) => w.trim());
          if (words.length > 0) return words;
        }
      }
    } catch {
      // Missing or unparseable sidecar — the ladder's next root/store.
      continue;
    }
  }
  return undefined;
}

/** Resolve one lora's activation words through the sidecar stores (CG-C2):
 *  cm-info → civitai.info → [] (none found). Silent per-store degradation;
 *  only the caller's abort propagates. No transport — the stores are read
 *  off the local disk through the lazily-fetched folder roots. */
async function resolveComfyLoraTriggers(options: {
  name: string;
  signal: AbortSignal | undefined;
  rootsOf: () => Promise<Record<string, string[]> | undefined>;
}): Promise<string[]> {
  const roots = (await options.rootsOf())?.["loras"] ?? [];
  if (roots.length === 0) return [];
  for (const store of COMFY_LORA_TRIGGER_STORES) {
    const words = await readComfySidecarTriggerWords(roots, options.name, store.suffix, store.field);
    if (words !== undefined) return words;
  }
  return [];
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
      // LoRA validation (CG-C2): every enabled lora must exist in the live
      // LoraLoader combo — the model-list precedent (fail closed naming the
      // entry, never a queue-time node_errors blob). Skipped entirely when
      // the run carries no loras (zero extra calls on the common path).
      const loras = request.loras ?? [];
      if (loras.length > 0) {
        const loraNames = await fetchComfyComboValues(
          cfg.fetch,
          cfg.endpoint,
          "LoraLoader",
          "lora_name",
          request.signal,
        );
        for (const lora of loras) {
          if (!loraNames.includes(lora.name)) {
            throw new ComfyImageGenConfigError(
              `ComfyUI lora "${lora.name}" is not in the loras folder — reselect it from the lora list`,
            );
          }
        }
      }
      // A sampler-set workflow pick is authoritative over both the legacy
      // prompt-family pin and metadata detection. Without any manual pick,
      // the existing loader-folder + CG-A3 ladder remains byte-identical.
      const manualSpec = request.workflowFamily === undefined
        ? undefined
        : resolveComfyManualWorkflowTemplate(request.workflowFamily);
      const pinnedSpec = manualSpec === undefined && request.promptFamilyOverride !== undefined
        ? resolveComfyPinnedTemplate(request.promptFamilyOverride)
        : undefined;
      const checkpointNames = manualSpec === undefined && pinnedSpec === undefined
        ? await fetchComfyComboValues(
          cfg.fetch,
          cfg.endpoint,
          "CheckpointLoaderSimple",
          "ckpt_name",
          request.signal,
        )
        : [];
      const pinnedDitSpec = pinnedSpec !== undefined && isComfyPinnedDitTemplate(pinnedSpec)
        ? pinnedSpec
        : undefined;
      let template: (typeof COMFY_MODEL_TEMPLATES)[keyof typeof COMFY_MODEL_TEMPLATES];
      let graph: ComfyWorkflowGraph;
      let secondPassCtx: ComfySecondPassCtx;
      if (
        manualSpec === COMFY_TEMPLATE_SPECS.checkpoint ||
        (manualSpec === undefined && (pinnedSpec === COMFY_TEMPLATE_SPECS.checkpoint || checkpointNames.includes(model)))
      ) {
        ({ graph, ctx: secondPassCtx } = buildComfyCheckpointWorkflow(request, model));
        template = COMFY_MODEL_TEMPLATES.checkpoint;
      } else {
        let spec: ComfyDitTemplateSpec;
        if (manualSpec !== undefined) {
          if (!isComfyPinnedDitTemplate(manualSpec)) {
            throw new ComfyImageGenConfigError(`ComfyUI workflow family "${request.workflowFamily}" has no DiT template`);
          }
          spec = manualSpec;
        } else if (pinnedDitSpec !== undefined) {
          spec = pinnedDitSpec;
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
          // Reuse the CG-A3 metadata ladder for auto routing. Its embedded
          // metadata and sidecar stores are authoritative; no filename guess
          // can select a workflow graph.
          let folderRoots: Record<string, string[]> | undefined;
          let folderRootsFetched = false;
          const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
            if (!folderRootsFetched) {
              folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, request.signal);
              folderRootsFetched = true;
            }
            return folderRoots;
          };
          const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
            folder: "diffusion_models",
            name: model,
            signal: request.signal,
            rootsOf,
          });
          spec = resolveComfyAutoDiffusionTemplate(family, model);
        }
        const listFolder = (folder: string, signal: AbortSignal | undefined) =>
          fetchComfyFolderNames(cfg.fetch, cfg.endpoint, folder, signal);
        const createConfigError = (message: string) => new ComfyImageGenConfigError(message);
        const encoder = await resolveComfySidecar(
          {
            folder: "text_encoders",
            explicit: request.encoderName,
            canonical: spec.canonicalEncoder,
            canonicalAliases: spec.canonicalEncoderAliases,
            pairedStem: model,
            what: "text encoder",
            signal: request.signal,
            listFolder,
            createConfigError,
          },
          spec,
        );
        const secondaryEncoder = spec.canonicalSecondaryEncoder === undefined
          ? undefined
          : await resolveComfySidecar(
            {
              folder: "text_encoders",
              explicit: undefined,
              canonical: spec.canonicalSecondaryEncoder,
              pairedStem: undefined,
              what: "second text encoder",
              signal: request.signal,
              listFolder,
              createConfigError,
            },
            spec,
          );
        const vae = await resolveComfySidecar(
          {
            folder: "vae",
            explicit: request.vaeName,
            canonical: spec.canonicalVae,
            canonicalAliases: spec.canonicalVaeAliases,
            pairedStem: undefined,
            what: "VAE",
            signal: request.signal,
            listFolder,
            createConfigError,
          },
          spec,
        );
        if (spec === COMFY_TEMPLATE_SPECS.krea2Dit || spec === COMFY_TEMPLATE_SPECS.animaDit) {
          ({ graph, ctx: secondPassCtx } = buildComfyKrea2Workflow(request, { unet: model, encoder, vae }, spec));
        } else {
          ({ graph, ctx: secondPassCtx } = buildComfyDitWorkflow(
            request,
            { unet: model, encoder, vae, ...(secondaryEncoder !== undefined ? { secondaryEncoder } : {}) },
            spec,
          ));
          if (
            spec.workflowShape === COMFY_DIT_WORKFLOW_SHAPES.FluxSchnell &&
            (request.hires !== undefined || request.adetailer === true)
          ) {
            throw new ComfyImageGenConfigError(
              "ComfyUI FLUX.1-schnell's stock workflow has no negative conditioning, so hires and face detailing are unavailable",
            );
          }
        }
        template = comfyTemplateMarker(spec);
      }

      // Hires second pass (FT-A4 flat field, comfy dialect): a NAMED
      // upscaler is validated against the live upscale_models folder (the
      // lora fail-closed precedent — reselect, never a queue-time blob);
      // unset (the chip's Auto) takes the latent path with no extra call.
      let finalImage: [string, number] = [COMFY_NODE_IDS.vaeDecode, 0];
      if (request.hires !== undefined) {
        const upscaler = setOrUndefined(request.hires.upscaler);
        if (upscaler !== undefined) {
          const upscalerNames = await fetchComfyFolderNames(
            cfg.fetch,
            cfg.endpoint,
            "upscale_models",
            request.signal,
          );
          if (!upscalerNames.includes(upscaler)) {
            throw new ComfyImageGenConfigError(
              `ComfyUI upscaler "${upscaler}" is not in the upscale_models folder — reselect it from the hires upscaler list`,
            );
          }
        }
        finalImage = applyComfyHiresPass(graph, request, secondPassCtx).finalImage;
      }
      // Face detailing (IF-6, comfy dialect — the ADetailer equivalent):
      // the request boolean is the ONLY switch (owner defect report
      // 2026-09-27: toggle OFF + a configured detector name still ran the
      // second pass — the name is configured-but-DISABLED state, the hires
      // pattern, never an activator); the model is the EXPLICIT pick or
      // this dialect's own default — the live list's FIRST entry (the pane
      // control's fallback mirror), never a cross-dialect constant. The
      // Impact Pack FaceDetailer node must exist (honest config error
      // naming the pack, never a queue-time blob) and an explicit pick
      // must be in the discovered face list (the lora fail-closed
      // precedent).
      const faceDetectorExplicit = setOrUndefined(request.adetailerModel);
      if (request.adetailer === true) {
        if (!(await comfyNodeClassExists(cfg.fetch, cfg.endpoint, "FaceDetailer", request.signal))) {
          throw new ComfyImageGenConfigError(
            "ComfyUI face detailing requires the Impact Pack — the FaceDetailer node was not found on the server",
          );
        }
        const detectors = await fetchComfyFaceDetectors(cfg.fetch, cfg.endpoint, request.signal);
        const faceDetector = faceDetectorExplicit ?? detectors[0];
        if (faceDetector === undefined || !detectors.includes(faceDetector)) {
          const candidates =
            detectors.length === 0
              ? "no face bbox models were found in the ultralytics folder"
              : `available: ${detectors.slice(0, 5).join(", ")}${detectors.length > 5 ? ", …" : ""}`;
          throw new ComfyImageGenConfigError(
            `ComfyUI detector "${faceDetector ?? "(unset)"}" is not in the discovered list (${candidates}) — reselect it from the detector list`,
          );
        }
        applyComfyFaceDetailerPass(graph, request, { ...secondPassCtx, finalImage, detector: faceDetector });
      }

      const clientId = crypto.randomUUID();
      // The WS live-progress listener (CG-C1): opened BEFORE the prompt is
      // queued so no early event is missed, held through execution, closed
      // at run end. Best-effort — its failure never fails the run.
      const listener = openComfyProgressListener(cfg.endpoint, clientId, cfg.openWebSocket, request.onJobStarted);
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

        // MR-11: a fresh run must not inherit the previous run's terminal
        // 100% — the reset lands BEFORE the bind replays buffered events, so
        // pre-queue frames still win (the queue/model-load span otherwise
        // reads "starting", never a stale percent).
        comfyRunSnapshots.set(cfg.endpoint, { promptId, progress: 0 });
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
      const result: ImageGenGenerateResult = { images, seed: secondPassCtx.seed, resolvedTemplate: template };
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
          const label = comfyWeightsBasename(name);
          const resolvedTemplate = folder === "diffusion_models"
            ? resolveComfyListedDiffusionTemplate(family)
            : template;
          entries.push({
            id: name,
            label: label.length > 0 ? label : name,
            ...(family !== undefined ? { family } : {}),
            ...(resolvedTemplate !== undefined ? { template: resolvedTemplate } : {}),
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

    async listUpscalers(signal?: AbortSignal): Promise<ImageGenUpscalerInfo[]> {
      // The hires-upscaler vocabulary (FT-A4, comfy dialect): the live
      // upscale_models folder (the /models route — the per-node combo is
      // combo-truncated on 0.37+, the checkpoints-list precedent's source).
      // The chip's Auto ("") is the LATENT path — adapter-side, no entry.
      const names = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "upscale_models", signal);
      return names.map((name) => ({ name }));
    },

    async listVae(signal?: AbortSignal): Promise<string[]> {
      // IF-7b: the live vae folder — the SAME catalog the DiT sidecar
      // resolver uses; here it feeds the checkpoint template's VAE-swap
      // field too (one folder, both templates' vocabulary).
      return fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "vae", signal);
    },

    async listFaceDetectors(signal?: AbortSignal): Promise<string[]> {
      // The IF-6 chain probe: BOTH links must hold — the Impact Pack's
      // FaceDetailer node exists AND the ultralytics folder/combo carries
      // at least one face bbox model. Either miss = [] (the honest
      // unavailable signal the picker gates on).
      if (!(await comfyNodeClassExists(cfg.fetch, cfg.endpoint, "FaceDetailer", signal))) return [];
      return fetchComfyFaceDetectors(cfg.fetch, cfg.endpoint, signal);
    },

    async listLoras(signal?: AbortSignal): Promise<ImageGenLoraInfo[]> {
      // The lora list (CG-C2): names from the live LoraLoader combo (what
      // ComfyUI itself validates at queue time), family through the SAME
      // three-store ladder as models (folder "loras"), NULL = the ladder
      // found nothing (the chip's unknown-family bucket — never a guess).
      const names = await fetchComfyComboValues(
        cfg.fetch,
        cfg.endpoint,
        "LoraLoader",
        "lora_name",
        signal,
      );
      let folderRoots: Record<string, string[]> | undefined;
      let folderRootsFetched = false;
      const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
        if (!folderRootsFetched) {
          folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, signal);
          folderRootsFetched = true;
        }
        return folderRoots;
      };
      const entries: ImageGenLoraInfo[] = [];
      for (const name of names) {
        const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
          folder: "loras",
          name,
          signal,
          rootsOf,
        });
        // Activation words (owner-directed pull-forward 2026-09-18): the
        // sidecar stores only — discovered, never hardcoded.
        const triggerWords = await resolveComfyLoraTriggers({
          name,
          signal,
          rootsOf,
        });
        entries.push({ name, family: family ?? null, triggerWords });
      }
      return entries;
    },

    async readModelDetectionMetadata(
      model: string,
      signal?: AbortSignal,
    ): Promise<ImageGenModelDetectionMetadata> {
      // IPT-3 source (a): locate the model's folder (the listModels union
      // walk for ONE model — /models/checkpoints before
      // /models/diffusion_models, the common sync-checkpoint case first),
      // then read the embedded safetensors `__metadata__` through the
      // backend's own /view_metadata surface (authoritative trainer
      // truth). Core ComfyUI exposes NO hash — the Civitai source's
      // anchor stays absent on this dialect (an honest miss).
      //
      // Failure honesty (IPT-3 review): the DETECTION twins below THROW
      // or carry reasons — the listing helpers' silent degradation stays
      // for the picker/list paths it was built for. /view_metadata 404 IS
      // the honest no-label answer (the installed core 404s when the
      // header carries no __metadata__); /internal/folder_paths 404 is
      // the structural no-anchor answer (hardened remotes); anything
      // else records the real reason at the source it failed.
      const checkpointNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "checkpoints", signal);
      const folder = checkpointNames.includes(model)
        ? "checkpoints"
        : (await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "diffusion_models", signal)).includes(model)
          ? "diffusion_models"
          : undefined;
      if (folder === undefined) {
        throw new ComfyImageGenConfigError(
          `ComfyUI model "${model}" is in neither the checkpoints nor the diffusion-models folder — reselect it from the model list`,
        );
      }
      const metadata: ImageGenModelDetectionMetadata = {};
      // Embedded read: a non-abort failure is CARRIED (metadataError),
      // not thrown — the folder-map anchor below stays obtainable for
      // source (b) even when /view_metadata itself errored, and the
      // rethrow-at-the-end pattern would discard it (the ladder drops
      // metadata on a reader throw).
      let embeddedError: Error | undefined;
      try {
        const embedded = await fetchComfyEmbeddedFamilyForDetection(
          cfg.fetch,
          cfg.endpoint,
          folder,
          model,
          signal,
        );
        if (embedded !== undefined) metadata.baseModel = embedded;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        embeddedError = error instanceof Error ? error : new Error(String(error));
      }
      // Sidecar join anchor: the folder roots the backend itself reports
      // via /internal/folder_paths (officially frontend-only — a bonus
      // source). Fetched EAGERLY: an embedded label that maps is the
      // common short-circuit, but an embedded miss OR an unmappable
      // embedded label (e.g. a bare SDXL architecture stamp) must still
      // let the sidecar source run — the ladder's correctness beats
      // saving one localhost round-trip. A failed map fetch records its
      // reason on sidecarError so source (b) tells the real story.
      const folderMap = await fetchComfyFolderRootsForDetection(cfg.fetch, cfg.endpoint, signal);
      if (folderMap.error !== undefined) {
        metadata.sidecarError = folderMap.error;
      } else {
        const roots = folderMap.roots?.[folder] ?? [];
        if (roots.length > 0) metadata.sidecar = { roots, relativeName: model };
      }
      if (embeddedError !== undefined) {
        metadata.metadataError = `backend metadata read failed: ${embeddedError.message}`;
      }
      return metadata;
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
