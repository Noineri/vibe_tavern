import type { ScalarSliderField } from "../../lib/imagegen/model-controls.js";

/** The settings block's pinned slider test ids preserve the legacy inline-row seams. */
export const IMAGE_GEN_SLIDER_RANGE_TESTIDS: Record<ScalarSliderField, string> = {
  steps: "image-gen-range-overlay-steps",
  cfgScale: "image-gen-range-overlay-cfg",
  cfgRescale: "image-gen-range-overlay-cfg-rescale",
  clipSkip: "image-gen-range-overlay-clip",
};
