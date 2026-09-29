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

/** The DiT workflow families — every built-in family except the checkpoint
 * graph, which loads its encoder and VAE from the checkpoint itself. */
export type ImageGenDitWorkflowFamilyId = Exclude<ImageGenWorkflowFamilyId, "checkpoint">;

/** How the Comfy executor's Auto finds one sidecar file (IF-19). */
export interface ImageGenSidecarRule {
  /** Weights basename (no extension) of the family's official file. */
  readonly canonical: string;
  /** Other basenames accepted as the same role before the single-file fallback. */
  readonly aliases?: readonly string[];
  /** Try `<model-stem>_txt` before the canonical file (Anima). */
  readonly pairedStem?: boolean;
}

/** One DiT family's sidecar files. */
export interface ImageGenWorkflowSidecars {
  /** Brand name shown in hints and executor errors. */
  readonly label: string;
  readonly encoder: ImageGenSidecarRule;
  /** DualCLIPLoader's second text encoder (FLUX) — always resolved automatically. */
  readonly secondaryEncoder?: ImageGenSidecarRule;
  readonly vae: ImageGenSidecarRule;
}

/**
 * The DiT families' sidecar files — the ONE source (IF-19): the Comfy
 * executor's template specs derive their canonical names from it, and both
 * UI surfaces read it to name what Auto picks and what the family needs.
 */
export const IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS = {
  "krea2-dit": {
    label: "Krea-2",
    encoder: { canonical: "qwen3vl_4b_fp8_scaled" },
    vae: { canonical: "qwen_image_vae" },
  },
  "anima-dit": {
    label: "Anima",
    encoder: { canonical: "qwen_3_06b_base", pairedStem: true },
    vae: { canonical: "qwen_image_vae" },
  },
  "qwen-image-2.1": {
    label: "Qwen Image 2.1",
    encoder: { canonical: "qwen3vl_8b", aliases: ["qwen3vl_8b_int8_convrot"] },
    vae: { canonical: "qwen_image_2.1_vae", aliases: ["qwen_image_2.1_vae_bf16"] },
  },
  "qwen-image": {
    label: "Qwen Image",
    encoder: { canonical: "qwen_2_5_vl_7b", aliases: ["qwen_2.5_vl_7b_fp8_scaled"] },
    vae: { canonical: "qwen_image_vae" },
  },
  "z-image": {
    label: "Z-Image",
    encoder: { canonical: "qwen_3_4b" },
    vae: { canonical: "ae", aliases: ["fluxVAE"] },
  },
  "flux-dev": {
    label: "FLUX.1-dev",
    encoder: { canonical: "clip_l" },
    secondaryEncoder: { canonical: "t5xxl_fp16" },
    vae: { canonical: "ae", aliases: ["fluxVAE"] },
  },
  "flux-schnell": {
    label: "FLUX.1-schnell",
    encoder: { canonical: "clip_l" },
    secondaryEncoder: { canonical: "t5xxl_fp16" },
    vae: { canonical: "ae", aliases: ["fluxVAE"] },
  },
} as const satisfies Record<ImageGenDitWorkflowFamilyId, ImageGenWorkflowSidecars>;

/** Whether a workflow-family id names a DiT family with sidecar files. */
export function isImageGenDitWorkflowFamily(family: string | undefined): family is ImageGenDitWorkflowFamilyId {
  return family !== undefined && Object.hasOwn(IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS, family);
}

/** Basename without a weights extension — the model-label and sidecar-match key. */
export function imageGenWeightsBasename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
}

/** The basenames Auto accepts for one slot, in lookup order: the model's
 * paired `_txt` stem (when the rule has one and a model is known), then the
 * canonical file, then its aliases. */
export function imageGenSidecarCandidates(rule: ImageGenSidecarRule, model?: string): string[] {
  const aliases: readonly string[] = rule.aliases ?? [];
  return [
    ...(rule.pairedStem === true && model !== undefined ? [`${imageGenWeightsBasename(model)}_txt`] : []),
    rule.canonical,
    ...aliases,
  ];
}

/** Auto's pick from a live folder listing — the paired stem, then the first
 * listed file matching the canonical name or an alias, then a folder holding
 * a single file. Undefined when nothing matches (the executor fails closed
 * there). */
export function pickImageGenSidecar(
  names: readonly string[],
  rule: ImageGenSidecarRule,
  model?: string,
): string | undefined {
  if (rule.pairedStem === true && model !== undefined) {
    const pairedStem = `${imageGenWeightsBasename(model)}_txt`;
    const paired = names.find((name) => imageGenWeightsBasename(name) === pairedStem);
    if (paired !== undefined) return paired;
  }
  const canonicalNames: readonly string[] = [rule.canonical, ...(rule.aliases ?? [])];
  const canonical = names.find((name) => canonicalNames.includes(imageGenWeightsBasename(name)));
  if (canonical !== undefined) return canonical;
  return names.length === 1 ? names[0] : undefined;
}
