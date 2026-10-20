/**
 * @module imagegen/backends/comfyui-second-passes
 *
 * The ComfyUI second-pass subgraphs — moved out of comfyui.ts (IG-R2):
 * the hires-fix and face-detailer graphs injected into a built template
 * graph, and the Impact Pack chain discovery (node presence probe +
 * detector vocabulary) the passes gate on.
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

import type { ImageGenGenerateRequest } from "../imagegen-backend.js";

import { fetchOrWrap, setOrUndefined } from "./backend-helpers.js";
import { ComfyImageGenError } from "./comfyui-errors.js";
import { COMFY_NODE_IDS } from "./comfyui-workflows.js";
import type { ComfySecondPassCtx, ComfyWorkflowGraph } from "./comfyui-workflows.js";
import { fetchComfyComboValues, fetchComfyFolderNames, isObjectLike } from "./comfyui-listing.js";

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
export async function comfyNodeClassExists(
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
    "ComfyUI image-gen",
    ComfyImageGenError,
  );
  if (!response.ok) return false;
  const parsed: unknown = await response.json().catch(() => null);
  return isObjectLike(parsed) && parsed[nodeClass] !== undefined;
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
export async function fetchComfyFaceDetectors(
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
