/**
 * ComfyUI workflow-template registry (IF-16a).
 *
 * Fleet members are data here rather than new executor branches; the executor
 * owns fail-closed selection. Existing checkpoint and Krea-2 graphs must stay
 * byte-identical, and IF-16b adds the first new registry member.
 */

/** Metadata the ComfyUI executor needs to select and configure a workflow family. */
export interface ComfyTemplateSpec {
  readonly id: string;
  readonly familyLabel: string;
  readonly clipType?: string;
  readonly canonicalEncoder?: string;
  readonly canonicalVae?: string;
  /** IF-16b: try `<unet-stem>_txt` before the canonical encoder. */
  readonly encoderPairedStem?: boolean;
}

/** The loader and conditioning shapes that distinguish DiT workflow families. */
export const COMFY_DIT_WORKFLOW_SHAPES = {
  Standard: "standard",
  QwenImage21: "qwen-image-2.1",
  FluxDev: "flux-dev",
  FluxSchnell: "flux-schnell",
} as const;
export type ComfyDitWorkflowShape = (typeof COMFY_DIT_WORKFLOW_SHAPES)[keyof typeof COMFY_DIT_WORKFLOW_SHAPES];

/** A DiT template has all loader inputs the executor requires. */
export interface ComfyDitTemplateSpec extends ComfyTemplateSpec {
  readonly clipType: string;
  readonly canonicalEncoder: string;
  /** Alternate canonical encoder filenames accepted before a single-file fallback. */
  readonly canonicalEncoderAliases?: readonly string[];
  readonly canonicalVae: string;
  /** Alternate canonical VAE roles accepted before a single-file fallback. */
  readonly canonicalVaeAliases?: readonly string[];
  /** DualCLIPLoader's second text encoder (FLUX only). */
  readonly canonicalSecondaryEncoder?: string;
  /** Official graph's latent node. */
  readonly latentNode?: "EmptyLatentImage" | "EmptySD3LatentImage";
  /** Official ModelSamplingAuraFlow shift, when the graph carries one. */
  readonly auraFlowShift?: number;
  /** Family graph shape beyond the standard single-CLIP pair. */
  readonly workflowShape?: ComfyDitWorkflowShape;
  /** Official template defaults materialized when the flat request omits them. */
  readonly defaults?: {
    readonly width: number;
    readonly height: number;
    readonly steps: number;
    readonly cfg: number;
    readonly sampler: string;
    readonly scheduler: string;
    /** CLIPTextEncodeFlux guidance. */
    readonly guidance?: number;
  };
}

/** The built-in workflow families. */
export const COMFY_TEMPLATE_SPECS = {
  checkpoint: {
    id: "checkpoint",
    familyLabel: "Checkpoint",
  } satisfies ComfyTemplateSpec,
  krea2Dit: {
    id: "krea2-dit",
    familyLabel: "Krea-2",
    clipType: "krea2",
    canonicalEncoder: "qwen3vl_4b_fp8_scaled",
    canonicalVae: "qwen_image_vae",
  } satisfies ComfyDitTemplateSpec,
  animaDit: {
    id: "anima-dit",
    familyLabel: "Anima",
    clipType: "stable_diffusion",
    canonicalEncoder: "qwen_3_06b_base",
    canonicalVae: "qwen_image_vae",
    encoderPairedStem: true,
  } satisfies ComfyDitTemplateSpec,
  qwenImage21: {
    id: "qwen-image-2.1",
    familyLabel: "Qwen Image 2.1",
    clipType: "qwen_image",
    canonicalEncoder: "qwen3vl_8b",
    canonicalEncoderAliases: ["qwen3vl_8b_int8_convrot"],
    canonicalVae: "qwen_image_2.1_vae",
    canonicalVaeAliases: ["qwen_image_2.1_vae_bf16"],
    latentNode: "EmptyLatentImage",
    workflowShape: COMFY_DIT_WORKFLOW_SHAPES.QwenImage21,
    defaults: { width: 1024, height: 1024, steps: 25, cfg: 1, sampler: "euler", scheduler: "simple" },
  } satisfies ComfyDitTemplateSpec,
  qwenImage: {
    id: "qwen-image",
    familyLabel: "Qwen Image",
    clipType: "qwen_image",
    canonicalEncoder: "qwen_2_5_vl_7b",
    canonicalEncoderAliases: ["qwen_2.5_vl_7b_fp8_scaled"],
    canonicalVae: "qwen_image_vae",
    latentNode: "EmptySD3LatentImage",
    auraFlowShift: 3.1,
    defaults: { width: 1328, height: 1328, steps: 20, cfg: 4, sampler: "euler", scheduler: "simple" },
  } satisfies ComfyDitTemplateSpec,
  zImage: {
    id: "z-image",
    familyLabel: "Z-Image",
    clipType: "lumina2",
    canonicalEncoder: "qwen_3_4b",
    canonicalVae: "ae",
    canonicalVaeAliases: ["fluxVAE"],
    latentNode: "EmptySD3LatentImage",
    auraFlowShift: 3,
    defaults: { width: 1024, height: 1024, steps: 8, cfg: 1, sampler: "res_multistep", scheduler: "simple" },
  } satisfies ComfyDitTemplateSpec,
  fluxDev: {
    id: "flux-dev",
    familyLabel: "FLUX.1-dev",
    clipType: "flux",
    canonicalEncoder: "clip_l",
    canonicalSecondaryEncoder: "t5xxl_fp16",
    canonicalVae: "ae",
    canonicalVaeAliases: ["fluxVAE"],
    latentNode: "EmptySD3LatentImage",
    workflowShape: COMFY_DIT_WORKFLOW_SHAPES.FluxDev,
    defaults: { width: 1024, height: 1024, steps: 20, cfg: 1, sampler: "euler", scheduler: "simple" },
  } satisfies ComfyDitTemplateSpec,
  fluxSchnell: {
    id: "flux-schnell",
    familyLabel: "FLUX.1-schnell",
    clipType: "flux",
    canonicalEncoder: "clip_l",
    canonicalSecondaryEncoder: "t5xxl_fp16",
    canonicalVae: "ae",
    canonicalVaeAliases: ["fluxVAE"],
    latentNode: "EmptySD3LatentImage",
    workflowShape: COMFY_DIT_WORKFLOW_SHAPES.FluxSchnell,
    defaults: { width: 1024, height: 1024, steps: 4, cfg: 1, sampler: "euler", scheduler: "simple", guidance: 3.5 },
  } satisfies ComfyDitTemplateSpec,
} as const;

/** Basename without a weights extension — the model-label and sidecar-match key. */
export function comfyWeightsBasename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
}

/** Inputs owned by the executor around a sidecar lookup. */
export interface ComfySidecarResolveOptions {
  readonly folder: string;
  readonly explicit: string | undefined;
  readonly canonical: string;
  /** Additional canonical roles accepted before the single-file fallback. */
  readonly canonicalAliases?: readonly string[];
  /** The selected diffusion-model name, supplied for encoder paired-stem lookup only. */
  readonly pairedStem: string | undefined;
  readonly what: string;
  readonly signal: AbortSignal | undefined;
  readonly listFolder: (folder: string, signal: AbortSignal | undefined) => Promise<readonly string[]>;
  readonly createConfigError: (message: string) => Error;
}

/**
 * Resolve a DiT sidecar: explicit request value, optionally the selected
 * model's paired encoder stem, exact canonical basename, then a single-file
 * folder; otherwise fail closed with the registry family.
 */
export async function resolveComfySidecar(
  options: ComfySidecarResolveOptions,
  spec: ComfyTemplateSpec,
): Promise<string> {
  const explicit = options.explicit?.trim();
  if (explicit) return explicit;

  const names = await options.listFolder(options.folder, options.signal);
  if (spec.encoderPairedStem && options.pairedStem !== undefined) {
    const pairedStem = `${comfyWeightsBasename(options.pairedStem)}_txt`;
    const paired = names.find((name) => comfyWeightsBasename(name) === pairedStem);
    if (paired !== undefined) return paired;
  }
  const canonicalNames = [options.canonical, ...(options.canonicalAliases ?? [])];
  const canonical = names.find((name) => canonicalNames.includes(comfyWeightsBasename(name)));
  if (canonical !== undefined) return canonical;
  if (names.length === 1 && names[0] !== undefined) return names[0];

  const candidates =
    names.length === 0
      ? "the folder is empty"
      : `candidates: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
  const required = canonicalNames.map((name) => `"${name}.*"`).join(" or ");
  throw options.createConfigError(
    `ComfyUI ${options.what} for the ${spec.familyLabel} template is unresolved: no ${required} in the ${options.folder} folder (${candidates}) — pick one in the profile's advanced fields`,
  );
}
