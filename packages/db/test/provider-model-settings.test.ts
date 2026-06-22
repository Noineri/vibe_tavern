import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const FIXED_NOW = "2025-05-04T12:00:00.000Z";

let clockTick = 0;
const testClock: StoreClock = {
  now() {
    clockTick++;
    return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString();
  },
};

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_test_${String(n).padStart(4, "0")}`;
  },
};

const BASE_CREATE = {
  providerPreset: "openrouter" as const,
  endpoint: "https://openrouter.ai/api/v1",
  apiKey: "sk-test",
  defaultModel: "model-a",
  contextBudget: null as null,
  temperature: 1, topP: 1, minP: 0, topK: 0, topA: 0,
  typicalP: 1, tfsZ: 1, repeatLastN: 0,
  mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
  dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2,
  drySequenceBreakers: null as null,
  xtcThreshold: 0.1, xtcProbability: 0,
  frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
  maxTokens: 2000,
  stopSequences: null as null, logitBias: null as null, seed: null as null,
  reasoningEffort: "auto" as const,
  showReasoning: false, streamResponse: true, customSamplers: false,
};

describe("ProviderStore per-model settings overlay", () => {
  let store: ProviderStore;
  let profileId: string;

  beforeEach(async () => {
    clockTick = 0;
    idCounters = new Map();
    const db = await createDb(":memory:");
    store = new ProviderStore(db, testIdGen, testClock);
    const created = await store.create({ name: "Test", ...BASE_CREATE });
    profileId = created.id;
  });

  test("getModelSettings returns null when no overlay exists", async () => {
    const got = await store.getModelSettings(profileId, "model-a");
    expect(got).toBeNull();
  });

  test("upsertModelSettings inserts; read back parses to overlay", async () => {
    const saved = await store.upsertModelSettings(profileId, "model-a", {
      temperature: 0.3,
      contextBudget: 8000,
      pinContextBudget: true,
    });
    expect(saved.modelId).toBe("model-a");
    expect(saved.settings.temperature).toBe(0.3);
    expect(saved.settings.contextBudget).toBe(8000);
    expect(saved.settings.pinContextBudget).toBe(true);

    const got = await store.getModelSettings(profileId, "model-a");
    expect(got).not.toBeNull();
    expect(got!.settings.temperature).toBe(0.3);
  });

  test("upsert is idempotent on (profileId, modelId) — second upsert overwrites", async () => {
    await store.upsertModelSettings(profileId, "model-a", { temperature: 0.3 });
    const second = await store.upsertModelSettings(profileId, "model-a", { temperature: 0.9 });
    const all = await store.listModelSettings(profileId);
    expect(all).toHaveLength(1); // not duplicated
    expect(second.settings.temperature).toBe(0.9);
    const got = await store.getModelSettings(profileId, "model-a");
    expect(got!.settings.temperature).toBe(0.9);
  });

  test("distinct models get distinct rows", async () => {
    await store.upsertModelSettings(profileId, "model-a", { temperature: 0.3 });
    await store.upsertModelSettings(profileId, "model-b", { temperature: 0.9 });
    const all = await store.listModelSettings(profileId);
    expect(all).toHaveLength(2);
    const a = await store.getModelSettings(profileId, "model-a");
    const b = await store.getModelSettings(profileId, "model-b");
    expect(a!.settings.temperature).toBe(0.3);
    expect(b!.settings.temperature).toBe(0.9);
  });

  test("arrays in the overlay round-trip intact", async () => {
    await store.upsertModelSettings(profileId, "model-a", {
      stopSequences: ["\\n\\nUser:", "<end>"],
      drySequenceBreakers: ["\\n", "\\n\\n"],
    });
    const got = await store.getModelSettings(profileId, "model-a");
    expect(got!.settings.stopSequences).toEqual(["\\n\\nUser:", "<end>"]);
    expect(got!.settings.drySequenceBreakers).toEqual(["\\n", "\\n\\n"]);
  });

  test("absent overlay fields are omitted (absent = inherit base, not undefined)", async () => {
    await store.upsertModelSettings(profileId, "model-a", { temperature: 0.5 } );
    const got = await store.getModelSettings(profileId, "model-a");
    // topP was not set — it must be ABSENT from settings, not undefined-as-a-key
    expect(got!.settings.topP).toBeUndefined();
    expect("topP" in got!.settings).toBe(false);
  });

  test("deleteModelSettings removes the overlay (revert to base)", async () => {
    await store.upsertModelSettings(profileId, "model-a", { temperature: 0.3 });
    expect(await store.getModelSettings(profileId, "model-a")).not.toBeNull();
    await store.deleteModelSettings(profileId, "model-a");
    expect(await store.getModelSettings(profileId, "model-a")).toBeNull();
  });

  test("deleteModelSettings is a no-op when none exists", async () => {
    await expect(store.deleteModelSettings(profileId, "never-bound")).resolves.toBeUndefined();
  });

  test("malformed settingsJson degrades to empty overlay (not a throw)", async () => {
    // Write a bad row directly to simulate legacy/corrupt data.
    const db = await createDb(":memory:");
    const corruptStore = new ProviderStore(db, testIdGen, testClock);
    const created = await corruptStore.create({ name: "X", ...BASE_CREATE });
    await db.insert(schema.providerModelSettings).values({
      id: "pms_bad", providerProfileId: created.id, modelId: "model-a",
      settingsJson: "{not valid json", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).run();
    const got = await corruptStore.getModelSettings(created.id, "model-a");
    expect(got).not.toBeNull();
    expect(got!.settings).toEqual({});
  });
});

describe("ProviderStore per-model overlay cascade-on-profile-delete", () => {
  test("deleting a profile cascades to its model overlays", async () => {
    clockTick = 0;
    idCounters = new Map();
    const db = await createDb(":memory:");
    const store = new ProviderStore(db, testIdGen, testClock);
    const created = await store.create({ name: "Doomed", ...BASE_CREATE });
    await store.upsertModelSettings(created.id, "model-a", { temperature: 0.3 });
    expect(await store.getModelSettings(created.id, "model-a")).not.toBeNull();

    await store.delete(created.id);

    // Row is gone (cascade), not orphaned.
    const orphan = await db.select().from(schema.providerModelSettings)
      .where(eq(schema.providerModelSettings.providerProfileId, created.id))
      .all();
    expect(orphan).toHaveLength(0);
  });
});

describe("ProviderStore bindPerModel persistence", () => {
  test("create defaults bindPerModel to false; update writes it; read returns it", async () => {
    clockTick = 0;
    idCounters = new Map();
    const db = await createDb(":memory:");
    const store = new ProviderStore(db, testIdGen, testClock);
    const created = await store.create({ name: "P", ...BASE_CREATE });
    expect(created.bindPerModel).toBe(false);

    await store.update(created.id, { bindPerModel: true });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.bindPerModel).toBe(true);

    await store.update(created.id, { bindPerModel: false });
    const off = await store.getById(created.id);
    expect(off!.bindPerModel).toBe(false);
  });
});
