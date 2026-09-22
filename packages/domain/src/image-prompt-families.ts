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
 * IPT Wave 3: the authoritative base-model → family mapping. Detection
 * sources read a RAW base-model label (a sidecar's `BaseModel`/
 * `baseModel`, ComfyUI's embedded safetensors header, Civitai's by-hash
 * `baseModel`, or the Prompt All-in-One extension's Civitai-resolved
 * `base_model`) and map it through this table — the label is AUTHOR
 * metadata, never a filename heuristic. Matching is word-based on the
 * normalized label (lowercase, separator runs collapsed to spaces), so
 * "Animagine" never matches the `anima` rule and "Flux.1 D" matches
 * `flux`; rule order is part of the contract (first rule wins, noobai
 * before illustrious, the concrete families before the prose group, the
 * SDXL class last because plain SDXL needs the tag corpus below).
 *
 * SDXL-class labels are deliberately NOT mapped here: SDXL 1.0 may become
 * sdxl-realism only when the author-declared tag corpus unambiguously
 * says realism/photorealistic — plain or anime-tagged SDXL merges stay an
 * honest ambiguity (the user pins once). `disambiguateSdxl` encodes that
 * rule; detection treats its undefined as a miss, never a guess.
 */

/** Normalize a raw base-model label for matching: lowercase, every run of
 *  non-alphanumeric characters collapsed to one space, trimmed. */
function normalizeBaseModelLabel(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Word-based keyword rules, in precedence order. `keywords` match whole
 *  words of the normalized label (multi-word entries match word runs). */
const IMAGE_PROMPT_BASE_MODEL_RULES: ReadonlyArray<{
  family: ImagePromptFamilyId;
  keywords: readonly string[];
}> = [
  // noobai before illustrious: a label naming both is a merge — the more
  // specific tag dialect wins deterministically (documented, not guessed).
  { family: "noobai", keywords: ["noobai"] },
  { family: "illustrious", keywords: ["illustrious"] },
  { family: "anima", keywords: ["anima"] },
  { family: "pony", keywords: ["pony"] },
  { family: "qwen", keywords: ["qwen"] },
  { family: "krea2", keywords: ["krea", "krea2"] },
  // Vendor prose bases (the prose family's own registry description lists
  // FLUX, gpt-image, Seedream, Z-Image — recognizable without clones).
  { family: "prose", keywords: ["flux", "seedream", "gpt image", "z image", "zimage"] },
];

/** SDXL-class words/runs: an architecture-level SDXL label needs the tag
 *  corpus — "SDXL 1.0", "sd_xl_base", "stable-diffusion-xl-v1-base" all
 *  land here (the modelspec stamp is architecture truth, not lineage). */
const IMAGE_PROMPT_SDXL_KEYWORDS: readonly string[] = [
  "sdxl",
  "sd xl",
  "stable diffusion xl",
];

/** The outcome of mapping one raw base-model label. */
export type ImagePromptBaseModelMatch =
  | { kind: "family"; family: ImagePromptFamilyId }
  | { kind: "sdxl"; label: string }
  | { kind: "unmapped"; label: string };

/** Does the normalized label contain the keyword as a whole word (or a
 *  whole run of words)? "animagine xl" must not match "anima";
 * "flux 1 d" must match "flux"; "sd xl base" must match "sd xl". */
function labelHasKeyword(normalized: string, keyword: string): boolean {
  const pattern = new RegExp(`(?:^| )${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$| )`);
  return pattern.test(normalized);
}

/** Map a raw authoritative base-model label onto the family registry.
 *  Unmapped labels (e.g. "SD 1.5" — no registry family exists for them)
 *  return `unmapped` carrying the label: detection surfaces it in the
 *  honest miss, the user pins manually. */
export function matchImagePromptBaseModel(rawBaseModel: string): ImagePromptBaseModelMatch {
  const normalized = normalizeBaseModelLabel(rawBaseModel);
  if (normalized.length === 0) return { kind: "unmapped", label: rawBaseModel };
  for (const rule of IMAGE_PROMPT_BASE_MODEL_RULES) {
    if (rule.keywords.some((keyword) => labelHasKeyword(normalized, keyword))) {
      return { kind: "family", family: rule.family };
    }
  }
  if (IMAGE_PROMPT_SDXL_KEYWORDS.some((keyword) => labelHasKeyword(normalized, keyword))) {
    return { kind: "sdxl", label: rawBaseModel };
  }
  return { kind: "unmapped", label: rawBaseModel };
}

/** The SDXL disambiguation rule: an author-declared tag corpus clearly
 *  says realism ONLY when a realism/photoreal tag is present AND no anime
 *  tag is — an anime+realism mix stays honestly ambiguous (undefined, the
 *  caller's miss). Word-boundary matching keeps "surrealism" from firing
 *  the realism signal. */
export function disambiguateSdxlFamily(tags: readonly string[]): ImagePromptFamilyId | undefined {
  const realism = tags.some((tag) => /\brealism\b|\bphotoreal/.test(tag.toLowerCase()));
  const anime = tags.some((tag) => /\banime\b/.test(tag.toLowerCase()));
  return realism && !anime ? "sdxl-realism" : undefined;
}

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
