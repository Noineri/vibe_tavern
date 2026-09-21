import { ImagePromptVariantStore } from "@vibe-tavern/db";
import type { AppDb, ImagePromptVariantKey } from "@vibe-tavern/db";
import {
  IMAGE_GENERATION_MODES,
  IMAGE_PROMPT_DEFAULT_FAMILY,
  IMAGE_PROMPT_FAMILIES,
  IMAGE_PROMPT_FAMILY_IDS,
  imagePromptCanonFamily,
  type ImagePromptFamilyId,
  type ImagePromptGrammar,
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
 * core + addenda (canon assets, read-only — the assist core is not an
 * override row by the Wave 1 store ruling).
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
  // Free mode is family-neutral end to end (the prose wrapper over raw
  // user text) — every family cell shows the prose canon.
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

/** One cell: canon tier + the user's custom row (body + quality column). */
export async function readPromptVariantCell(
  db: AppDb,
  rowKey: ImagePromptVariantKey,
  family: ImagePromptFamilyId,
  memo?: Map<string, string>,
): Promise<ImagePromptTemplateCell> {
  const memoMap = memo ?? new Map<string, string>();
  const canon = await canonFor(rowKey, family, memoMap);
  const custom = await new ImagePromptVariantStore(db).get(rowKey, family);
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

/** The full pane payload: every (rowKey × family) cell + canon quality
 *  blocks + the assist core and addenda. */
export async function buildPromptTemplateCatalog(db: AppDb): Promise<PromptTemplateCatalog> {
  const memo = new Map<string, string>();
  const cells: ImagePromptTemplateCell[] = [];
  for (const rowKey of IMAGE_PROMPT_CATALOG_ROW_KEYS) {
    for (const family of IMAGE_PROMPT_FAMILY_IDS) {
      cells.push(await readPromptVariantCell(db, rowKey, family, memo));
    }
  }

  const qualityCanon: PromptTemplateCatalog["qualityCanon"] = {};
  const assistAddenda: PromptTemplateCatalog["assist"]["addenda"] = {};
  for (const family of IMAGE_PROMPT_FAMILY_IDS) {
    if (IMAGE_PROMPT_FAMILIES[family].ownQuality) {
      qualityCanon[family] = (await loadPromptAsset(`image-quality.${family}.md`)).trim();
    }
    if (family !== IMAGE_PROMPT_DEFAULT_FAMILY) {
      assistAddenda[family] = (await loadPromptAsset(`image-assist.${family}.md`)).trim();
    }
  }

  return {
    cells,
    qualityCanon,
    assist: { core: (await loadPromptAsset("image-assist.md")).trim(), addenda: assistAddenda },
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
