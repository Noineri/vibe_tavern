import { imageGenStockSamplerSets } from "@vibe-tavern/domain";

import type { StoreContainer } from "@vibe-tavern/db";

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
    const existing = new Set((await stores.imageGenSamplerSets.list()).map((row) => row.id));
    return { created: false, present: stock.filter((row) => existing.has(row.id)).length };
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
  return { created, present: stock.length };
}
