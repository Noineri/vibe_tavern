import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { ImageGenSamplerSetStore } from "../src/stores/image-gen-sampler-set-store.js";
import { ImageGenStore } from "../src/stores/image-gen-store.js";
import type { CreateImageGenProfileData } from "../src/stores/image-gen-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

// IG-CF15 — image_gen_sampler_sets persistence + the overlay-side
// sampler_set_id pointer (the sampler-set-store LS-5a twin). Pins:
// (1) CRUD round-trips incl. the JSON payload column and sortOrder append,
// (2) list ordering (sortOrder then name),
// (3) getByName (the adapter's rename/create collision probe),
// (4) overlay upsert pointer semantics (undefined keeps / null clears /
//     string sets — a values-only save must NOT wipe provenance),
// (5) clearSamplerSetReferences nulling ONLY the rows pointing at the
//     deleted set while their applied values stay (LS-5e twin).

const FIXED_NOW = "2026-09-17T00:00:00.000Z";

const testClock: StoreClock = { now: () => FIXED_NOW };

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  },
};

let db: Awaited<ReturnType<typeof createDb>>;
let sets: ImageGenSamplerSetStore;
let imageGen: ImageGenStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  sets = new ImageGenSamplerSetStore(db, { clock: testClock, idGenerator: testIdGen });
  imageGen = new ImageGenStore(db, { clock: testClock, idGenerator: testIdGen });
});

describe("image_gen_sampler_sets store CRUD (IG-CF15)", () => {
  test("create appends after the last sortOrder and round-trips the payload JSON", async () => {
    const a = await sets.create({ name: "Crisp", payload: { steps: 30, sampler: "DPM++ 2M" } });
    expect(a.sortOrder).toBe(0);
    expect(a.payload).toEqual({ steps: 30, sampler: "DPM++ 2M" });

    const b = await sets.create({ name: "Soft", payload: { cfgScale: 5.5 } });
    expect(b.sortOrder).toBe(1);
  });

  test("list orders by sortOrder then name; getByName is exact", async () => {
    await sets.create({ name: "Zeta", payload: {}, sortOrder: 1 });
    await sets.create({ name: "Alpha", payload: {}, sortOrder: 0 });
    await sets.create({ name: "Beta", payload: {}, sortOrder: 0 });
    const list = await sets.list();
    expect(list.map((s) => s.name)).toEqual(["Alpha", "Beta", "Zeta"]);

    expect((await sets.getByName("Beta"))!.name).toBe("Beta");
    expect(await sets.getByName("Nope")).toBeNull();
  });

  test("update renames and overwrites the payload; delete removes", async () => {
    const a = await sets.create({ name: "Old", payload: { steps: 10 } });
    const updated = await sets.update(a.id, { name: "New", payload: { steps: 25, seed: 7 } });
    expect(updated.name).toBe("New");
    expect(updated.payload).toEqual({ steps: 25, seed: 7 });
    expect(updated.updatedAt).toBe(FIXED_NOW);

    await sets.delete(a.id);
    expect(await sets.getById(a.id)).toBeNull();
  });
});

describe("overlay sampler_set_id pointer (IG-CF15)", () => {
  const a1111Capabilities = {
    supportsNegativePrompt: true,
    supportsSamplers: true,
    supportsSeed: true,
    sizeSupport: { kind: "free" },
    noApiKey: true,
    supportsLiveProgress: true,
    localExecution: true,
    supportsImg2img: false,
    supportsInpaint: false,
  } as const;

  async function seedProfile(): Promise<string> {
    const profile = await imageGen.create({
      name: "Local",
      backend: IMAGE_GEN_BACKENDS.A1111,
      endpoint: "http://127.0.0.1:7860",
      defaultParams: {},
      modeSizePresets: {},
      llmAssistEnabled: false,
      capabilities: a1111Capabilities,
      sortOrder: 0,
    } satisfies CreateImageGenProfileData);
    return profile.id as string;
  }

  test("upsert pointer semantics: absent keeps, null clears, string sets", async () => {
    const profileId = await seedProfile();
    await imageGen.upsertModelSettings(profileId, "m1", { steps: 10 }, "set_a");
    expect((await imageGen.getModelSettings(profileId, "m1"))!.samplerSetId).toBe("set_a");

    // A values-only save must NOT wipe the pointer.
    await imageGen.upsertModelSettings(profileId, "m1", { steps: 20 });
    expect((await imageGen.getModelSettings(profileId, "m1"))!.samplerSetId).toBe("set_a");
    expect((await imageGen.getModelSettings(profileId, "m1"))!.settings.steps).toBe(20);

    // Explicit null clears it.
    await imageGen.upsertModelSettings(profileId, "m1", { steps: 20 }, null);
    expect((await imageGen.getModelSettings(profileId, "m1"))!.samplerSetId).toBeNull();
  });

  test("clearSamplerSetReferences nulls only the rows pointing at the set; values stay", async () => {
    const profileId = await seedProfile();
    await imageGen.upsertModelSettings(profileId, "m1", { steps: 30 }, "set_gone");
    await imageGen.upsertModelSettings(profileId, "m2", { steps: 40 }, "set_stays");

    await imageGen.clearSamplerSetReferences("set_gone");

    const m1 = await imageGen.getModelSettings(profileId, "m1");
    expect(m1!.samplerSetId).toBeNull();
    expect(m1!.settings.steps).toBe(30); // applied values survive (copy-on-select)
    const m2 = await imageGen.getModelSettings(profileId, "m2");
    expect(m2!.samplerSetId).toBe("set_stays"); // other rows untouched
  });
});
