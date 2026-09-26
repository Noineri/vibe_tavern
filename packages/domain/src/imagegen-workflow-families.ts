/**
 * ComfyUI base-workflow families selected manually through image-gen sampler
 * sets. Prompt family remains a separate axis.
 */
export const IMAGE_GEN_WORKFLOW_FAMILY_IDS = [
  "qwen-image-2.1",
  "qwen-image",
  "z-image",
  "flux-dev",
  "flux-schnell",
  "krea2-dit",
  "anima-dit",
  "checkpoint",
] as const;

export type ImageGenWorkflowFamilyId = (typeof IMAGE_GEN_WORKFLOW_FAMILY_IDS)[number];

/** CFG-1-only families hide the editable CFG control while their set value
 * still ships. Flux dev stays editable despite its seeded cfg 1 because it
 * supports guidance; Krea2 Turbo/RAW and Z-Image Turbo/Base are mixed
 * workflow/default variants, so their shared family ids stay editable. */
export const CFG_ONE_WORKFLOW_FAMILIES = new Set(["qwen-image-2.1", "flux-schnell"]);

/** Official sampler defaults for the fleet workflow variants.
 * `z-image-base` selects the `z-image` workflow with the Base model's
 * different scalar defaults. */
export const IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS = {
  "qwen-image-2.1": { steps: 25, cfg: 1, sampler: "euler", scheduler: "simple" },
  "qwen-image": { steps: 20, cfg: 4, sampler: "euler", scheduler: "simple" },
  "z-image": { steps: 8, cfg: 1, sampler: "res_multistep", scheduler: "simple" },
  "z-image-base": { steps: 25, cfg: 4, sampler: "res_multistep", scheduler: "simple" },
  "flux-dev": { steps: 20, cfg: 1, sampler: "euler", scheduler: "simple" },
  "flux-schnell": { steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" },
} as const;

export type ImageGenWorkflowFamilyDefaults =
  (typeof IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS)[keyof typeof IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS];
