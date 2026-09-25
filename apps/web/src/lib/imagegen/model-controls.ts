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
