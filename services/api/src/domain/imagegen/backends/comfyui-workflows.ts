/**
 * @module imagegen/backends/comfyui-workflows
 *
 * The ComfyUI workflow-graph BUILDERS — moved out of comfyui.ts (IG-R2):
 * the flat generation request mapped onto ComfyUI node graphs (node
 * ids, the LoRA chain, node-class defaults, template resolution, and
 * the checkpoint / Krea-2 / DiT graph builders). The template SPECS
 * stay in comfy-workflow-templates.ts beside this module: specs are
 * data, this module builds graphs from them.
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
 * Template wire facts and a1111 deviations carried verbatim from
 * comfyui.ts's doc gate (every fact live-verified — see there):
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
 * - NO server-side parameter defaults: a workflow graph must carry values
 *   for every required KSampler/EmptyLatent input, so an unset field
 *   materializes the NODE-CLASS DEFAULT exactly as the server's own
 *   /object_info declares it (steps 20, cfg 8, sampler "euler", scheduler
 *   "normal", latent 512×512, denoise 1 — live-verified constants, the
 *   comfy equivalent of a1111's "omit and the server fills").
 * - seed -1 / unset resolves IN THE ADAPTER (client-side random ≤
 *   MAX_SAFE_INTEGER): ComfyUI has no -1 sentinel. The resolved value is
 *   reported back as `result.seed` — we authored it, so it is exact.
 * - clipSkip >= 2 rides `CLIPSetLastLayer.stop_at_clip_layer = -clipSkip`
 *   (ComfyUI counts from the end; the node is OMITTED for clipSkip 1 or
 *   unset — no silent layer-slicing).
 * - krea2 FORM DEFAULTS stay FORM-side (CF5, owner decision): a bare API
 *   request with unset steps/cfg gets the NODE-CLASS defaults (20/8/…)
 *   for BOTH templates — the Krea-2 family's sane starting point
 *   (steps 8, cfg 1, euler/simple) ships as EXPLICIT form values in
 *   CG-B1, never as a hidden server-side second default ladder.
 */

import type { ImageGenGenerateRequest } from "../imagegen-backend.js";

import {
  COMFY_DIT_WORKFLOW_SHAPES,
  COMFY_TEMPLATE_SPECS,
} from "./comfy-workflow-templates.js";
import type { ComfyDitTemplateSpec } from "./comfy-workflow-templates.js";

import { requirePositiveInt, setOrUndefined } from "./backend-helpers.js";
import { ComfyImageGenConfigError, ComfyImageGenSizeError } from "./comfyui-errors.js";

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
  cfgRescale: "16",
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
type ComfyManualDitTemplateSpec = Exclude<ComfySelectedTemplateSpec, typeof COMFY_TEMPLATE_SPECS.checkpoint>;

export function isComfyManualDitTemplate(
  spec: ComfySelectedTemplateSpec,
): spec is ComfyManualDitTemplateSpec {
  return spec !== COMFY_TEMPLATE_SPECS.checkpoint;
}

/** Map a sampler-set manual workflow pick to its ComfyUI template.
 * The executor checks this before profile prompt pins and metadata so an
 * explicit set is authoritative. The string parameter deliberately remains
 * runtime-wide: direct adapter callers bypass the Zod route boundary. */
export function resolveComfyManualWorkflowTemplate(family: string): ComfySelectedTemplateSpec {
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
export function comfyTemplateMarker(spec: ComfyDitTemplateSpec): (typeof COMFY_MODEL_TEMPLATES)[keyof typeof COMFY_MODEL_TEMPLATES] {
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
export function resolveComfyAutoDiffusionTemplate(
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
      `ComfyUI model "${model}" has no detected family — pick its base workflow with a sampler set`,
    );
  }
  throw new ComfyImageGenConfigError(
    `ComfyUI model "${model}" resolves to the "${family}" family, which has no workflow template yet`,
  );
}

/** The listing marker mirrors only metadata-resolved diffusion templates. */
export function resolveComfyListedDiffusionTemplate(family: string | undefined): string | undefined {
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
function applyComfyCfgRescale(
  graph: ComfyWorkflowGraph,
  model: [string, number],
  cfgRescale: number | undefined,
): [string, number] {
  if (cfgRescale === undefined || cfgRescale <= 0) return model;
  graph[COMFY_NODE_IDS.cfgRescale] = {
    class_type: "RescaleCFG",
    inputs: { model, multiplier: cfgRescale },
  };
  const rescaled: [string, number] = [COMFY_NODE_IDS.cfgRescale, 0];
  graph[COMFY_NODE_IDS.kSampler]!.inputs.model = rescaled;
  return rescaled;
}

function buildComfyCommonNodes(
  request: ImageGenGenerateRequest,
  refs: { model: [string, number]; clip: [string, number] },
): { graph: ComfyWorkflowGraph; resolved: ComfySamplerResolved } {
  const seed = resolveComfySeed(request.seed);
  const width =
    request.width !== undefined
      ? requirePositiveInt(
          "width",
          request.width,
          "ComfyUI image generation",
          ComfyImageGenSizeError,
        )
      : undefined;
  const height =
    request.height !== undefined
      ? requirePositiveInt(
          "height",
          request.height,
          "ComfyUI image generation",
          ComfyImageGenSizeError,
        )
      : undefined;
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
  const modelRef = applyComfyCfgRescale(graph, chain.model, request.cfgRescale);
  return {
    graph,
    seed: resolved.seed,
    ctx: {
      model: modelRef,
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
  const modelRef = applyComfyCfgRescale(graph, chain.model, request.cfgRescale);
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

  modelRef = applyComfyCfgRescale(graph, modelRef, request.cfgRescale);

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
