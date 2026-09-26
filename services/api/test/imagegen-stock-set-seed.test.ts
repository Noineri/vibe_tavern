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
    // The matrix's own values, verbatim (owner-provided 2026-09-22); the
    // upscaler is deliberately unnamed (owner ruling 2026-09-27: no
    // hardcoded dialect vocabulary in cross-backend stock sets).
    const anima = rows.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima);
    expect(anima?.payload).toEqual({
      sampler: "euler_sde",
      scheduler: "simple",
      steps: 30,
      cfgScale: 5,
      adetailer: false,
      hires: { enabled: false, scale: 1.5, denoisingStrength: 0.35 },
    });
    const turbo = rows.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.krea2Turbo);
    expect(turbo?.payload).toEqual({ sampler: "euler", scheduler: "simple", steps: 8, cfgScale: 1, adetailer: false });
    // The face-fix block rides EVERY stock set (owner ruling 2026-09-27) —
    // configured, opt-in only, model unset (the dialect's own default).
    expect(rows.every((row) => row.payload.adetailer === false)).toBe(true);

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

  test("boot-time heal (2026-09-27): the seeded A1111 upscaler label leaves the stock Anima row; user rows and user edits survive", async () => {
    const stores = await makeStores();
    const seededPayload = {
      sampler: "euler_sde",
      scheduler: "simple",
      steps: 30,
      cfgScale: 5,
      hires: {
        enabled: false,
        upscaler: "R-ESRGAN 4x+ Anime6B",
        scale: 1.5,
        denoisingStrength: 0.35,
      },
    };
    // A pre-2026-09-27 install: the seeded marker is set, the stock Anima
    // row still carries the label, and a USER row happens to reuse it.
    await stores.imageGenSamplerSets.create({
      id: IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima,
      name: "Anima",
      payload: seededPayload,
    });
    await stores.imageGenSamplerSets.create({
      name: "My a1111 set",
      payload: { ...seededPayload, sampler: "Euler a" },
    });
    await stores.uiSettings.update({ stockImageGenSamplerSetsSeeded: true });

    const result = await ensureStockImageGenSamplerSets(stores);
    expect(result.created).toBe(false);
    const rows = await stores.imageGenSamplerSets.list();
    const healed = rows.find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima)!;
    expect(healed.payload).toEqual({
      sampler: "euler_sde",
      scheduler: "simple",
      steps: 30,
      cfgScale: 5,
      hires: { enabled: false, scale: 1.5, denoisingStrength: 0.35 },
    });
    // The user row with the SAME label is untouched (heal is stock-id-scoped).
    const userRow = rows.find((row) => row.name === "My a1111 set")!;
    expect(userRow.payload).toEqual({ ...seededPayload, sampler: "Euler a" });

    // A user EDIT of the stock row (a different upscaler) survives a reboot.
    await stores.imageGenSamplerSets.update(healed.id, {
      payload: { ...healed.payload, hires: { ...healed.payload.hires!, upscaler: "4x-UltraSharp" } as typeof healed.payload.hires },
    });
    await ensureStockImageGenSamplerSets(stores);
    const after = (await stores.imageGenSamplerSets.list())
      .find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima)!;
    expect((after.payload.hires as Record<string, unknown>).upscaler).toBe("4x-UltraSharp");
  });

  test("crash window heal: a marker-unset install with an old-code Anima row is healed at the end of seeding", async () => {
    const stores = await makeStores();
    await stores.imageGenSamplerSets.create({
      id: IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima,
      name: "Anima",
      payload: {
        sampler: "euler_sde",
        scheduler: "simple",
        steps: 30,
        cfgScale: 5,
        hires: {
          enabled: false,
          upscaler: "R-ESRGAN 4x+ Anime6B",
          scale: 1.5,
          denoisingStrength: 0.35,
        },
      },
    });

    await ensureStockImageGenSamplerSets(stores);
    const anima = (await stores.imageGenSamplerSets.list())
      .find((row) => row.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS.anima)!;
    expect((anima.payload.hires as Record<string, unknown>).upscaler).toBeUndefined();
  });
});
