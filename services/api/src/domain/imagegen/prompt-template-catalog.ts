import { ImagePromptVariantStore } from "@vibe-tavern/db";
import type { AppDb, ImagePromptVariantKey } from "@vibe-tavern/db";
import {
  IMAGE_GENERATION_MODES,
  IMAGE_PROMPT_DEFAULT_FAMILY,
  IMAGE_PROMPT_FAMILIES,
  IMAGE_PROMPT_FAMILY_IDS,
  imagePromptCanonFamily,
  makeImagePromptCellKey,
  type ImagePromptFamilyId,
  type ImagePromptGrammar,
  type ImagePromptOverridesMap,
  type ImageGenerationMode,
} from "@vibe-tavern/domain";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

/**
 * @module imagegen/prompt-template-catalog
 *
 * IPT-3 (IMAGE_PROMPT_TEMPLATES_PLAN Wave 3): the templates-pane read model.
 * One cell per (rowKey × family) with the canon text TIER-RESOLVED
 * server-side (the family's own asset, else the prose fallback — the pane
 * never re-implements the fallback rule), the user's custom row if any,
 * and the per-row quality column. Alongside: the per-family canon quality
 * blocks (ownQuality families only — no universal fallback) and the assist
 * core + addenda with their canon text (assets) and, since SC-8d, each
 * part's custom tier from the profile's `assist|…` overrides + an
 * is-customized flag, like the mode cells.
 *
 * Writes ride the variant store directly (adapter boundary): read-modify-
 * write for the quality column (the store upsert is full-row), DELETE =
 * reset-to-canon (overrides-only table, no tombstones).
 */

/** The row keys the catalog enumerates: the eight generation modes plus
 *  the shared negative row (registry order, then negative last — the
 *  pane's row order). */
export const IMAGE_PROMPT_CATALOG_ROW_KEYS: readonly ImagePromptVariantKey[] = [
  ...Object.values(IMAGE_GENERATION_MODES),
  "negative",
];

export type ImagePromptCanonSource = "family-canon" | "prose-canon";

export interface ImagePromptTemplateCell {
  rowKey: ImagePromptVariantKey;
  family: ImagePromptFamilyId;
  canonText: string;
  canonSource: ImagePromptCanonSource;
  customText: string | null;
  qualityText: string | null;
  isCustomized: boolean;
}

export interface PromptTemplateCatalog {
  cells: ImagePromptTemplateCell[];
  /** Family id → canon quality block, AUTHORING families only. */
  qualityCanon: Partial<Record<ImagePromptFamilyId, string>>;
  assist: {
    core: string;
    /** Family id → addendum, non-prose families only (prose IS the base). */
    addenda: Partial<Record<ImagePromptFamilyId, string>>;
    /** SC-8d: the core's custom tier (`assist|prose` override). */
    coreCustom: { text: string | null; isCustomized: boolean };
    /** SC-8d: per-family addendum custom tiers (`assist|<family>` overrides),
     *  keyed like `addenda` — no entry where no canon addendum exists. */
    addendaCustom: Partial<Record<ImagePromptFamilyId, { text: string | null; isCustomized: boolean }>>;
  };
}

/** Canon asset stem for a row (`image-negative` vs `image-{mode}`). */
function canonStem(rowKey: ImagePromptVariantKey): string {
  return rowKey === "negative" ? "image-negative" : `image-${rowKey}`;
}

/** The canon tier of one (rowKey, family): which family's asset applies,
 *  its source label, and the text. `memo` dedupes reads within a single
 *  catalog build (the asset loader itself stays cache-free — live edits
 *  beside the executable stay visible ACROSS builds). */
async function canonFor(
  rowKey: ImagePromptVariantKey,
  family: ImagePromptFamilyId,
  memo: Map<string, string>,
): Promise<{ text: string; source: ImagePromptCanonSource }> {
  // Free mode's shipped fallback is neutral prose; saved overrides still
  // remain per-family through readProfilePromptVariantCell's exact cell key.
  const effective = rowKey === IMAGE_GENERATION_MODES.Free ? IMAGE_PROMPT_DEFAULT_FAMILY : family;
  const canonFamily = imagePromptCanonFamily(
    effective,
    rowKey === "negative" ? "negative" : "mode",
    rowKey === "negative" ? undefined : (rowKey as ImageGenerationMode),
  );
  const suffix = canonFamily === IMAGE_PROMPT_DEFAULT_FAMILY ? "" : `.${canonFamily}`;
  const filename = `${canonStem(rowKey)}${suffix}.md`;
  let text = memo.get(filename);
  if (text === undefined) {
    text = await loadPromptAsset(filename);
    memo.set(filename, text);
  }
  return { text, source: canonFamily === family ? "family-canon" : "prose-canon" };
}

/** One cell: canon tier + the given custom override (body + quality).
 *  The global-store reader was RETIRED with the per-cell routes (IF-1e);
 *  the profile-scoped twin below is the only cell reader. */
export function cellFromParts(
  rowKey: ImagePromptVariantKey,
  family: ImagePromptFamilyId,
  canon: { text: string; source: ImagePromptCanonSource },
  custom: { body: string; qualityText: string | null } | null,
): ImagePromptTemplateCell {
  return {
    rowKey,
    family,
    canonText: canon.text,
    canonSource: canon.source,
    customText: custom?.body ?? null,
    qualityText: custom?.qualityText ?? null,
    isCustomized: custom !== null,
  };
}

/** The profile-scoped cell reader (IF-1b): the custom tier comes from a
 *  profile's overrides map. The same shape feeds the profile detail
 *  response AND (IF-1c) generation, which passes the ACTIVE profile's
 *  overrides. */
export type ImagePromptProfileOverridesMap = ImagePromptOverridesMap;

export function readProfilePromptVariantCell(
  rowKey: ImagePromptVariantKey,
  family: ImagePromptFamilyId,
  overrides: ImagePromptProfileOverridesMap,
  memo: Map<string, string>,
): Promise<ImagePromptTemplateCell> {
  return canonFor(rowKey, family, memo).then((canon) => {
    const key = `${rowKey}|${family}` as const;
    const custom = overrides[key];
    return cellFromParts(
      rowKey,
      family,
      canon,
      custom ? { body: custom.body, qualityText: custom.qualityText ?? null } : null,
    );
  });
}

/** The profile-scoped catalog (IF-1b): every (rowKey × family) cell with
 *  its custom tier sourced from the given profile overrides. A profile
 *  with no overrides yields the all-canon catalog (the Default profile
 *  view — and the tier-matrix read model the old global GET served). The
 *  global-store builder was RETIRED with the per-cell routes (IF-1e). */
export async function buildProfileTemplateCatalog(
  overrides: ImagePromptProfileOverridesMap,
): Promise<PromptTemplateCatalog> {
  const memo = new Map<string, string>();
  const cells: ImagePromptTemplateCell[] = [];
  for (const rowKey of IMAGE_PROMPT_CATALOG_ROW_KEYS) {
    for (const family of IMAGE_PROMPT_FAMILY_IDS) {
      cells.push(await readProfilePromptVariantCell(rowKey, family, overrides, memo));
    }
  }
  return finishCatalog(cells, overrides);
}

/** Shared tail of both catalog builders: the canon quality blocks + the
 *  assist core and addenda with their custom tier from the given profile
 *  overrides (SC-8d: `assist|prose` = the core override, `assist|<family>`
 *  = that family's addendum override; absent key = canon, flag false). */
async function finishCatalog(
  cells: ImagePromptTemplateCell[],
  overrides: ImagePromptProfileOverridesMap,
): Promise<PromptTemplateCatalog> {
  const qualityCanon: PromptTemplateCatalog["qualityCanon"] = {};
  const assistAddenda: PromptTemplateCatalog["assist"]["addenda"] = {};
  const assistAddendaCustom: PromptTemplateCatalog["assist"]["addendaCustom"] = {};
  const coreCell = overrides[makeImagePromptCellKey("assist", IMAGE_PROMPT_DEFAULT_FAMILY)];
  for (const family of IMAGE_PROMPT_FAMILY_IDS) {
    if (IMAGE_PROMPT_FAMILIES[family].ownQuality) {
      qualityCanon[family] = (await loadPromptAsset(`image-quality.${family}.md`)).trim();
    }
    if (family !== IMAGE_PROMPT_DEFAULT_FAMILY) {
      assistAddenda[family] = (await loadPromptAsset(`image-assist.${family}.md`)).trim();
      const cell = overrides[makeImagePromptCellKey("assist", family)];
      assistAddendaCustom[family] = { text: cell?.body ?? null, isCustomized: cell !== undefined };
    }
  }

  return {
    cells,
    qualityCanon,
    assist: {
      core: (await loadPromptAsset("image-assist.md")).trim(),
      addenda: assistAddenda,
      coreCustom: { text: coreCell?.body ?? null, isCustomized: coreCell !== undefined },
      addendaCustom: assistAddendaCustom,
    },
  };
}

/** The registry read model (GET /prompt-families): grammar + what each
 *  family authors itself vs inherits from prose + the addendum flag. */
export function promptFamiliesReadModel(): Array<{
  id: ImagePromptFamilyId;
  grammar: ImagePromptGrammar;
  ownTemplates: boolean;
  ownNegative: boolean;
  ownQuality: boolean;
  hasAssistAddendum: boolean;
}> {
  return IMAGE_PROMPT_FAMILY_IDS.map((id) => {
    const entry = IMAGE_PROMPT_FAMILIES[id];
    return {
      id,
      grammar: entry.grammar,
      ownTemplates: entry.ownTemplates,
      ownNegative: entry.ownNegative,
      ownQuality: entry.ownQuality,
      hasAssistAddendum: id !== IMAGE_PROMPT_DEFAULT_FAMILY,
    };
  });
}
