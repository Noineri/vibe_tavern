import type { AppDb } from "@vibe-tavern/db";
import { ImagePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type { ImagePromptVariantKey } from "@vibe-tavern/db";
import {
  IMAGE_GENERATION_MODES,
  IMAGE_PROMPT_DEFAULT_FAMILY,
  imagePromptCanonFamily,
  type ImagePromptFamilyId,
  type ImagePromptOverridesMap,
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
 * The full image-prompt variant resolution chain (IPT Wave 1.3, reworked
 * IF-1c — IMAGEGEN_FOLLOWUP_REPORT):
 *
 * 1. PROFILE tier — the ACTIVE image prompt profile's override cell for the
 *    (rowKey, family) pair (`resolveActiveImagePromptOverrides` reads the
 *    pointer; a dangling pointer or the read-only Default profile resolves
 *    an empty map = pure canon). Free mode reads the requested family's
 *    saved cell first; absent a saved cell, it falls back to the neutral
 *    prose canon because no family-specific shipped scaffold exists.
 * 2. FAMILY-CANON tier — `imagePromptCanonFamily` decides whether the family
 *    authors the row itself; the asset is `image-{mode}.{family}.md`
 *    (or `image-negative.{family}.md`).
 * 3. PROSE-CANON tier — the universal fallback asset `image-{mode}.md`
 *    (or `image-negative.md`).
 *
 * The custom tier's source moved from the global `image_prompt_variants`
 * table (IPT Wave 1, retired for generation) to profile overrides; the
 * one-time startup migration snapshots pre-existing global rows into an
 * active "Imported" profile, so an upgrading install generates
 * byte-identical prompts across the switch.
 *
 * The macro pass happens at the CALL SITE (imagegen-modes), not here — the
 * resolver returns raw text, like resolveServicePrompt's contract.
 */
export async function resolveActiveImagePromptOverrides(db: AppDb): Promise<ImagePromptOverridesMap> {
  const settings = await new UiSettingsStore(db).get();
  const profileId = settings.activeImagePromptProfileId;
  if (profileId === null) return {};
  const profile = await new ImagePromptProfileStore(db).getImagePromptProfile(profileId);
  // Dangling pointer or the read-only Default → the empty map (pure canon).
  if (!profile || profile.isDefault) return {};
  return profile.overrides;
}

export async function resolveImagePromptVariant(
  lookup: ImagePromptVariantLookup,
  overrides: ImagePromptOverridesMap,
): Promise<ResolvedImagePromptVariant> {
  const { rowKey, family } = lookup;

  const custom = overrides[`${rowKey}|${family}`];
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
  // The label compares against the requested family: a row the requested
  // family does not author (including Free's neutral shipped fallback under
  // a non-prose family) is honestly a prose-canon fallback.
  return { text, source: canonFamily === lookup.family ? "family-canon" : "prose-canon" };
}
