import type { AppDb } from "@vibe-tavern/db";
import { ImagePromptVariantStore } from "@vibe-tavern/db";
import type { ImagePromptVariantKey } from "@vibe-tavern/db";
import {
  IMAGE_GENERATION_MODES,
  IMAGE_PROMPT_DEFAULT_FAMILY,
  imagePromptCanonFamily,
  type ImagePromptFamilyId,
} from "@vibe-tavern/domain";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

/** Where a resolved variant text came from (mirrors the service-prompt
 *  resolver's override/default split; the API surface surfaces this as the
 *  is-customized flag, IPT Wave 3). */
export type ImagePromptVariantSource = "custom" | "family-canon" | "prose-canon";

export interface ResolvedImagePromptVariant {
  text: string;
  source: ImagePromptVariantSource;
}

export interface ImagePromptVariantLookup {
  /** A generation-mode slug, or the literal "negative" for the shared negative row. */
  rowKey: ImagePromptVariantKey;
  family: ImagePromptFamilyId;
}

/**
 * The full image-prompt variant resolution chain (IPT Wave 1.3 — replaces the
 * interim service-prompt bridge for template/negative rows; the images
 * service-prompt family becomes unread legacy here):
 *
 * 1. CUSTOM tier — the user's own row in `image_prompt_variants` for the
 *    (rowKey, family) pair. Free mode is family-neutral end to end: its
 *    wrapper always resolves prose, so BOTH tiers see prose for it (a
 *    (free, non-prose) row is unreachable by design).
 * 2. FAMILY-CANON tier — `imagePromptCanonFamily` decides whether the family
 *    authors the row itself; the asset is `image-{mode}.{family}.md`
 *    (or `image-negative.{family}.md`).
 * 3. PROSE-CANON tier — the universal fallback asset `image-{mode}.md`
 *    (or `image-negative.md`). For the prose family with no custom row this
 *    is byte-identical to the previous interim resolution (same asset, same
 *    loader) — the routes' pinned behavior.
 *
 * The macro pass happens at the CALL SITE (imagegen-modes), not here — the
 * resolver returns raw text, like resolveServicePrompt's contract.
 *
 * Wave 2 wires the real family (manual pin / fresh detection) above this
 * seam; until then the mode build calls this with the universal default
 * (prose), which keeps the interim behavior byte-identical.
 */
export async function resolveImagePromptVariant(
  db: AppDb,
  lookup: ImagePromptVariantLookup,
): Promise<ResolvedImagePromptVariant> {
  const { rowKey } = lookup;
  // Family-neutral free wrapper: both tiers resolve prose regardless of family.
  const family = rowKey === IMAGE_GENERATION_MODES.Free ? IMAGE_PROMPT_DEFAULT_FAMILY : lookup.family;

  const custom = await new ImagePromptVariantStore(db).get(rowKey, family);
  if (custom) {
    return { text: custom.body, source: "custom" };
  }

  const canonFamily = imagePromptCanonFamily(
    family,
    rowKey === "negative" ? "negative" : "mode",
    rowKey === "negative" ? undefined : rowKey,
  );
  const suffix = canonFamily === IMAGE_PROMPT_DEFAULT_FAMILY ? "" : `.${canonFamily}`;
  const stem = rowKey === "negative" ? "image-negative" : `image-${rowKey}`;
  const text = await loadPromptAsset(`${stem}${suffix}.md`);
  // The label compares against the REQUESTED family: a row the requested
  // family does not author (incl. the family-neutral free wrapper under any
  // non-prose family) is honestly a prose-canon fallback.
  return { text, source: canonFamily === lookup.family ? "family-canon" : "prose-canon" };
}
