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

/** The stock rows the IF-7b seed created WITHOUT a base workflow — the
 *  only rows the IF-19b backfill touches (the fleet rows shipped with one). */
const WORKFLOW_BACKFILL_IDS: ReadonlySet<string> = new Set([
  IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Turbo,
  IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Raw,
  IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima,
]);

/** One-time backfill (IF-19b, owner 2026-09-29 «допиши»): the Krea 2 /
 *  Anima stock rows seeded before they named a base workflow receive the
 *  stock definition's `workflowFamily` — the channel that now routes a
 *  metadata-less model to its graph. Guarded per row: only a stock id whose
 *  name is still the stock name and whose payload names no workflow yet;
 *  a renamed row is the user's own and stays untouched, deleted rows stay
 *  deleted. Idempotent per row, so a crash before the marker flips is safe. */
async function backfillStockWorkflowFamilies(
  stores: StoreContainer,
  stock: ReturnType<typeof imageGenStockSamplerSets>,
): Promise<void> {
  const rows = await stores.imageGenSamplerSets.list();
  for (const def of stock) {
    const workflowFamily = def.payload.workflowFamily;
    if (!WORKFLOW_BACKFILL_IDS.has(def.id) || workflowFamily === undefined) continue;
    const row = rows.find((candidate) => candidate.id === def.id);
    if (!row || row.name !== def.name || row.payload.workflowFamily !== undefined) continue;
    await stores.imageGenSamplerSets.update(row.id, { payload: { ...row.payload, workflowFamily } });
  }
}

/**
 * One-time stock sampler-set seed: the original IF-7b rows and the IF-12a
 * fleet rows use separate markers. This lets an existing IF-7b installation
 * receive the fleet once while preserving later deletes from either wave.
 *
 * Idempotency is PER ROW, not just marker-wide: a crash between rows leaves
 * the wave marker unset, and the next boot skips ids that already exist and
 * completes the missing ones. Each marker flips only in the final write.
 */
export async function ensureStockImageGenSamplerSets(stores: StoreContainer): Promise<{
  /** True when at least one row was created this call. */
  created: boolean;
  /** The stock ids that exist after this call (seeded now or earlier). */
  present: number;
}> {
  const settings = await stores.uiSettings.get();
  const stock = imageGenStockSamplerSets();
  const legacyStock = stock.slice(0, 4);
  const fleetStock = stock.slice(4);
  const existing = new Set((await stores.imageGenSamplerSets.list()).map((row) => row.id));
  let created = false;

  const seedMissing = async (
    definitions: typeof stock,
    sortOrderOffset: number,
  ): Promise<void> => {
    for (const [index, def] of definitions.entries()) {
      if (existing.has(def.id)) continue;
      await stores.imageGenSamplerSets.create({
        id: def.id,
        name: def.name,
        // Matrix order keeps stock rows ahead of pre-existing user rows.
        sortOrder: sortOrderOffset + index,
        payload: def.payload,
      });
      existing.add(def.id);
      created = true;
    }
  };

  if (!settings.stockImageGenSamplerSetsSeeded) {
    await seedMissing(legacyStock, 0);
  }
  if (!settings.stockImageGenFleetSamplerSetsSeeded) {
    await seedMissing(fleetStock, legacyStock.length);
  }
  if (!settings.stockImageGenSamplerSetsSeeded || !settings.stockImageGenFleetSamplerSetsSeeded) {
    await stores.uiSettings.update({
      ...(settings.stockImageGenSamplerSetsSeeded ? {} : { stockImageGenSamplerSetsSeeded: true }),
      ...(settings.stockImageGenFleetSamplerSetsSeeded ? {} : { stockImageGenFleetSamplerSetsSeeded: true }),
    });
  }

  if (!settings.stockImageGenSetWorkflowFamiliesBackfilled) {
    await backfillStockWorkflowFamilies(stores, stock);
    await stores.uiSettings.update({ stockImageGenSetWorkflowFamiliesBackfilled: true });
  }

  // Cheap every-boot heal (exact-match scan): installs seeded before
  // 2026-09-27 carry the A1111 label on the original Anima stock row.
  await healSeededAnimaUpscaler(stores, await stores.imageGenSamplerSets.list());
  return { created, present: stock.filter((row) => existing.has(row.id)).length };
}
