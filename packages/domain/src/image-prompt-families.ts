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

/** The row-key axis of the image variant space: a generation-mode slug,
 *  or the literal `"negative"` for the shared negative row (the quality
 *  layer rides the mode-row column; the assist core is canon-only). */
export type ImagePromptVariantRowKey = ImageGenerationMode | "negative";

/** Profile overrides are keyed per cell: `"<rowKey>|<family>"` (IF-1a —
 *  image prompt profiles fork the service-prompt profile machinery, with
 *  the flat field-key axis replaced by the (row × family) cell axis). */
export type ImagePromptCellKey = `${ImagePromptVariantRowKey}|${ImagePromptFamilyId}`;

/** The separator joining rowKey and family inside an {@link ImagePromptCellKey}.
 *  Neither axis may contain it (mode slugs and family ids are word tokens). */
export const IMAGE_PROMPT_CELL_KEY_SEPARATOR = "|";

/** One cell's override payload: the user's template body plus, when
 *  customized, their own quality-layer text (absent = the family canon). */
export interface ImagePromptCellOverride {
  body: string;
  qualityText?: string | null;
}

/** Compose a cell key from its axes (the inverse of parse below). */
export function makeImagePromptCellKey(
  rowKey: ImagePromptVariantRowKey,
  family: ImagePromptFamilyId,
): ImagePromptCellKey {
  return `${rowKey}${IMAGE_PROMPT_CELL_KEY_SEPARATOR}${family}`;
}

/** Split a raw string into a validated (rowKey, family) pair; null when the
 *  key is not a `<rowKey>|<family>` composition of registry members (used to
 *  drop unknown keys at store boundaries — unknown keys never resolve canon
 *  and must not persist). */
export function parseImagePromptCellKey(key: string): { rowKey: ImagePromptVariantRowKey; family: ImagePromptFamilyId } | null {
  const sep = IMAGE_PROMPT_CELL_KEY_SEPARATOR;
  const at = key.lastIndexOf(sep);
  if (at <= 0 || at !== key.indexOf(sep)) return null;
  const rowKey = key.slice(0, at);
  const family = key.slice(at + 1);
  const isRowKey = rowKey === "negative" || Object.values(IMAGE_GENERATION_MODES).includes(rowKey as ImageGenerationMode);
  const isFamily = (IMAGE_PROMPT_FAMILY_IDS as readonly string[]).includes(family);
  return isRowKey && isFamily ? { rowKey: rowKey as ImagePromptVariantRowKey, family: family as ImagePromptFamilyId } : null;
}

/** Runtime shape guard for one cell's override payload (store boundary). */
export function isImagePromptCellOverride(value: unknown): value is ImagePromptCellOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.body !== "string") return false;
  const quality = record.qualityText;
  return quality === undefined || quality === null || typeof quality === "string";
}

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
 * `flux`; a label matching several DISTINCT registry families is the
 *  `ambiguous` outcome (a declared merge such as "NoobAI Illustrious" —
 *  never a precedence pick), while several keywords of the SAME family
 *  remain that one family. The SDXL class is checked only when no family
 *  rule matched, because plain SDXL needs the tag corpus below.
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

/** Word-based keyword rules. `keywords` match whole words of the
 *  normalized label (multi-word entries match word runs). Rule ORDER is
 *  not a precedence mechanism — every rule is evaluated and a label
 *  matching several DISTINCT families is the ambiguous outcome (the
 *  no-guess rule), never a first-match pick. */
const IMAGE_PROMPT_BASE_MODEL_RULES: ReadonlyArray<{
  family: ImagePromptFamilyId;
  keywords: readonly string[];
}> = [
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

/** The outcome of mapping one raw base-model label. `ambiguous` = the
 *  label matches several DISTINCT registry families (a declared merge —
 *  e.g. "NoobAI Illustrious"); several keywords of the SAME family are
 *  still that one family. */
export type ImagePromptBaseModelMatch =
  | { kind: "family"; family: ImagePromptFamilyId }
  | { kind: "sdxl"; label: string }
  | { kind: "ambiguous"; label: string; families: readonly ImagePromptFamilyId[] }
  | { kind: "unmapped"; label: string };

/** Does the normalized label contain the keyword as a whole word (or a
 *  whole run of words)? "animagine xl" must not match "anima";
 * "flux 1 d" must match "flux"; "sd xl base" must match "sd xl". */
function labelHasKeyword(normalized: string, keyword: string): boolean {
  const pattern = new RegExp(`(?:^| )${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$| )`);
  return pattern.test(normalized);
}

/** Map a raw authoritative base-model label onto the family registry.
 *  A label matching several DISTINCT families returns `ambiguous`
 *  carrying them — an honest miss, the user pins manually (the no-guess
 *  rule; no precedence between families). Unmapped labels (e.g. "SD 1.5"
 *  — no registry family exists for them) return `unmapped` carrying the
 *  label the same way. */
export function matchImagePromptBaseModel(rawBaseModel: string): ImagePromptBaseModelMatch {
  const normalized = normalizeBaseModelLabel(rawBaseModel);
  if (normalized.length === 0) return { kind: "unmapped", label: rawBaseModel };
  const matched = new Set<ImagePromptFamilyId>();
  for (const rule of IMAGE_PROMPT_BASE_MODEL_RULES) {
    if (rule.keywords.some((keyword) => labelHasKeyword(normalized, keyword))) {
      matched.add(rule.family);
    }
  }
  if (matched.size === 1) {
    return { kind: "family", family: [...matched][0]! };
  }
  if (matched.size > 1) {
    return { kind: "ambiguous", label: rawBaseModel, families: [...matched] };
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
