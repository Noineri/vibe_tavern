/**
 * Per-model imagegen control definitions — the ONE derivation layer
 * ("one data source, many consumers", AGENTS.md §3).
 *
 * The provider modal (ImageGenPane) and the chat chip
 * (ImageGenFineTuningChip) are both CONSUMERS of these descriptors:
 * each surface keeps only a thin renderer — its layout, primitives,
 * value source, and write target (the pane's dual bind arm vs the
 * chip's overlay-only commit). What a control IS (gate, options,
 * label keys, commit semantics) lives HERE and nowhere else.
 *
 * Translation rule: descriptors carry KEYS (labelKey), never translated
 * strings — each renderer translates at render time through ITS own `t`
 * via translateModelOptions (one translation flow for every descriptor;
 * raw server-provided names ride as ready `label`s). The generics keep
 * the keys literal so the pane's generated i18n union type-checks them.
 *
 * Migration queue: vibe_tavern_plan/reports/IMAGEGEN_TWIN_UNIFICATION_REPORT.md
 * (twins migrate one per unit; T1 sampler through T7 ADetailer each name
 * their shared builder here).
 *
 * forks: 2 — ImageGenHiresSection.tsx; ImageGenPane.tsx.
 */

import {
  CFG_ONE_WORKFLOW_FAMILIES,
  IMAGE_GEN_ADETAILER_DEFAULT_MODEL,
  IMAGE_GEN_ADETAILER_FACE_MODELS,
  IMAGE_GEN_BACKENDS,
  IMAGE_GEN_PARAM_RANGES,
  IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS,
  hasAdetailerExtension,
  imageGenSidecarCandidates,
  isImageGenDitWorkflowFamily,
  pickImageGenSidecar,
  type ImageGenCapabilityFlags,
  type ImageGenKreaParams,
  type ImageGenParamRange,
  type ImageGenSidecarRule,
  type ImageGenWorkflowSidecars,
} from "@vibe-tavern/domain";
import type { ImageGenBackendValue, ImageGenSchedulerInfoValue } from "@vibe-tavern/api-contracts";

/** A dropdown option: either translatable (`kind: "key"` + labelKey) or raw (`kind: "raw"` + label). */
export type ModelOption<K extends string = string> =
  | { kind: "raw"; id: string; label: string }
  | { kind: "key"; id: string; labelKey: K; params?: Readonly<Record<string, string>> };

/** Translate a descriptor's options for rendering. Surfaces pass their own `t`. */
export function translateModelOptions<K extends string>(
  options: ReadonlyArray<ModelOption<K>>,
  t: (key: K, params?: Record<string, unknown>) => string,
): { id: string; label: string }[] {
  return options.map((option) =>
    option.kind === "key"
      ? { id: option.id, label: t(option.labelKey, option.params) }
      : { id: option.id, label: option.label },
  );
}

/** A single-select dropdown descriptor consumed by both surfaces. */
export interface ModelDropdownSpec {
  readonly id: "sampler";
  /** A literal key — the pane's generated i18n `t` types keys as a union. */
  readonly labelKey: "image_gen_sampler_label";
  readonly options: ModelOption<"image_gen_sampler_auto">[];
  /**
   * Map a picked option id to the settings patch. `""` (the Auto entry)
   * commits `undefined` — the CF5 no-silent-defaults rule: empty means
   * "inherit the server's own default", never a hidden value.
   */
  commit(value: string): { sampler: string | undefined };
}

/**
 * T1 — the sampler dropdown. Gate: the profile's sampler capability
 * (the chip's START-time snapshot / the pane's caps mirror). Options:
 * Auto first, then the LIVE sampler list by name. The scheduler twin
 * (T2) stays surface-side until its own migration unit.
 */
export function buildSamplerControl(input: {
  supportsSamplers: boolean;
  samplers: ReadonlyArray<{ name: string }>;
}): ModelDropdownSpec | null {
  if (!input.supportsSamplers) return null;
  return {
    id: "sampler",
    labelKey: "image_gen_sampler_label",
    options: [
      { kind: "key", id: "", labelKey: "image_gen_sampler_auto" },
      ...input.samplers.map((sampler) => ({ kind: "raw" as const, id: sampler.name, label: sampler.name })),
    ],
    commit: (value) => ({ sampler: value === "" ? undefined : value }),
  };
}

/** Krea 2 generative sliders (T6) — a fixed −100..100 integer range, 0 neutral. */
const KREA_SLIDER_RANGE = { min: -100, max: 100, step: 1 } as const;

export type KreaCreativityValue = NonNullable<ImageGenKreaParams["creativity"]>;
export type KreaSliderField = "intensity" | "complexity" | "movement";

export interface KreaSliderSpec {
  readonly field: KreaSliderField;
  readonly labelKey: `image_gen_krea_${KreaSliderField}`;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 0 = the vendor-neutral unsent default (absent on the wire). */
  readonly default: number;
  /** Patch THIS field into the overlay's krea block, keep siblings (IF-11's merge). */
  commit(current: ImageGenKreaParams | undefined, value: number): { krea: ImageGenKreaParams };
}

/** T6 — the Krea 2 generative controls: creativity + three sliders. */
export interface KreaTwoControlsSpec {
  readonly creativity: {
    readonly labelKey: "image_gen_krea_creativity";
    readonly options: ReadonlyArray<{ value: KreaCreativityValue; labelKey: `image_gen_krea_creativity_${KreaCreativityValue}` }>;
    /** "raw" is the VT POLICY default (authored full-form prompts — the vendor default would expand them). */
    readonly default: KreaCreativityValue;
    commit(current: ImageGenKreaParams | undefined, value: KreaCreativityValue): { krea: ImageGenKreaParams };
  };
  readonly sliders: ReadonlyArray<KreaSliderSpec>;
}

/**
 * T2 — the LOCAL dialect family predicate: the backend pair that serves
 * the schedulers route (PG-3/CG-A3) — A1111 + ComfyUI, nothing else.
 * THE one membership derivation: every gate (both surfaces' fetch guards
 * and render guards) reads this; the pane's `guardIsLocalDialect` /
 * `isLocalBackend` and the chip's `isLocalDialect` were three hand-written
 * twins of it — the name drift this killed.
 */
export function isLocalDialectBackend(backend: ImageGenBackendValue): boolean {
  return backend === IMAGE_GEN_BACKENDS.A1111 || backend === IMAGE_GEN_BACKENDS.ComfyUI;
}

export interface SchedulerControlSpec {
  readonly labelKey: "image_gen_scheduler_label";
  /** Options for the profile's fetched scheduler list: the auto
   *  (vendor-default) head entry + the server's schedule types — raw
   *  server labels with the name fallback, translated as a whole via
   *  translateModelOptions like every dropdown. */
  options(schedulers: ReadonlyArray<ImageGenSchedulerInfoValue>): ModelOption<"image_gen_sampler_auto">[];
  /** "" (the auto entry) → inherit (undefined); a scheduler name → the value. */
  commit(id: string): { scheduler: string | undefined };
}

/**
 * T2 — the scheduler dropdown definition. Returns null off the local
 * dialect family (cloud dialects have no scheduler surface); the gate
 * lives HERE, surfaces only check the result — buildSamplerControl's
 * shape.
 */
export function buildSchedulerControl({ backend }: { backend: ImageGenBackendValue }): SchedulerControlSpec | null {
  if (!isLocalDialectBackend(backend)) return null;
  return {
    labelKey: "image_gen_scheduler_label",
    options: (schedulers): ModelOption<"image_gen_sampler_auto">[] => [
      { kind: "key", id: "", labelKey: "image_gen_sampler_auto" },
      ...schedulers.map((scheduler) => ({
        kind: "raw" as const,
        id: scheduler.name,
        label: scheduler.label ?? scheduler.name,
      })),
    ],
    commit: (id) => ({ scheduler: id === "" ? undefined : id }),
  };
}

type RawModelOption = Extract<ModelOption, { kind: "raw" }>;

export type AdetailerControlSpec =
  | {
      readonly state: "ready";
      /** ADetailer names are server/static raw labels, never i18n keys. */
      readonly options: ReadonlyArray<RawModelOption>;
      readonly fallback: string;
      readonly labelKey: "image_gen_adetailer";
      readonly modelLabelKey: "image_gen_adetailer_model";
      readonly stepsLabelKey: "image_gen_adetailer_steps_label";
      readonly stepsRange: ImageGenParamRange;
      readonly stepsPlaceholder: string;
      /** Empty clears the stored override; an integer commits it. */
      parseSteps(raw: string): { adetailerSteps: number | undefined } | null;
    }
  | {
      readonly state: "unavailable";
      readonly labelKey: "image_gen_adetailer";
      readonly hintKey: "image_gen_adetailer_missing_hint";
    };

/**
 * T7 — ADetailer's twin derivation. A1111 is ready only when its extension
 * probe answered with the matching entry, otherwise hidden (including an
 * unanswered probe); it never has an unavailable state. ComfyUI is hidden
 * while its face-detector probe is unanswered or failed, unavailable when it
 * answered empty, and ready with its discovered detector list otherwise.
 * The chip keeps its nested accordion and the pane its bound-only row; both
 * retain their own probe fetches while reading this shared descriptor.
 */
export function buildAdetailerControl(input: {
  backend: ImageGenBackendValue;
  extensions: ReadonlyArray<string> | null;
  faceDetectors: ReadonlyArray<string> | null;
  /** The surface's resolved base steps, displayed when the override is empty. */
  baseSteps: number;
}): AdetailerControlSpec | null {
  if (input.backend === IMAGE_GEN_BACKENDS.A1111) {
    if (input.extensions === null || !hasAdetailerExtension(input.extensions)) return null;
    return {
      state: "ready",
      options: IMAGE_GEN_ADETAILER_FACE_MODELS.map((label) => ({ kind: "raw", id: label, label })),
      fallback: IMAGE_GEN_ADETAILER_DEFAULT_MODEL,
      labelKey: "image_gen_adetailer",
      modelLabelKey: "image_gen_adetailer_model",
      stepsLabelKey: "image_gen_adetailer_steps_label",
      stepsRange: IMAGE_GEN_PARAM_RANGES.steps,
      stepsPlaceholder: String(input.baseSteps),
      parseSteps,
    };
  }

  if (input.backend !== IMAGE_GEN_BACKENDS.ComfyUI || input.faceDetectors === null) return null;
  if (input.faceDetectors.length === 0) {
    return {
      state: "unavailable",
      labelKey: "image_gen_adetailer",
      hintKey: "image_gen_adetailer_missing_hint",
    };
  }
  return {
    state: "ready",
    options: input.faceDetectors.map((label) => ({ kind: "raw", id: label, label })),
    fallback: input.faceDetectors[0]!,
    labelKey: "image_gen_adetailer",
    modelLabelKey: "image_gen_adetailer_model",
    stepsLabelKey: "image_gen_adetailer_steps_label",
    stepsRange: IMAGE_GEN_PARAM_RANGES.steps,
    stepsPlaceholder: String(input.baseSteps),
    parseSteps,
  };
}

function parseSteps(raw: string): { adetailerSteps: number | undefined } | null {
  const trimmed = raw.trim();
  if (trimmed === "") return { adetailerSteps: undefined };
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? { adetailerSteps: parsed } : null;
}

/**
 * T3 — the DiT sidecar fields (text encoder + VAE) for the comfyui
 * dialect's DiT workflow families (CG-B1; every fleet family since IF-19).
 * The gate lives HERE (both surfaces' render guards read it; the fetch
 * guards keep their own mechanics but the same family rule); each field
 * carries the pickable Auto option (CF5's honest Auto — the adapter's
 * canonical resolution, not a hidden default), the since-removed-files
 * rule (a stored value outside the live list stays pickable — the STT/LLM
 * selector rule) and the commit semantics.
 *
 * IF-19 (owner 2026-09-27: an honest hint over silent auto-substitution):
 * Auto names the file it resolves to from the live folder list — the
 * domain's `pickImageGenSidecar`, the SAME ladder the Comfy executor runs —
 * and the block carries a hint naming the files the family needs, read
 * from the domain's IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS (the executor's
 * source too).
 */
export type DitSidecarField = "encoderName" | "vaeName";

/** Auto's label: plain while the folder list is not loaded, the resolved
 *  file once it is, an honest miss when nothing matches. */
export type DitSidecarAutoKey =
  | "image_gen_sidecar_auto"
  | "image_gen_sidecar_auto_file"
  | "image_gen_sidecar_auto_missing";

export interface DitSidecarFieldSpec {
  readonly field: DitSidecarField;
  readonly labelKey: "image_gen_encoder_label" | "image_gen_vae_label";
  /** Options for the profile's live folder list + the stored value: the
   *  Auto head entry (labelled with the file Auto resolves to) + the live
   *  names + the stored off-list value kept pickable. `names` undefined =
   *  the list has not loaded yet (Auto stays unlabelled — no conclusion
   *  from missing data). */
  options(names: ReadonlyArray<string> | undefined, stored: string | undefined): ModelOption<DitSidecarAutoKey>[];
  /** "" (the Auto entry) → inherit (undefined); a file name → the value. */
  commit(id: string): { encoderName: string | undefined } | { vaeName: string | undefined };
}

/** The block's hint: which files the family needs (alternatives joined by
 *  " / ", FLUX's always-automatic second encoder joined by " + "). */
export interface DitSidecarHint {
  readonly labelKey: "image_gen_sidecar_hint";
  readonly params: { readonly family: string; readonly encoder: string; readonly vae: string };
}

export interface DitSidecarControlsSpec {
  readonly encoder: DitSidecarFieldSpec;
  readonly vae: DitSidecarFieldSpec;
  readonly hint: DitSidecarHint;
}

function sidecarAutoOption(
  names: ReadonlyArray<string> | undefined,
  rule: ImageGenSidecarRule,
  modelId: string | undefined,
): ModelOption<DitSidecarAutoKey> {
  if (names === undefined) return { kind: "key", id: "", labelKey: "image_gen_sidecar_auto" };
  const picked = pickImageGenSidecar(names, rule, modelId);
  return picked === undefined
    ? { kind: "key", id: "", labelKey: "image_gen_sidecar_auto_missing" }
    : { kind: "key", id: "", labelKey: "image_gen_sidecar_auto_file", params: { file: picked } };
}

function sidecarOptions(
  rule: ImageGenSidecarRule,
  modelId: string | undefined,
): DitSidecarFieldSpec["options"] {
  return (names, stored) => {
    const live = names ?? [];
    return [
      sidecarAutoOption(names, rule, modelId),
      ...live.map((name) => ({ kind: "raw" as const, id: name, label: name })),
      ...(stored !== undefined && !live.includes(stored)
        ? [{ kind: "raw" as const, id: stored, label: stored }]
        : []),
    ];
  };
}

export function buildDitSidecarControls({
  backend,
  workflowFamily,
  modelTemplate,
  modelId,
}: {
  backend: ImageGenBackendValue | undefined;
  /** The manual base-workflow pick (sampler-set channel) — outranks the
   *  model's detected template, the executor's own order. */
  workflowFamily?: string | undefined;
  /** The picked model's workflow-template marker from the models listing. */
  modelTemplate: string | undefined;
  /** The picked model — Anima's paired `<stem>_txt` encoder keys off it. */
  modelId?: string | undefined;
}): DitSidecarControlsSpec | null {
  const family = workflowFamily ?? modelTemplate;
  if (backend !== IMAGE_GEN_BACKENDS.ComfyUI || !isImageGenDitWorkflowFamily(family)) return null;
  const sidecars: ImageGenWorkflowSidecars = IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS[family];
  const encoderNames = imageGenSidecarCandidates(sidecars.encoder, modelId).join(" / ");
  return {
    encoder: {
      field: "encoderName",
      labelKey: "image_gen_encoder_label",
      options: sidecarOptions(sidecars.encoder, modelId),
      commit: (id) => ({ encoderName: id === "" ? undefined : id }),
    },
    vae: {
      field: "vaeName",
      labelKey: "image_gen_vae_label",
      options: sidecarOptions(sidecars.vae, modelId),
      commit: (id) => ({ vaeName: id === "" ? undefined : id }),
    },
    hint: {
      labelKey: "image_gen_sidecar_hint",
      params: {
        family: sidecars.label,
        encoder:
          sidecars.secondaryEncoder === undefined
            ? encoderNames
            : `${encoderNames} + ${imageGenSidecarCandidates(sidecars.secondaryEncoder).join(" / ")}`,
        vae: imageGenSidecarCandidates(sidecars.vae).join(" / "),
      },
    },
  };
}

/**
 * T4 — the advanced scalar sliders (steps / cfg / clip-skip). The range
 * resolves MIRROR-FIRST in this ONE place: the capability mirror's declared
 * override wins, the global default otherwise. Both surfaces render the
 * RESOLVED range — the chip's old global-only read was the silent drift
 * this killed (a backend declaring limits now shapes both surfaces).
 */
export type ScalarSliderField = "steps" | "cfgScale" | "cfgRescale" | "clipSkip";

export interface ScalarSliderSpec {
  readonly field: ScalarSliderField;
  readonly labelKey: "image_gen_steps_label" | "image_gen_cfg_label" | "image_gen_cfg_rescale_label" | "image_gen_clip_skip_label";
  readonly range: ImageGenParamRange;
  commit(value: number): Partial<Record<ScalarSliderField, number>>;
}

export type ScalarSliders = readonly [
  ScalarSliderSpec | undefined,
  ScalarSliderSpec | undefined,
  ScalarSliderSpec | undefined,
  ScalarSliderSpec | undefined,
];

/** Fixed slots preserve the pane's positional field contract while absent
 *  capability flags remove the corresponding control from both renderers. */
export function buildScalarSliders(
  input:
    | Pick<ImageGenCapabilityFlags, "supportsSteps" | "supportsCfgScale" | "supportsClipSkip" | "paramRanges">
    | {
        capabilities: Pick<ImageGenCapabilityFlags, "supportsSteps" | "supportsCfgScale" | "supportsClipSkip" | "paramRanges">;
        backend: ImageGenBackendValue;
        workflowFamily?: string;
      },
): ScalarSliders {
  const capabilities = "capabilities" in input ? input.capabilities : input;
  const backend = "capabilities" in input ? input.backend : undefined;
  const workflowFamily = "capabilities" in input ? input.workflowFamily : undefined;
  const paramRanges = capabilities.paramRanges;
  // The family gate lives here: both renderers consume this descriptor and
  // never re-derive CFG-1-only workflow knowledge.
  const supportsCfgScale = capabilities.supportsCfgScale && !CFG_ONE_WORKFLOW_FAMILIES.has(workflowFamily ?? "");
  const supportsCfgRescale = supportsCfgScale && backend !== undefined && isLocalDialectBackend(backend);
  return [
    capabilities.supportsSteps
      ? {
          field: "steps",
          labelKey: "image_gen_steps_label",
          range: paramRanges?.steps ?? IMAGE_GEN_PARAM_RANGES.steps,
          commit: (steps) => ({ steps }),
        }
      : undefined,
    supportsCfgScale
      ? {
          field: "cfgScale",
          labelKey: "image_gen_cfg_label",
          range: paramRanges?.cfgScale ?? IMAGE_GEN_PARAM_RANGES.cfgScale,
          commit: (cfgScale) => ({ cfgScale }),
        }
      : undefined,
    capabilities.supportsClipSkip
      ? {
          field: "clipSkip",
          labelKey: "image_gen_clip_skip_label",
          range: paramRanges?.clipSkip ?? IMAGE_GEN_PARAM_RANGES.clipSkip,
          commit: (clipSkip) => ({ clipSkip }),
        }
      : undefined,
    supportsCfgRescale
      ? {
          field: "cfgRescale",
          labelKey: "image_gen_cfg_rescale_label",
          range: paramRanges?.cfgRescale ?? IMAGE_GEN_PARAM_RANGES.cfgRescale,
          commit: (cfgRescale) => ({ cfgRescale }),
        }
      : undefined,
  ];
}

/**
 * T5 — the optional seed. The parse is the ONE copy of the semantics (the
 * pane's long-standing behavior, now both surfaces'): "" → inherit
 * (undefined), a finite number → the value, NON-finite garbage → null =
 * NO COMMIT (garbage never wipes a set seed — the chip's old
 * clear-on-garbage commit was the divergence this killed).
 */
export interface SeedFieldSpec {
  readonly labelKey: "image_gen_seed_label";
  /** A concrete, reproducible seed mirroring ComfyUI's adapter resolution. */
  randomSeed(): number;
  parse(raw: string): { seed: number | undefined } | null;
}

export function buildSeedField(input: Pick<ImageGenCapabilityFlags, "supportsSeed">): SeedFieldSpec | null {
  if (!input.supportsSeed) return null;
  return {
    labelKey: "image_gen_seed_label",
    // Mirrors resolveComfySeed: the local adapter generates integers in
    // [0, Number.MAX_SAFE_INTEGER) when a seed is unset or random.
    randomSeed: () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    parse: (raw) => {
      const trimmed = raw.trim();
      if (trimmed === "") return { seed: undefined };
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { seed: parsed } : null;
    },
  };
}

/** Display anchors for unset hires knobs: the A1111 server's own defaults. */
export const HIRES_DISPLAY_ANCHORS = {
  steps: 0,
  scale: 2,
  denoisingStrength: 0.75,
} as const;

export type HiresSliderField = "steps" | "scale" | "denoisingStrength";

const HIRES_UPSCALER_AUTO_LABEL_KEY = "image_gen_hires_upscaler_auto";

export interface HiresSliderSpec {
  readonly field: HiresSliderField;
  readonly labelKey:
    | "image_gen_hires_steps_label"
    | "image_gen_hires_scale_label"
    | "image_gen_hires_denoise_label";
  readonly range: ImageGenParamRange;
  readonly displayAnchor: number;
}

export interface HiresControlSpec {
  readonly labelKey: "image_gen_hires_label";
  readonly upscalerLabelKey: "image_gen_hires_upscaler_label";
  readonly upscalerAutoLabelKey: typeof HIRES_UPSCALER_AUTO_LABEL_KEY;
  readonly sliders: readonly [HiresSliderSpec, HiresSliderSpec, HiresSliderSpec];
  upscalerOptions(
    upscalers: ReadonlyArray<{ name: string }> | null,
    stored: string | undefined,
  ): ModelOption<"image_gen_hires_upscaler_auto">[];
  commitUpscaler(id: string): string | undefined;
}

/**
 * T8 — hires-fix control knowledge shared by the fine-tuning chip and the
 * profile pane. Unset slider values display the A1111 server's own defaults,
 * so an untouched slider tells the truth without committing a value. Auto
 * leads the live upscaler list, and a non-empty stored pick missing from that
 * list remains pickable (the stale-pick rule). Renderers remain per-surface
 * forks: each owns its chrome, state arm, and test-id dialect.
 */
export function buildHiresControl({ supportsHiresFix }: { supportsHiresFix: boolean }): HiresControlSpec | null {
  if (!supportsHiresFix) return null;
  return {
    labelKey: "image_gen_hires_label",
    upscalerLabelKey: "image_gen_hires_upscaler_label",
    upscalerAutoLabelKey: HIRES_UPSCALER_AUTO_LABEL_KEY,
    sliders: [
      {
        field: "steps",
        labelKey: "image_gen_hires_steps_label",
        range: IMAGE_GEN_PARAM_RANGES.hiresSteps,
        displayAnchor: HIRES_DISPLAY_ANCHORS.steps,
      },
      {
        field: "scale",
        labelKey: "image_gen_hires_scale_label",
        range: IMAGE_GEN_PARAM_RANGES.hiresScale,
        displayAnchor: HIRES_DISPLAY_ANCHORS.scale,
      },
      {
        field: "denoisingStrength",
        labelKey: "image_gen_hires_denoise_label",
        range: IMAGE_GEN_PARAM_RANGES.hiresDenoise,
        displayAnchor: HIRES_DISPLAY_ANCHORS.denoisingStrength,
      },
    ],
    upscalerOptions: (upscalers, stored) => {
      const names = upscalers ?? [];
      return [
        { kind: "key", id: "", labelKey: HIRES_UPSCALER_AUTO_LABEL_KEY },
        ...names.map((upscaler) => ({ kind: "raw" as const, id: upscaler.name, label: upscaler.name })),
        ...(stored !== undefined && stored !== "" && !names.some((upscaler) => upscaler.name === stored)
          ? [{ kind: "raw" as const, id: stored, label: stored }]
          : []),
      ];
    },
    commitUpscaler: (id) => (id === "" ? undefined : id),
  };
}

/** T6 — the Krea 2 gate: the krea backend's OWN models only (krea/krea-2/*);
 * the aggregator's third-party models have no generative controls. The gate
 * lives HERE (both surfaces ask the builder, never re-derive it). The commit
 * merge is the ONE copy — the chip's overlay arm and the pane's dual arm
 * both route through it. Owner ruling: the section is NEVER gated behind
 * the per-model bind toggle (the toggle is for per-model overrides, not a
 * gate for generative controls) — both surfaces render it for any
 * krea-own model and write their active arm.
 */
export function buildKreaTwoControls(input: { backend: string; modelId: string }): KreaTwoControlsSpec | null {
  if (input.backend !== IMAGE_GEN_BACKENDS.Krea || !input.modelId.startsWith("krea/")) return null;
  return {
    creativity: {
      labelKey: "image_gen_krea_creativity",
      options: [
        { value: "raw", labelKey: "image_gen_krea_creativity_raw" },
        { value: "low", labelKey: "image_gen_krea_creativity_low" },
        { value: "medium", labelKey: "image_gen_krea_creativity_medium" },
        { value: "high", labelKey: "image_gen_krea_creativity_high" },
      ],
      default: "raw",
      commit: (current, value) => ({ krea: { ...current, creativity: value } }),
    },
    sliders: [
      {
        field: "intensity",
        labelKey: "image_gen_krea_intensity",
        ...KREA_SLIDER_RANGE,
        default: 0,
        commit: (current, value) => ({ krea: { ...current, intensity: value } }),
      },
      {
        field: "complexity",
        labelKey: "image_gen_krea_complexity",
        ...KREA_SLIDER_RANGE,
        default: 0,
        commit: (current, value) => ({ krea: { ...current, complexity: value } }),
      },
      {
        field: "movement",
        labelKey: "image_gen_krea_movement",
        ...KREA_SLIDER_RANGE,
        default: 0,
        commit: (current, value) => ({ krea: { ...current, movement: value } }),
      },
    ],
  };
}
