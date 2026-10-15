/**
 * OpenAI-images capability rows — the OpenAI preset (`openai-images`) and its
 * Custom arm (`openai-images-custom`, IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT
 * step 9).
 *
 * Extracted from imagegen-capabilities.ts for the file-size ratchet (the
 * NovelAI-row precedent); the parent capability table remains the single
 * consumer-facing data source.
 */

import type { ImageGenCapabilityFlags } from "./entities.js";

/** POST /v1/images/generations: prompt/size only in our v1 arm — no
 *  negative prompt, no steps/seed/sampler surface; sizes are the card's
 *  GPT Image grid. */
export const OPENAI_IMAGES_CAPABILITIES: ImageGenCapabilityFlags = {
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
};

/** The Custom arm of the OpenAI-images dialect: a bare user endpoint has no
 *  card, so no grid is guessed — the user's W×H rides verbatim as the
 *  `size` string (owner ruling 2026-10-15). Otherwise the OpenAI row's
 *  prompt/size-only surface. */
export const OPENAI_IMAGES_CUSTOM_CAPABILITIES: ImageGenCapabilityFlags = {
  ...OPENAI_IMAGES_CAPABILITIES,
  sizeSupport: { kind: "free" },
};
