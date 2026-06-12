import { describe, test, expect, beforeEach } from "bun:test";
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

async function createTestDb() {
  return await createDb(":memory:");
}

function bootstrap(db: Awaited<ReturnType<typeof createTestDb>>) {
  db.insert(schema.providerProfiles).values({
    id: "prov_1", name: "TestProvider", providerPreset: "openai",
    endpoint: "http://localhost", maxTokens: 2000,
    temperature: 1.0, topP: 1.0, topK: 0, minP: 0,
    frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1.0,
    reasoningEffort: "auto", streamResponse: 1, customSamplers: 0,
    isActive: 1,
    createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
}

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

describe("ProviderStore visionModel persistence", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ProviderStore;

  beforeEach(async () => {
    clockTick = 0;
    idCounters = new Map();
    db = await createTestDb();
    bootstrap(db);
    store = new ProviderStore(db, testIdGen, testClock);
  });

  test("create with visionModel → read back", async () => {
    const created = await store.create({
      name: "Test",
      visionModel: "vision-model-x",
      ...BASE_CREATE,
    });
    expect(created.visionModel).toBe("vision-model-x");

    const reloaded = await store.getById(created.id);
    expect(reloaded!.visionModel).toBe("vision-model-x");
  });

  test("update other field → visionModel preserved", async () => {
    const created = await store.create({
      name: "Test",
      visionModel: "vision-kept",
      ...BASE_CREATE,
    });

    await store.update(created.id, { temperature: 0.7 });

    const reloaded = await store.getById(created.id);
    expect(reloaded!.visionModel).toBe("vision-kept");
    expect(reloaded!.temperature).toBe(0.7);
  });

  test("update visionModel to new value", async () => {
    const created = await store.create({
      name: "Test",
      visionModel: "vision-old",
      ...BASE_CREATE,
    });

    await store.update(created.id, { visionModel: "vision-new" });

    const reloaded = await store.getById(created.id);
    expect(reloaded!.visionModel).toBe("vision-new");
  });

  test("update with visionModel=null clears it", async () => {
    const created = await store.create({
      name: "Test",
      visionModel: "vision-clear-me",
      ...BASE_CREATE,
    });

    await store.update(created.id, { visionModel: null });

    const reloaded = await store.getById(created.id);
    expect(reloaded!.visionModel).toBeNull();
  });

  test("partial update (no visionModel key) preserves it", async () => {
    const created = await store.create({
      name: "Test",
      visionModel: "vision-kept",
      ...BASE_CREATE,
    });

    // Only send name — visionModel not in the update data at all
    await store.update(created.id, { name: "Updated Name" });

    const reloaded = await store.getById(created.id);
    expect(reloaded!.visionModel).toBe("vision-kept");
    expect(reloaded!.name).toBe("Updated Name");
  });

  test("full-form update sending visionModel preserves it", async () => {
    const created = await store.create({
      name: "Test",
      visionModel: "my-vision-model",
      ...BASE_CREATE,
    });

    await store.update(created.id, {
      name: "Test",
      providerPreset: "openrouter",
      endpoint: "https://openrouter.ai/api/v1",
      defaultModel: "model-a",
      visionModel: "my-vision-model",
      temperature: 0.8,
      topP: 0.9,
    });

    const reloaded = await store.getById(created.id);
    expect(reloaded!.visionModel).toBe("my-vision-model");
  });
});
