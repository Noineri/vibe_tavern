import {
  IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS,
  IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS,
  imageGenWeightsBasename,
  pickImageGenSidecar,
  type ImageGenDitWorkflowFamilyId,
  type ImageGenWorkflowSidecars,
} from "@vibe-tavern/domain";

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

/** A DiT family's label + sidecar names, projected from the domain's ONE
 *  sidecar source (IF-19) into the executor's spec field names. */
function ditSidecarFields(family: ImageGenDitWorkflowFamilyId) {
  const sidecars: ImageGenWorkflowSidecars = IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS[family];
  return {
    familyLabel: sidecars.label,
    canonicalEncoder: sidecars.encoder.canonical,
    ...(sidecars.encoder.aliases !== undefined ? { canonicalEncoderAliases: sidecars.encoder.aliases } : {}),
    ...(sidecars.encoder.pairedStem === true ? { encoderPairedStem: true } : {}),
    ...(sidecars.secondaryEncoder !== undefined
      ? { canonicalSecondaryEncoder: sidecars.secondaryEncoder.canonical }
      : {}),
    canonicalVae: sidecars.vae.canonical,
    ...(sidecars.vae.aliases !== undefined ? { canonicalVaeAliases: sidecars.vae.aliases } : {}),
  };
}

/** The built-in workflow families. DiT members take their label and
 *  sidecar names from the domain's IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS. */
export const COMFY_TEMPLATE_SPECS = {
  checkpoint: {
    id: "checkpoint",
    familyLabel: "Checkpoint",
  } satisfies ComfyTemplateSpec,
  krea2Dit: {
    id: "krea2-dit",
    ...ditSidecarFields("krea2-dit"),
    clipType: "krea2",
  } satisfies ComfyDitTemplateSpec,
  animaDit: {
    id: "anima-dit",
    ...ditSidecarFields("anima-dit"),
    clipType: "stable_diffusion",
  } satisfies ComfyDitTemplateSpec,
  qwenImage21: {
    id: "qwen-image-2.1",
    ...ditSidecarFields("qwen-image-2.1"),
    clipType: "qwen_image",
    latentNode: "EmptyLatentImage",
    workflowShape: COMFY_DIT_WORKFLOW_SHAPES.QwenImage21,
    defaults: { width: 1024, height: 1024, ...IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS["qwen-image-2.1"] },
  } satisfies ComfyDitTemplateSpec,
  qwenImage: {
    id: "qwen-image",
    ...ditSidecarFields("qwen-image"),
    clipType: "qwen_image",
    latentNode: "EmptySD3LatentImage",
    auraFlowShift: 3.1,
    defaults: { width: 1328, height: 1328, ...IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS["qwen-image"] },
  } satisfies ComfyDitTemplateSpec,
  zImage: {
    id: "z-image",
    ...ditSidecarFields("z-image"),
    clipType: "lumina2",
    latentNode: "EmptySD3LatentImage",
    auraFlowShift: 3,
    defaults: { width: 1024, height: 1024, ...IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS["z-image"] },
  } satisfies ComfyDitTemplateSpec,
  fluxDev: {
    id: "flux-dev",
    ...ditSidecarFields("flux-dev"),
    clipType: "flux",
    latentNode: "EmptySD3LatentImage",
    workflowShape: COMFY_DIT_WORKFLOW_SHAPES.FluxDev,
    defaults: { width: 1024, height: 1024, ...IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS["flux-dev"] },
  } satisfies ComfyDitTemplateSpec,
  fluxSchnell: {
    id: "flux-schnell",
    ...ditSidecarFields("flux-schnell"),
    clipType: "flux",
    latentNode: "EmptySD3LatentImage",
    workflowShape: COMFY_DIT_WORKFLOW_SHAPES.FluxSchnell,
    defaults: { width: 1024, height: 1024, ...IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS["flux-schnell"], guidance: 3.5 },
  } satisfies ComfyDitTemplateSpec,
} as const;

/** Basename without a weights extension — the model-label and sidecar-match key. */
export function comfyWeightsBasename(name: string): string {
  return imageGenWeightsBasename(name);
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
  // Auto's pick is the domain's ONE ladder — the UI names the same file.
  const picked = pickImageGenSidecar(
    names,
    {
      canonical: options.canonical,
      ...(options.canonicalAliases !== undefined ? { aliases: options.canonicalAliases } : {}),
      ...(spec.encoderPairedStem === true ? { pairedStem: true } : {}),
    },
    options.pairedStem,
  );
  if (picked !== undefined) return picked;
  const canonicalNames = [options.canonical, ...(options.canonicalAliases ?? [])];

  const candidates =
    names.length === 0
      ? "the folder is empty"
      : `candidates: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
  const required = canonicalNames.map((name) => `"${name}.*"`).join(" or ");
  throw options.createConfigError(
    `ComfyUI ${options.what} for the ${spec.familyLabel} template is unresolved: no ${required} in the ${options.folder} folder (${candidates}) — pick one in the profile's advanced fields`,
  );
}
