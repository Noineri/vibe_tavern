/**
 * Token-padding knob (LOCAL_SUPPORT_PLAN LS-1d) — store-level plumbing:
 * the new `token_padding` column round-trips through create/update/copy and
 * defaults to 0 for pre-existing rows (the migration adds it NOT NULL
 * DEFAULT 0, so existing profiles keep their behavior unchanged).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { effectiveContextBudget } from "@vibe-tavern/domain";

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
    id: "prov_legacy", name: "LegacyProvider", providerPreset: "openai",
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

describe("ProviderStore tokenPadding persistence (LS-1d)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ProviderStore;

  beforeEach(async () => {
    clockTick = 0;
    idCounters = new Map();
    db = await createTestDb();
    bootstrap(db);
    store = new ProviderStore(db, testIdGen, testClock);
  });

  test("defaults to 0 when not provided (pre-existing profile behavior unchanged)", async () => {
    const created = await store.create({ name: "Test", ...BASE_CREATE });
    expect(created.tokenPadding).toBe(0);
    const legacy = await store.getById("prov_legacy");
    expect(legacy!.tokenPadding).toBe(0);
  });

  test("create with tokenPadding → read back", async () => {
    const created = await store.create({ name: "Test", tokenPadding: 256, ...BASE_CREATE });
    expect(created.tokenPadding).toBe(256);
    const reloaded = await store.getById(created.id);
    expect(reloaded!.tokenPadding).toBe(256);
  });

  test("update tokenPadding to a new value", async () => {
    const created = await store.create({ name: "Test", tokenPadding: 100, ...BASE_CREATE });
    await store.update(created.id, { tokenPadding: 512 });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.tokenPadding).toBe(512);
  });

  test("update other fields → tokenPadding preserved", async () => {
    const created = await store.create({ name: "Test", tokenPadding: 300, ...BASE_CREATE });
    await store.update(created.id, { temperature: 0.7 });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.tokenPadding).toBe(300);
    expect(reloaded!.temperature).toBe(0.7);
  });

  test("profile copy carries tokenPadding", async () => {
    const created = await store.create({ name: "Test", tokenPadding: 128, ...BASE_CREATE });
    const copy = await store.duplicate(created.id);
    expect(copy.tokenPadding).toBe(128);
  });
});

describe("effectiveContextBudget (LS-1d consumption)", () => {
  test("subtracts the padding from the budget, floored at 0", () => {
    expect(effectiveContextBudget(16000, 500)).toBe(15500);
    expect(effectiveContextBudget(300, 500)).toBe(0);
    expect(effectiveContextBudget(500, 0)).toBe(500);
  });

  test("null budget passes through as null (auto) regardless of padding", () => {
    expect(effectiveContextBudget(null, 500)).toBeNull();
    expect(effectiveContextBudget(undefined, 500)).toBeNull();
  });

  test("missing padding (legacy records in flight) is treated as 0", () => {
    expect(effectiveContextBudget(16000, undefined)).toBe(16000);
    expect(effectiveContextBudget(16000, null)).toBe(16000);
  });
});
