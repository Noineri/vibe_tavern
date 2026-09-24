import { describe, expect, test } from "bun:test";

import { imageGenStockSamplerSets, IMAGE_GEN_STOCK_SAMPLER_SET_IDS } from "@vibe-tavern/domain";
import { createDb, UiSettingsStore, ImageGenSamplerSetStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";

import { ensureStockImageGenSamplerSets } from "../src/domain/imagegen/stock-sampler-set-seed.js";

// The seed function takes the StoreContainer but only touches TWO stores —
// build the minimal real pair over one :memory: db (the migration-test
// pattern; the stores are the REAL implementations, not doubles).
async function makeStores() {
  const db = await createDb(":memory:");
  let counter = 0;
  const options = {
    clock: { now: () => "2026-09-25T00:00:00.000Z" } satisfies StoreClock,
    idGenerator: { next: (prefix: string) => `${prefix}_test_${++counter}` } satisfies StoreIdGenerator,
  };
  return {
    uiSettings: new UiSettingsStore(db, options),
    imageGenSamplerSets: new ImageGenSamplerSetStore(db, options),
  };
}

describe("stock sampler-set seed (IF-7b)", () => {
  test("first boot creates the four stock rows in matrix order + flips the marker; a second call is a no-op", async () => {
    const stores = await makeStores();
    const first = await ensureStockImageGenSamplerSets(stores);
    expect(first.created).toBe(true);
    expect(first.present).toBe(4);

    const rows = await stores.imageGenSamplerSets.list();
    expect(rows.map((row) => row.id)).toEqual([
      IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Turbo,
      IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Raw,
      IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima,
      IMAGE_GEN_STOCK_SAMPLER_SET_IDS.diffusion,
    ]);
    // The matrix's own values, verbatim (owner-provided 2026-09-22).
    const anima = rows.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima);
    expect(anima?.payload).toEqual({
      sampler: "euler_sde",
      scheduler: "simple",
      steps: 30,
      cfgScale: 5,
      hires: { enabled: false, upscaler: "R-ESRGAN 4x+ Anime6B", scale: 1.5, denoisingStrength: 0.35 },
    });
    const turbo = rows.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Turbo);
    expect(turbo?.payload).toEqual({ sampler: "euler", scheduler: "simple", steps: 8, cfgScale: 1 });

    // Marker persisted: the seed never re-runs.
    const settings = await stores.uiSettings.get();
    expect(settings.stockImageGenSamplerSetsSeeded).toBe(true);
    const second = await ensureStockImageGenSamplerSets(stores);
    expect(second.created).toBe(false);
    expect((await stores.imageGenSamplerSets.list()).length).toBe(4);
  });

  test("deletes stick: a marked install never resurrects removed stock rows, and a rename survives", async () => {
    const stores = await makeStores();
    await ensureStockImageGenSamplerSets(stores);
    await stores.imageGenSamplerSets.delete(IMAGE_GEN_STOCK_SAMPLER_SET_IDS.diffusion);
    // Rename a stock row like any user row (fixed id stays).
    const listed = await stores.imageGenSamplerSets.list();
    const anima = listed.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima)!;
    await stores.imageGenSamplerSets.update(anima.id, { name: "My Anima" });

    const again = await ensureStockImageGenSamplerSets(stores);
    expect(again.created).toBe(false);
    expect(again.present).toBe(3);
    const after = await stores.imageGenSamplerSets.list();
    expect(after.some((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.diffusion)).toBe(false);
    expect(after.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima)?.name).toBe("My Anima");
  });

  test("crash window: marker unset + some rows existing → the seed completes only the missing ones", async () => {
    const stores = await makeStores();
    // Simulate a crash between rows: one stock row exists, marker still false.
    const partial = imageGenStockSamplerSets()[0]!;
    await stores.imageGenSamplerSets.create({ id: partial.id, name: partial.name, payload: partial.payload });

    const result = await ensureStockImageGenSamplerSets(stores);
    expect(result.created).toBe(true);
    const rows = await stores.imageGenSamplerSets.list();
    expect(rows.length).toBe(4);
    // No duplicate of the pre-existing row.
    expect(rows.filter((row) => row.id === partial.id).length).toBe(1);
  });
});
