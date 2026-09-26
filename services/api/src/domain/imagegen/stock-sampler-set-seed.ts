import { IMAGE_GEN_STOCK_SAMPLER_SET_IDS, imageGenStockSamplerSets } from "@vibe-tavern/domain";

import type { StoreContainer } from "@vibe-tavern/db";

/** The defect value the original Anima seed shipped (2026-09-26 → healed
 *  2026-09-27): the checkpoint creator's recommended upscaler as an A1111
 *  LABEL — meaningless vocabulary on the Comfy dialect (its upscaler
 *  vocabulary is upscale_models FILE names). Cleared by the boot-time heal
 *  below, per the owner ruling: stock sets carry no hardcoded upscaler
 *  names. */
const SEEDED_ANIMA_UPSCALER_LABEL = "R-ESRGAN 4x+ Anime6B";

/** Boot-time heal for the seeded defect value (owner ruling 2026-09-27: no
 *  hardcoded dialect labels in stock sets): clear the A1111 upscaler label
 *  the original seed baked into the stock Anima row. EXACT-MATCH guard on
 *  the stock row id: only the untouched seeded value is cleared — user rows
 *  are never scanned, and a user-edited stock row (any other value)
 *  survives untouched. The named trade-off: a deliberate exact re-entry of
 *  this one label into the stock row heals away too — acceptable because
 *  unset is valid on BOTH dialects (a1111: the server's own default;
 *  Comfy: the latent upscale path). */
async function healSeededAnimaUpscaler(
  stores: StoreContainer,
  rows: ReadonlyArray<{ id: string; payload: Record<string, unknown> }>,
): Promise<void> {
  const anima = rows.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima);
  if (!anima) return;
  const hires = anima.payload["hires"];
  if (
    typeof hires !== "object" || hires === null ||
    (hires as Record<string, unknown>)["upscaler"] !== SEEDED_ANIMA_UPSCALER_LABEL
  ) {
    return;
  }
  const nextHires = { ...(hires as Record<string, unknown>) };
  delete nextHires["upscaler"];
  await stores.imageGenSamplerSets.update(anima.id, {
    payload: { ...anima.payload, hires: nextHires },
  });
}

/**
 * One-time stock sampler-set seed (IF-7b): creates the four built-in preset
 * rows as ORDINARY editable rows on first boot, guarded by the
 * `uiSettings.stockImageGenSamplerSetsSeeded` marker so deletes STICK (the
 * seed never resurrects a row the user removed — the preset-to-profile
 * migration marker convention).
 *
 * Idempotency is PER ROW, not just marker-wide: a crash between rows leaves
 * the marker unset, and the next boot skips the ids that already exist and
 * completes the missing ones. The marker flips in the FINAL write, so a
 * clean completion never re-runs.
 */
export async function ensureStockImageGenSamplerSets(stores: StoreContainer): Promise<{
  /** True when at least one row was created this call. */
  created: boolean;
  /** The stock ids that exist after this call (seeded now or earlier). */
  present: number;
}> {
  const settings = await stores.uiSettings.get();
  const stock = imageGenStockSamplerSets();
  if (settings.stockImageGenSamplerSetsSeeded) {
    const existing = await stores.imageGenSamplerSets.list();
    // Cheap every-boot heal (exact-match scan; rides the list already in
    // hand): installs seeded before 2026-09-27 carry the A1111 label.
    await healSeededAnimaUpscaler(stores, existing);
    const existingIds = new Set(existing.map((row) => row.id));
    return { created: false, present: stock.filter((row) => existingIds.has(row.id)).length };
  }
  const existing = new Set((await stores.imageGenSamplerSets.list()).map((row) => row.id));
  let created = false;
  for (const row of stock.entries()) {
    const [index, def] = row;
    if (existing.has(def.id)) continue;
    await stores.imageGenSamplerSets.create({
      id: def.id,
      name: def.name,
      // Stock rows open the list in matrix order (0–3), ahead of any
      // user-created rows on a pre-IF-7b install.
      sortOrder: index,
      payload: def.payload,
    });
    created = true;
  }
  await stores.uiSettings.update({ stockImageGenSamplerSetsSeeded: true });
  // Crash-mid-seed edge: an install that seeded SOME rows under the old
  // code (marker still unset) keeps those rows — the loop above skips
  // existing ids — so the heal runs once more over the finished table.
  await healSeededAnimaUpscaler(stores, await stores.imageGenSamplerSets.list());
  return { created, present: stock.length };
}
