import { describe, test, expect, beforeEach } from "bun:test";
import { MODEL_FAVORITE_SCOPE } from "@vibe-tavern/domain";
import { createDb } from "../src/db-connection.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

let tick = 0;
const clock: StoreClock = {
  now: () => new Date(Date.parse("2025-05-04T12:00:00.000Z") + ++tick).toISOString(),
};

let ids: Map<string, number>;
const idGenerator: StoreIdGenerator = {
  next(prefix) {
    const next = (ids.get(prefix) ?? 0) + 1;
    ids.set(prefix, next);
    return `${prefix}_${next}`;
  },
};

const providerData = {
  name: "Test provider",
  providerPreset: "openai",
  endpoint: "https://api.openai.com/v1",
};

describe("ProviderStore model favorites", () => {
  let store: ProviderStore;
  let profileId: string;

  beforeEach(async () => {
    tick = 0;
    ids = new Map();
    const db = await createDb(":memory:");
    store = new ProviderStore(db, { clock, idGenerator });
    profileId = (await store.create(providerData)).id;
  });

  test("lists favorites in insertion order and re-starring refreshes metadata", async () => {
    const first = await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, {
      modelId: "alpha",
      label: "Alpha",
      contextLength: 8_000,
    });
    await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, { modelId: "beta", label: "Beta" });
    const refreshed = await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, {
      modelId: "alpha",
      label: "Alpha refreshed",
      contextLength: 16_000,
    });

    expect(refreshed.id).toBe(first.id);
    expect(refreshed.label).toBe("Alpha refreshed");
    expect(refreshed.contextLength).toBe(16_000);
    expect((await store.listFavoriteModels(profileId, MODEL_FAVORITE_SCOPE.rp)).map((model) => model.modelId)).toEqual(["alpha", "beta"]);
  });

  test("removes a favorite without affecting other models", async () => {
    await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, { modelId: "alpha" });
    await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, { modelId: "beta" });

    await store.removeFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, "alpha");

    expect((await store.listFavoriteModels(profileId, MODEL_FAVORITE_SCOPE.rp)).map((model) => model.modelId)).toEqual(["beta"]);
  });

  test("deleting a profile cascades to its favorites", async () => {
    await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, { modelId: "alpha" });

    await store.delete(profileId);

    expect(await store.listFavoriteModels(profileId, MODEL_FAVORITE_SCOPE.rp)).toEqual([]);
  });

  test("keeps identical profile/model pairs independent by scope", async () => {
    await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.rp, { modelId: "alpha", label: "RP Alpha" });
    await store.addFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.coauthor, { modelId: "alpha", label: "Co-Author Alpha" });

    expect(await store.listFavoriteModels(profileId, MODEL_FAVORITE_SCOPE.rp)).toMatchObject([
      { modelId: "alpha", scope: MODEL_FAVORITE_SCOPE.rp, label: "RP Alpha" },
    ]);
    expect(await store.listFavoriteModels(profileId, MODEL_FAVORITE_SCOPE.coauthor)).toMatchObject([
      { modelId: "alpha", scope: MODEL_FAVORITE_SCOPE.coauthor, label: "Co-Author Alpha" },
    ]);

    await store.removeFavoriteModel(profileId, MODEL_FAVORITE_SCOPE.coauthor, "alpha");
    expect(await store.listFavoriteModels(profileId, MODEL_FAVORITE_SCOPE.rp)).toHaveLength(1);
    expect(await store.listFavoriteModels(profileId, MODEL_FAVORITE_SCOPE.coauthor)).toEqual([]);
  });
});
