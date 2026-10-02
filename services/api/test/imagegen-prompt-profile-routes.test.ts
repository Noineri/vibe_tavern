import { describe, test, expect } from "bun:test";
import { createDb, ImagePromptVariantStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { createImagePromptProfileRoutes } from "../src/api/routes/image-prompt-profiles.js";
import { ImagePromptProfileAdapter } from "../src/api/adapters/image-prompt-profile-adapter.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";

const fixedClock: StoreClock = { now: () => "2026-09-22T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = {
  next: (prefix) => `${prefix}_test_${++counter}`,
};

interface Cell {
  rowKey: string;
  family: string;
  customText: string | null;
  qualityText: string | null;
  isCustomized: boolean;
}

async function setupAdapter() {
  counter = 0;
  const db = await createDb(":memory:");
  const adapter = new ImagePromptProfileAdapter({ db });
  const app = createImagePromptProfileRoutes(adapter);
  const globalVariants = new ImagePromptVariantStore(db, { clock: fixedClock, idGenerator: idGen });
  return { db, adapter, app, globalVariants };
}

function jsonInit() {
  return { headers: { "Content-Type": "application/json" } };
}

async function createProfile(app: ReturnType<typeof createImagePromptProfileRoutes>, name: string, overrides?: object) {
  const res = await app.request("/api/image-gen/prompt-profiles", {
    method: "POST",
    ...jsonInit(),
    body: JSON.stringify({ name, overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

describe("IF-1b image prompt profile routes (real adapter + in-memory DB)", () => {
  test("GET /profiles self-heals Default and returns activeProfileId; reorder pins Default", async () => {
    const { app } = await setupAdapter();

    const first = await app.request("/api/image-gen/prompt-profiles");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { profiles: Array<{ id: string; name: string; isDefault: boolean }>; activeProfileId: string | null };
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]!.id).toBe("default");
    expect(body.profiles[0]!.isDefault).toBe(true);
    expect(body.activeProfileId).toBeNull();

    const a = await createProfile(app, "Alpha");
    const b = await createProfile(app, "Beta");
    await app.request("/api/image-gen/prompt-profiles/active", {
      method: "PUT",
      ...jsonInit(),
      body: JSON.stringify({ profileId: b.id }),
    });

    const reorder = await app.request("/api/image-gen/prompt-profiles/reorder", {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({ updates: [{ id: b.id, sortOrder: 0 }, { id: a.id, sortOrder: 1 }, { id: "default", sortOrder: 99 }] }),
    });
    expect(reorder.status).toBe(200);
    const reordered = (await reorder.json()) as { profiles: Array<{ id: string }>; activeProfileId: string | null };
    expect(reordered.profiles.map((p) => p.id)).toEqual(["default", b.id, a.id]);
    expect(reordered.activeProfileId).toBe(b.id);
  });

  test("GET detail returns the PROFILE-scoped catalog; global variants do not leak in", async () => {
    const { app, globalVariants } = await setupAdapter();
    // A stale global row from the pre-IF-1 world must NOT surface in a
    // profile's cells — the custom tier is profile-only.
    await globalVariants.upsert({ rowKey: "portrait", family: "prose", body: "GLOBAL-STALE" });

    const profile = await createProfile(app, "Tuned", {
      "portrait|pony": { body: "PONY-BODY", qualityText: "PONY-QUAL" },
      "negative|qwen": { body: "NEG-BODY" },
    });
    expect(profile.name).toBe("Tuned");

    const res = await app.request(`/api/image-gen/prompt-profiles/${profile.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      profile: { overrides: Record<string, unknown> };
      catalog: { cells: Cell[]; qualityCanon: Record<string, string>; assist: { core: string; addenda: Record<string, string> } };
    };
    expect(detail.profile.overrides["portrait|pony"]).toEqual({ body: "PONY-BODY", qualityText: "PONY-QUAL" });

    const byKey = (rowKey: string, family: string) => detail.catalog.cells.find((c) => c.rowKey === rowKey && c.family === family)!;
    expect(byKey("portrait", "pony").customText).toBe("PONY-BODY");
    expect(byKey("portrait", "pony").qualityText).toBe("PONY-QUAL");
    expect(byKey("portrait", "pony").isCustomized).toBe(true);
    // Prose canon still feeds the canon tier of the pony cell's siblings.
    expect(byKey("portrait", "prose").customText).toBeNull();
    expect(byKey("portrait", "prose").canonText.length).toBeGreaterThan(0);
    // The stale GLOBAL row is invisible — profile scoping.
    expect(byKey("portrait", "prose").customText).toBeNull();
    expect(byKey("portrait", "prose").isCustomized).toBe(false);
    expect(byKey("negative", "qwen").customText).toBe("NEG-BODY");
    // Catalog chrome rides along (quality canon for authoring families, assist).
    expect(detail.catalog.qualityCanon["pony"]).toBeDefined();
    expect(detail.catalog.assist.core.length).toBeGreaterThan(0);

    const missing = await app.request("/api/image-gen/prompt-profiles/ipp_none");
    expect(missing.status).toBe(404);
  });

  test("PATCH saves whole-profile overrides + rename; trim-empty quality clears to canon", async () => {
    const { app } = await setupAdapter();
    const profile = await createProfile(app, "Draft", { "portrait|prose": { body: "OLD" } });

    const res = await app.request(`/api/image-gen/prompt-profiles/${profile.id}`, {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({
        name: "Tuned",
        overrides: {
          "portrait|prose": { body: "NEW", qualityText: "   " },
          "selfie|krea2": { body: "SELFIE" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { name: string; overrides: Record<string, unknown> };
    expect(updated.name).toBe("Tuned");
    expect(updated.overrides["portrait|prose"]).toEqual({ body: "NEW", qualityText: null });
    expect(updated.overrides["selfie|krea2"]).toEqual({ body: "SELFIE", qualityText: null });
  });

  test("semantic guards allow per-family Free cells but reject quality on non-authoring families", async () => {
    const { app } = await setupAdapter();

    const free = await app.request("/api/image-gen/prompt-profiles", {
      method: "POST",
      ...jsonInit(),
      body: JSON.stringify({ name: "Free by family", overrides: { "free|pony": { body: "X" } } }),
    });
    expect(free.status).toBe(201);
    expect(((await free.json()) as { overrides: Record<string, unknown> }).overrides["free|pony"]).toEqual({ body: "X", qualityText: null });

    const profile = await createProfile(app, "Ok");
    const quality = await app.request(`/api/image-gen/prompt-profiles/${profile.id}`, {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({ overrides: { "portrait|krea2": { body: "X", qualityText: "Q" } } }),
    });
    expect(quality.status).toBe(400);
    expect(((await quality.json()) as { error: string }).error).toContain("portrait|krea2");
    // krea2 authors no quality layer, but a plain body is fine.
    const plain = await app.request(`/api/image-gen/prompt-profiles/${profile.id}`, {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({ overrides: { "portrait|krea2": { body: "X" } } }),
    });
    expect(plain.status).toBe(200);
  });

  test("Default is read-only (PATCH/DELETE → 403); unknown id → 404", async () => {
    const { app } = await setupAdapter();
    await app.request("/api/image-gen/prompt-profiles");

    const patch = await app.request("/api/image-gen/prompt-profiles/default", {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(patch.status).toBe(403);

    const del = await app.request("/api/image-gen/prompt-profiles/default", { method: "DELETE" });
    expect(del.status).toBe(403);

    const missing = await app.request("/api/image-gen/prompt-profiles/ipp_none", {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({ name: "X" }),
    });
    expect(missing.status).toBe(404);
  });

  test("Default detail catalog: every (rowKey × family) cell, canon tiered server-side (the retired global GET matrix)", async () => {
    const { app } = await setupAdapter();
    await app.request("/api/image-gen/prompt-profiles");
    const res = await app.request("/api/image-gen/prompt-profiles/default");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      catalog: {
        cells: Array<{ rowKey: string; family: string; canonText: string; canonSource: string; customText: string | null; qualityText: string | null; isCustomized: boolean }>;
        qualityCanon: Record<string, string>;
        assist: { core: string; addenda: Record<string, string> };
      };
    };
    // 8 modes + the negative row, × 9 families — the Default carries no
    // overrides, so this is the pure canon matrix.
    expect(payload.catalog.cells).toHaveLength(81);
    const cell = (rowKey: string, family: string) => payload.catalog.cells.find((c) => c.rowKey === rowKey && c.family === family)!;
    // Authored variant → family-canon with the family's own asset.
    expect(cell("portrait", "pony").canonSource).toBe("family-canon");
    expect(cell("portrait", "pony").canonText).toBe(await loadPromptAsset("image-portrait.pony.md"));
    // Prose base → family-canon for its own asset too.
    expect(cell("portrait", "prose").canonSource).toBe("family-canon");
    expect(cell("portrait", "prose").canonText).toBe(await loadPromptAsset("image-portrait.md"));
    // A non-authoring family inherits the prose canon — labeled honestly.
    expect(cell("portrait", "krea2").canonSource).toBe("prose-canon");
    expect(cell("portrait", "krea2").canonText).toBe(await loadPromptAsset("image-portrait.md"));
    // The negative row: qwen owns its own, krea2 inherits prose.
    expect(cell("negative", "qwen").canonSource).toBe("family-canon");
    expect(cell("negative", "qwen").canonText).toBe(await loadPromptAsset("image-negative.qwen.md"));
    expect(cell("negative", "krea2").canonSource).toBe("prose-canon");
    // Free has one neutral shipped fallback; a saved cell may still override
    // it per family.
    expect(cell("free", "pony").canonSource).toBe("prose-canon");
    expect(cell("free", "pony").canonText).toBe(await loadPromptAsset("image-free.md"));
    // Clean profile: no custom cells anywhere.
    expect(payload.catalog.cells.every((c) => c.isCustomized === false && c.customText === null && c.qualityText === null)).toBe(true);
    // Quality canon: AUTHORING families only, text from the assets.
    expect(Object.keys(payload.catalog.qualityCanon).sort()).toEqual(["anima", "illustrious", "noobai", "pony", "sdxl-realism"]);
    expect(payload.catalog.qualityCanon["pony"]).toBe((await loadPromptAsset("image-quality.pony.md")).trim());
    // Assist: the shared core + one addendum per non-prose family.
    expect(payload.catalog.assist.core).toBe((await loadPromptAsset("image-assist.md")).trim());
    expect(Object.keys(payload.catalog.assist.addenda).sort()).toEqual(
      ["anima", "hybrid", "illustrious", "krea2", "noobai", "pony", "qwen", "sdxl-realism"],
    );
    expect(payload.catalog.assist.addenda["pony"]).toBe((await loadPromptAsset("image-assist.pony.md")).trim());
  });

  test("schema guards: unknown cell key and blank body are rejected (the retired PUT guards' contract heirs)", async () => {
    const { app } = await setupAdapter();
    const profile = await createProfile(app, "Guards");

    const unknownKey = await app.request(`/api/image-gen/prompt-profiles/${profile.id}`, {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({ overrides: { "hologram|pony": { body: "x" } } }),
    });
    expect(unknownKey.status).toBe(400);

    const blankBody = await app.request(`/api/image-gen/prompt-profiles/${profile.id}`, {
      method: "PATCH",
      ...jsonInit(),
      body: JSON.stringify({ overrides: { "portrait|pony": { body: "" } } }),
    });
    expect(blankBody.status).toBe(400);
  });

  test("DELETE removes a profile and clears the active pointer when it pointed there", async () => {
    const { app } = await setupAdapter();
    const profile = await createProfile(app, "Temp");
    await app.request("/api/image-gen/prompt-profiles/active", {
      method: "PUT",
      ...jsonInit(),
      body: JSON.stringify({ profileId: profile.id }),
    });
    let list = (await (await app.request("/api/image-gen/prompt-profiles")).json()) as { activeProfileId: string | null };
    expect(list.activeProfileId).toBe(profile.id);

    const del = await app.request(`/api/image-gen/prompt-profiles/${profile.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    list = (await (await app.request("/api/image-gen/prompt-profiles")).json()) as { activeProfileId: string | null };
    expect(list.profiles.map((p) => p.id)).toEqual(["default"]);
    expect(list.activeProfileId).toBeNull();

    const activeUnknown = await app.request("/api/image-gen/prompt-profiles/active", {
      method: "PUT",
      ...jsonInit(),
      body: JSON.stringify({ profileId: "ipp_missing" }),
    });
    expect(activeUnknown.status).toBe(404);
  });
});
