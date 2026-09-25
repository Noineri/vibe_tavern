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
 * (twins migrate one per unit; T1 sampler dropdown is the first).
 */

import { IMAGE_GEN_BACKENDS, type ImageGenKreaParams } from "@vibe-tavern/domain";

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
 * T6 — the Krea 2 gate: the krea backend's OWN models only (krea/krea-2/*);
 * the aggregator's third-party models have no generative controls. The gate
 * lives HERE (both surfaces ask the builder, never re-derive it). The commit
 * merge is the ONE copy — the chip's overlay arm and the pane's dual bind
 * arm both route through it. Overlay-only in v1 (the adetailerModel
 * precedent): the pane renders its section bound-only.
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
