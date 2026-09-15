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
 *  each row's `paramRanges` and win over these when present. */
export const IMAGE_GEN_PARAM_RANGES: Record<"steps" | "cfgScale" | "clipSkip", ImageGenParamRange> = {
  steps: { min: 1, max: 150, step: 1 },
  cfgScale: { min: 1, max: 30, step: 0.5 },
  clipSkip: { min: 1, max: 12, step: 1 },
};

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
};
