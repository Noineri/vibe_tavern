import { beforeEach, describe, expect, test } from "bun:test";
import { PROVIDER_PROFILE_GENERATION_DEFAULTS } from "@vibe-tavern/domain";
import { createDb } from "../src/db-connection.js";
import { coauthorConnectionSettings } from "../src/db-schema.js";
import { CoauthorConnectionSettingsStore } from "../src/stores/coauthor-connection-settings-store.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { AppDb } from "../src/db-connection.js";

/**
 * CG-1 store tests: the per-connection Co-Author generation set round-trips,
 * cascades with its provider profile, and its defaults are the same derivation
 * ProviderStore.create uses for a brand-new RP profile (the single-source
 * guarantee — no second hand-written default set anywhere).
 */

const BASE_CREATE = {
  providerPreset: "zai" as const,
  endpoint: "https://api.z.ai/api/paas/v4",
  apiKey: "sk-test",
};

describe("CoauthorConnectionSettingsStore", () => {
  let db: AppDb;
  let store: CoauthorConnectionSettingsStore;
  let providers: ProviderStore;
  let profileId: string;
  let otherProfileId: string;

  beforeEach(async () => {
    db = await createDb(":memory:");
    store = new CoauthorConnectionSettingsStore(db);
    providers = new ProviderStore(db);
    profileId = (await providers.create({ name: "Main", ...BASE_CREATE })).id;
    otherProfileId = (await providers.create({ name: "Other", ...BASE_CREATE })).id;
  });

  test("getByProviderId returns null before anything is written", async () => {
    expect(await store.getByProviderId(profileId)).toBeNull();
  });

  test("round-trip: upsert stores model + settings and get reads them back", async () => {
    const saved = await store.upsert(profileId, {
      modelName: "glm-4.7",
      settings: { maxTokens: 15_000, contextBudget: 1_048_576, temperature: 0.9 },
    });
    expect(saved.providerProfileId).toBe(profileId);
    expect(saved.modelName).toBe("glm-4.7");
    expect(saved.settings).toEqual({ maxTokens: 15_000, contextBudget: 1_048_576, temperature: 0.9 });
    expect(saved.createdAt).toBeTypeOf("string");
    expect(saved.updatedAt).toBeTypeOf("string");

    const read = await store.getByProviderId(profileId);
    expect(read).not.toBeNull();
    expect(read!.modelName).toBe("glm-4.7");
    expect(read!.settings.maxTokens).toBe(15_000);
    expect(read!.settings.temperature).toBe(0.9);
  });

  test("upsert replaces the set wholesale (stored complete, not merged field-wise)", async () => {
    await store.upsert(profileId, {
      modelName: "glm-4.7",
      settings: { maxTokens: 15_000, temperature: 0.9 },
    });
    const replaced = await store.upsert(profileId, {
      modelName: null,
      settings: { maxTokens: 4_000 },
    });
    expect(replaced.modelName).toBeNull();
    // temperature is GONE — the second write is the whole set, no field merge.
    expect(replaced.settings.temperature).toBeUndefined();
    expect(replaced.settings.maxTokens).toBe(4_000);
  });

  test("per-connection independence: one profile's set never touches another", async () => {
    await store.upsert(profileId, { modelName: "model-a", settings: { maxTokens: 111 } });
    await store.upsert(otherProfileId, { modelName: "model-b", settings: { maxTokens: 222 } });
    expect((await store.getByProviderId(profileId))!.settings.maxTokens).toBe(111);
    expect((await store.getByProviderId(otherProfileId))!.settings.maxTokens).toBe(222);
    expect((await store.list())).toHaveLength(2);
  });

  test("deleting the provider profile cascades the settings row away", async () => {
    await store.upsert(profileId, { modelName: "glm-4.7", settings: { maxTokens: 1 } });
    await providers.delete(profileId);
    expect(await store.getByProviderId(profileId)).toBeNull();
    // Raw table check — the row is physically gone, not filtered.
    const raw = db.select().from(coauthorConnectionSettings).all();
    expect(raw).toHaveLength(0);
  });

  test("a settings row cannot exist without its provider profile (FK enforced)", async () => {
    expect(() =>
      db.insert(coauthorConnectionSettings)
        .values({
          providerProfileId: "prov_ghost",
          modelName: null,
          settingsJson: "{}",
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        })
        .run(),
    ).toThrow();
  });
});

describe("single-source defaults (RP new-connection ↔ provider store)", () => {
  test("ProviderStore.create applies PROVIDER_PROFILE_GENERATION_DEFAULTS verbatim", async () => {
    const db = await createDb(":memory:");
    const providers = new ProviderStore(db);
    // Minimal create — every generation field falls back to the shared constant.
    const profile = await providers.create({ name: "Fresh", ...BASE_CREATE });

    for (const [field, value] of Object.entries(PROVIDER_PROFILE_GENERATION_DEFAULTS)) {
      expect((profile as unknown as Record<string, unknown>)[field]).toEqual(value);
    }
  });
});
