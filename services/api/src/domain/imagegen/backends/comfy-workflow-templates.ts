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

/** A DiT template has all loader inputs the current executor requires. */
export interface ComfyDitTemplateSpec extends ComfyTemplateSpec {
  readonly clipType: string;
  readonly canonicalEncoder: string;
  readonly canonicalVae: string;
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
  const canonical = names.find((name) => comfyWeightsBasename(name) === options.canonical);
  if (canonical !== undefined) return canonical;
  if (names.length === 1 && names[0] !== undefined) return names[0];

  const candidates =
    names.length === 0
      ? "the folder is empty"
      : `candidates: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
  throw options.createConfigError(
    `ComfyUI ${options.what} for the ${spec.familyLabel} template is unresolved: no "${options.canonical}.*" in the ${options.folder} folder (${candidates}) — pick one in the profile's advanced fields`,
  );
}
