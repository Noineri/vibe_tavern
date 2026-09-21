import { IMAGE_GENERATION_MODES, type ImageGenerationMode } from "./entities.js";

/**
 * @module image-prompt-families
 *
 * IPT (IMAGE_PROMPT_TEMPLATES_PLAN) Wave 0: the checkpoint-family registry
 * for image-prompt templates. A family is a prompt-DIALECT axis — which
 * grammar a checkpoint speaks (natural-language prose vs booru tags vs a
 * deliberate blend) — orthogonal to the generation MODE (what to depict).
 * Templates resolve per (row × family): mode templates plus the three
 * shared rows (negative / assist / quality). The canon assets live under
 * `services/api/assets/image-{row}.{family}.md`; this registry encodes, per
 * family, which rows it AUTHORS itself — everything else inherits the
 * prose canon (the universal fallback: a pinned family with no authored
 * variant for a row resolves prose, documented by the resolver below, not
 * silent).
 *
 * The registry membership mirrors the authored canon exactly: prose (the
 * universal base), four tag families (pony / illustrious / noobai / anima —
 * illustrious and noobai are SEPARATE families: their quality-tag
 * conventions differ, and the canon carries distinct files), krea2 and
 * qwen (prose-grammar checkpoints: prose templates, family assist
 * addenda; qwen keeps its own negative — the 500-char dialect canon —
 * krea2 inherits the prose default, dead-negative guidance rides its
 * assist addendum), sdxl-realism (generic SDXL realism — prose templates,
 * own negative + quality layer), and hybrid (an ASSIST-ONLY family:
 * everything but the addendum inherits prose).
 *
 * NO filename-based family detection ever (owner: no detection by
 * filename) — resolution sources are authoritative metadata or an explicit
 * manual pin (IPT Waves 2–3); this module is pure data + the
 * variant-resolution rule only. The Civitai base-model → family alias
 * table joins this module at Wave 3 alongside the detection service.
 */

/** The prompt grammar a family's templates speak. */
export const IMAGE_PROMPT_GRAMMARS = {
  /** Natural-language prose (the universal base; FLUX / Krea 2 / Qwen dialects). */
  Prose: "prose",
  /** Comma-separated lowercase booru tags (the Pony / Illustrious lineage). */
  Tags: "tags",
  /** Deliberate prose+tags blend (only the assist addendum mixes grammars). */
  Hybrid: "hybrid",
} as const;
export type ImagePromptGrammar = (typeof IMAGE_PROMPT_GRAMMARS)[keyof typeof IMAGE_PROMPT_GRAMMARS];

/** The variant-space row kinds: a generation-mode template, the shared
 *  negative, the LLM-assist addendum, the quality layer. */
export const IMAGE_PROMPT_VARIANT_KINDS = {
  Mode: "mode",
  Negative: "negative",
  Assist: "assist",
  Quality: "quality",
} as const;
export type ImagePromptVariantKind = (typeof IMAGE_PROMPT_VARIANT_KINDS)[keyof typeof IMAGE_PROMPT_VARIANT_KINDS];

/** One family's canon footprint: which rows it authors itself vs inherits
 *  from prose. `ownQuality: false` means the family has NO quality layer
 *  at all (quality tags are a tag-dialect concept — prose checkpoints have
 *  none; there is no universal quality fallback). */
export interface ImagePromptFamily {
  grammar: ImagePromptGrammar;
  /** Authors its own mode templates (the free-mode wrapper aside — see the resolver). */
  ownTemplates: boolean;
  /** Authors its own negative row; false = the prose negative applies. */
  ownNegative: boolean;
  /** Authors its own quality layer; false = no quality layer for the family. */
  ownQuality: boolean;
}

export const IMAGE_PROMPT_FAMILIES = {
  prose: { grammar: "prose", ownTemplates: true, ownNegative: true, ownQuality: false },
  pony: { grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true },
  illustrious: { grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true },
  noobai: { grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true },
  anima: { grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true },
  krea2: { grammar: "prose", ownTemplates: false, ownNegative: false, ownQuality: false },
  qwen: { grammar: "prose", ownTemplates: false, ownNegative: true, ownQuality: false },
  "sdxl-realism": { grammar: "prose", ownTemplates: false, ownNegative: true, ownQuality: true },
  hybrid: { grammar: "hybrid", ownTemplates: false, ownNegative: false, ownQuality: false },
} as const satisfies Record<string, ImagePromptFamily>;

export type ImagePromptFamilyId = keyof typeof IMAGE_PROMPT_FAMILIES;

/** Ordered id list for dropdowns / registry read models (IPT Waves 3–5). */
export const IMAGE_PROMPT_FAMILY_IDS = Object.keys(IMAGE_PROMPT_FAMILIES) as readonly ImagePromptFamilyId[];

/** The universal default AND fallback family: what an unpinned /
 *  undetected profile resolves to, and what any non-authoring family
 *  inherits its rows from. */
export const IMAGE_PROMPT_DEFAULT_FAMILY: ImagePromptFamilyId = "prose";

/**
 * The variant-resolution rule, encoded in the domain rather than left
 * implicit (IPT Wave 0.5): for a (family, kind[, mode]) the CANON OWNER is
 * the family itself when it authors that row, else prose (the universal
 * fallback). Quality is the one kind with NO universal fallback — prose
 * checkpoints have no quality tags — so non-authoring families get
 * `undefined` there (no quality layer at all).
 *
 * This is the canon tier only. The full storage-time precedence (IPT
 * Wave 1) sits ABOVE it: user-custom row for the resolved (row, family)
 * → this canon. Free mode is family-neutral by design (the prose wrapper
 * around raw user text) — it always resolves prose regardless of family.
 */
export function imagePromptCanonFamily(
  family: ImagePromptFamilyId,
  kind: "mode" | "negative" | "assist",
  mode?: ImageGenerationMode,
): ImagePromptFamilyId;
export function imagePromptCanonFamily(
  family: ImagePromptFamilyId,
  kind: "quality",
  mode?: ImageGenerationMode,
): ImagePromptFamilyId | undefined;
export function imagePromptCanonFamily(
  family: ImagePromptFamilyId,
  kind: ImagePromptVariantKind,
  mode?: ImageGenerationMode,
): ImagePromptFamilyId | undefined {
  if (kind === IMAGE_PROMPT_VARIANT_KINDS.Quality) {
    return IMAGE_PROMPT_FAMILIES[family].ownQuality ? family : undefined;
  }
  if (mode === IMAGE_GENERATION_MODES.Free) return IMAGE_PROMPT_DEFAULT_FAMILY;
  if (kind === IMAGE_PROMPT_VARIANT_KINDS.Negative) {
    return IMAGE_PROMPT_FAMILIES[family].ownNegative ? family : IMAGE_PROMPT_DEFAULT_FAMILY;
  }
  if (kind === IMAGE_PROMPT_VARIANT_KINDS.Assist) return family;
  return IMAGE_PROMPT_FAMILIES[family].ownTemplates ? family : IMAGE_PROMPT_DEFAULT_FAMILY;
}
