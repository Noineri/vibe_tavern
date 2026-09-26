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
 */

import {
  IMAGE_GEN_ADETAILER_DEFAULT_MODEL,
  IMAGE_GEN_ADETAILER_FACE_MODELS,
  IMAGE_GEN_BACKENDS,
  IMAGE_GEN_PARAM_RANGES,
  hasAdetailerExtension,
  type ImageGenCapabilityFlags,
  type ImageGenKreaParams,
  type ImageGenParamRange,
} from "@vibe-tavern/domain";
import type { ImageGenBackendValue, ImageGenSchedulerInfoValue } from "@vibe-tavern/api-contracts";

/** A dropdown option: either translatable (`kind: "key"` + labelKey) or raw (`kind: "raw"` + label). */
export type ModelOption<K extends string = string> =
  | { kind: "raw"; id: string; label: string }
  | { kind: "key"; id: string; labelKey: K };

/** Translate a descriptor's options for rendering. Surfaces pass their own `t`. */
export function translateModelOptions<K extends string>(
  options: ReadonlyArray<ModelOption<K>>,
  t: (key: K) => string,
): { id: string; label: string }[] {
  return options.map((option) =>
    option.kind === "key" ? { id: option.id, label: t(option.labelKey) } : { id: option.id, label: option.label },
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
}): AdetailerControlSpec | null {
  if (input.backend === IMAGE_GEN_BACKENDS.A1111) {
    if (input.extensions === null || !hasAdetailerExtension(input.extensions)) return null;
    return {
      state: "ready",
      options: IMAGE_GEN_ADETAILER_FACE_MODELS.map((label) => ({ kind: "raw", id: label, label })),
      fallback: IMAGE_GEN_ADETAILER_DEFAULT_MODEL,
      labelKey: "image_gen_adetailer",
      modelLabelKey: "image_gen_adetailer_model",
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
  };
}

/**
 * T3 — the DiT sidecar fields (text encoder + VAE) for the comfyui
 * dialect's krea2-dit template (CG-B1). The gate lives HERE (both
 * surfaces' render guards read it; the fetch guards keep their own
 * mechanics but the same family rule); each field carries the pickable
 * Auto option (CF5's honest Auto — the adapter's canonical resolution,
 * not a hidden default), the since-removed-files rule (a stored value
 * outside the live list stays pickable — the STT/LLM selector rule) and
 * the commit semantics.
 */
export type DitSidecarField = "encoderName" | "vaeName";

export interface DitSidecarFieldSpec {
  readonly field: DitSidecarField;
  readonly labelKey: "image_gen_encoder_label" | "image_gen_vae_label";
  /** Options for the profile's live folder list + the stored value: the
   *  Auto (vendor-default) head entry + the live names + the stored
   *  off-list value kept pickable. */
  options(names: ReadonlyArray<string>, stored: string | undefined): ModelOption<"image_gen_sidecar_auto">[];
  /** "" (the Auto entry) → inherit (undefined); a file name → the value. */
  commit(id: string): { encoderName: string | undefined } | { vaeName: string | undefined };
}

export interface DitSidecarControlsSpec {
  readonly encoder: DitSidecarFieldSpec;
  readonly vae: DitSidecarFieldSpec;
}

function sidecarOptions(
  names: ReadonlyArray<string>,
  stored: string | undefined,
): ModelOption<"image_gen_sidecar_auto">[] {
  return [
    { kind: "key", id: "", labelKey: "image_gen_sidecar_auto" },
    ...names.map((name) => ({ kind: "raw" as const, id: name, label: name })),
    ...(stored !== undefined && !names.includes(stored)
      ? [{ kind: "raw" as const, id: stored, label: stored }]
      : []),
  ];
}

export function buildDitSidecarControls({
  backend,
  modelTemplate,
}: {
  backend: ImageGenBackendValue | undefined;
  modelTemplate: string | undefined;
}): DitSidecarControlsSpec | null {
  if (backend !== IMAGE_GEN_BACKENDS.ComfyUI || modelTemplate !== "krea2-dit") return null;
  return {
    encoder: {
      field: "encoderName",
      labelKey: "image_gen_encoder_label",
      options: sidecarOptions,
      commit: (id) => ({ encoderName: id === "" ? undefined : id }),
    },
    vae: {
      field: "vaeName",
      labelKey: "image_gen_vae_label",
      options: sidecarOptions,
      commit: (id) => ({ vaeName: id === "" ? undefined : id }),
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
export type ScalarSliderField = "steps" | "cfgScale" | "clipSkip";

export interface ScalarSliderSpec {
  readonly field: ScalarSliderField;
  readonly labelKey: "image_gen_steps_label" | "image_gen_cfg_label" | "image_gen_clip_skip_label";
  readonly range: ImageGenParamRange;
  commit(value: number): Partial<Record<ScalarSliderField, number>>;
}

export type ScalarSliders = readonly [
  ScalarSliderSpec | undefined,
  ScalarSliderSpec | undefined,
  ScalarSliderSpec | undefined,
];

/** Fixed slots preserve the pane's positional field contract while absent
 *  capability flags remove the corresponding control from both renderers. */
export function buildScalarSliders(
  capabilities: Pick<ImageGenCapabilityFlags, "supportsSteps" | "supportsCfgScale" | "supportsClipSkip" | "paramRanges">,
): ScalarSliders {
  const paramRanges = capabilities.paramRanges;
  return [
    capabilities.supportsSteps
      ? {
          field: "steps",
          labelKey: "image_gen_steps_label",
          range: paramRanges?.steps ?? IMAGE_GEN_PARAM_RANGES.steps,
          commit: (steps) => ({ steps }),
        }
      : undefined,
    capabilities.supportsCfgScale
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
  parse(raw: string): { seed: number | undefined } | null;
}

export function buildSeedField(input: Pick<ImageGenCapabilityFlags, "supportsSeed">): SeedFieldSpec | null {
  if (!input.supportsSeed) return null;
  return {
    labelKey: "image_gen_seed_label",
    parse: (raw) => {
      const trimmed = raw.trim();
      if (trimmed === "") return { seed: undefined };
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { seed: parsed } : null;
    },
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
