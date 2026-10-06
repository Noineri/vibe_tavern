/**
 * NovelAI image capability row (NOVELAI_PROVIDER_PLAN NAI-5a).
 *
 * Extracted from imagegen-capabilities.ts for the file-size ratchet; the
 * parent capability table remains the single consumer-facing data source.
 */

import type { ImageGenCapabilityFlags } from "./entities.js";

/** Research Finding 3 (NovelAI web client bundle
 * `_app-a70b21aef518ab63.js`, 2026-10-05): native JSON image generation
 * accepts negative prompts, samplers, seed, steps, CFG scale, and free
 * width/height; no edit/inpaint, live-progress, or local arm. */
export const NOVELAI_IMAGE_GEN_CAPABILITIES: ImageGenCapabilityFlags = {
  supportsNegativePrompt: true,
  supportsSamplers: true,
  supportsSeed: true,
  supportsSteps: true,
  supportsCfgScale: true,
  sizeSupport: { kind: "free" },
  noApiKey: false,
  supportsLiveProgress: false,
  localExecution: false,
  supportsImg2img: false,
  supportsInpaint: false,
  paramRanges: {},
  // NAI-6a: NovelAI models prompt in NovelAI's tag dialect by default —
  // the backend-default tier of the generation-time family resolution
  // (prompt-family-resolution.ts). Locator: this row physically lives here
  // since the NAI-5a ratchet extraction; imagegen-capabilities.ts imports it.
  defaultPromptFamily: "novelai",
};
