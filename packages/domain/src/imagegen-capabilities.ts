/**
 * Static image-gen backend capability table (IMAGE_GENERATION_PLAN IG-4/IG-11).
 *
 * Pure data, no I/O — the WEB-SAFE source of truth for what each image-gen
 * backend supports. Lives in the domain leaf (the STT/TTS preset-table
 * precedent: `stt-presets.ts`) because the Providers editor (apps/web)
 * snapshots it onto profiles on create/backend-switch (the create contract
 * carries the capability mirror) and renders capability-gated controls from
 * it without a live round-trip — importing it from services/api would drag
 * the server barrel (db, bun:sqlite) into the browser bundle. The backend
 * FACTORY registry stays in services/api (`imagegen-registry.ts`) and
 * re-exports this table so API-side consumers have one import path.
 *
 * The flags describe OUR integration surface, not raw vendor potential.
 * The vendor-set size lists are the vendors' documented grids verbatim
 * (research-report cards, doc-verified 2026-09-07): OpenRouter documents
 * aspect ratios with pixel grids for six of them — the adapter maps a
 * selected W×H back onto the exact ratio string via this same table (the
 * other ratios exist upstream but carry no documented pixel grid, so they
 * are not offered); the OpenAI-images protocol's GPT Image grid is
 * 1024x1024 / 1536x1024 / 1024x1536 (arbitrary W×H exists on gpt-image-2
 * only — not assumed for Custom endpoints).
 */

import { IMAGE_GEN_BACKENDS } from "./entities.js";
import type { ImageGenBackendType, ImageGenCapabilityFlags, ImageGenParamRange } from "./entities.js";

/** Global default slider ranges for the advanced numeric params
 *  (IMAGE_GENERATION_PLAN IG-CF5) — the single named constants block both
 *  the editor pane and its tests import (no scattered literals): steps
 *  1–150 step 1, CFG 1–30 step 0.5, CLIP-skip 1–12 step 1. Per-backend
 *  overrides (currently all empty — no vendor publishes limits) live on
 *  each row's `paramRanges` and win over these when present. LoRA strength
 *  (CG-C3): 0–2 step 0.05 — the FT-A5 single-slider range (0 mutes, 1 the
 *  trained weight, 2 exaggeration) feeding both strength_model and
 *  strength_clip on ComfyUI. */
export const IMAGE_GEN_PARAM_RANGES: Record<
  "steps" | "cfgScale" | "clipSkip" | "loraStrength",
  ImageGenParamRange
> = {
  steps: { min: 1, max: 150, step: 1 },
  cfgScale: { min: 1, max: 30, step: 0.5 },
  clipSkip: { min: 1, max: 12, step: 1 },
  loraStrength: { min: 0, max: 2, step: 0.05 },
};

/** ADetailer face-model presets (IG-CF15/PG-4 v1) — the extension's own
 *  README face-model table verbatim (Bing-su/adetailer, the 2D/realistic
 *  face rows + the bundled mediapipe faces; hand/person models are out of
 *  the v1 face-fix scope). The first entry is the preset default; the
 *  ultralytics .pt files must exist in the server's models/adetailer dir
 *  (the extension's download button), the mediapipe faces need nothing. */
export const IMAGE_GEN_ADETAILER_FACE_MODELS = [
  "face_yolov8n.pt",
  "face_yolov8s.pt",
  "mediapipe_face_full",
  "mediapipe_face_short",
  "mediapipe_face_mesh",
] as const;

/** The face-model preset sent when the overlay enables ADetailer without
 *  picking a model (the UI default = the extension's commonly shipped
 *  lightweight face detector). */
export const IMAGE_GEN_ADETAILER_DEFAULT_MODEL: (typeof IMAGE_GEN_ADETAILER_FACE_MODELS)[number] =
  IMAGE_GEN_ADETAILER_FACE_MODELS[0];

/** Match an A1111 `/sdapi/v1/extensions` entry name against the ADetailer
 *  extension (case-insensitive substring — the family's dirnames vary:
 *  `adetailer`, `sd-webui-adetailer`, forks). */
export function hasAdetailerExtension(names: readonly string[]): boolean {
  return names.some((name) => name.toLowerCase().includes("adetailer"));
}

export const IMAGE_GEN_BACKEND_CAPABILITIES: Record<ImageGenBackendType, ImageGenCapabilityFlags> = {
  [IMAGE_GEN_BACKENDS.OpenRouter]: {
    // Chat-completions transport (modalities), no negative/steps/seed/sampler
    // surface — per the OpenRouter card.
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: {
      kind: "vendor-set",
      // Documented pixel grids from the OpenRouter card (ratio → W×H):
      // 1:1, 2:3, 3:4, 9:16, 16:9, 21:9. Ratios without a documented grid
      // (3:2, 4:3, 4:5, 5:4) are NOT offered — no invented values.
      sizes: [
        "1024x1024",
        "832x1248",
        "864x1184",
        "768x1344",
        "1344x768",
        "1536x672",
      ],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
  },
  [IMAGE_GEN_BACKENDS.OpenAiImages]: {
    // POST /v1/images/generations: prompt/size only in our v1 arm — no
    // negative prompt, no steps/seed/sampler surface.
    supportsNegativePrompt: false,
    supportsSamplers: false,
    supportsSeed: false,
    sizeSupport: {
      kind: "vendor-set",
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
    },
    noApiKey: false,
    supportsLiveProgress: false,
    localExecution: false,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
  },
  [IMAGE_GEN_BACKENDS.A1111]: {
    // /sdapi/v1/txt2img: full param surface — negative prompt, samplers
    // (GET /samplers), seed (reported back), free W×H integers, live
    // GET /progress. Keyless by default (--api-auth optional).
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: true,
    supportsLiveProgress: true,
    localExecution: true,
    supportsImg2img: false,
    supportsInpaint: false,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
  },
  [IMAGE_GEN_BACKENDS.ComfyUI]: {
    // Raw ComfyUI API (COMFYUI_BACKEND_PLAN CG-A1..A3, C1, C2): flat form mapped
    // onto workflow templates — negative prompt, seed resolved client-side
    // and reported back, free W×H integers, live KSampler sampler/scheduler
    // unions (CG-A3). Keyless (core has no auth). WS step-bar progress +
    // POST /interrupt landed with CG-C1 (the a1111 progress-pill twin).
    // LoRAs landed with CG-C2: listLoras rides the family ladder, generate
    // threads enabled loras as LoraLoader nodes.
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: true,
    supportsLiveProgress: true,
    localExecution: true,
    supportsImg2img: false,
    supportsInpaint: false,
    supportsLoras: true,
    paramRanges: {}, // IG-CF5: empty = global defaults (no vendor publishes limits yet)
  },
};
