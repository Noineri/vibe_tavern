/**
 * Generation-mode column (LOCAL_SUPPORT_PLAN LS-2a) — store-level plumbing:
 * the new `generation_mode` column round-trips through create/update/copy and
 * defaults to 'chat' for pre-existing rows (the migration adds it NOT NULL
 * DEFAULT 'chat', so existing profiles keep their behavior unchanged — the
 * flip to text completion is a silent, opt-in profile edit).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { GENERATION_MODE } from "@vibe-tavern/domain";

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

function bootstrap(db: Awaited<ReturnType<typeof createDb>>) {
  // Pre-migration-shaped row (no generation_mode column value) — mirrors a
  // profile that existed before 0067: the DEFAULT must backfill 'chat'.
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
  providerPreset: "lmstudio" as const,
  endpoint: "http://localhost:1234/v1",
  apiKey: null as null,
  defaultModel: "local-model",
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

describe("ProviderStore generationMode persistence (LS-2a)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let store: ProviderStore;

  beforeEach(async () => {
    clockTick = 0;
    idCounters = new Map();
    db = await createDb(":memory:");
    bootstrap(db);
    store = new ProviderStore(db, testIdGen, testClock);
  });

  test("defaults to 'chat' when not provided (pre-existing profile behavior unchanged)", async () => {
    const created = await store.create({ name: "Test", ...BASE_CREATE });
    expect(created.generationMode).toBe(GENERATION_MODE.chat);
    const legacy = await store.getById("prov_legacy");
    expect(legacy!.generationMode).toBe(GENERATION_MODE.chat);
  });

  test("create with generationMode 'completion' → read back", async () => {
    const created = await store.create({ name: "Test", generationMode: GENERATION_MODE.completion, ...BASE_CREATE });
    expect(created.generationMode).toBe(GENERATION_MODE.completion);
    const reloaded = await store.getById(created.id);
    expect(reloaded!.generationMode).toBe(GENERATION_MODE.completion);
  });

  test("flip to completion and back — the silent toggle (owner decision)", async () => {
    const created = await store.create({ name: "Test", ...BASE_CREATE });
    await store.update(created.id, { generationMode: GENERATION_MODE.completion });
    expect((await store.getById(created.id))!.generationMode).toBe(GENERATION_MODE.completion);
    // Flipping back is instant; nothing else on the row moves.
    await store.update(created.id, { generationMode: GENERATION_MODE.chat });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.generationMode).toBe(GENERATION_MODE.chat);
    expect(reloaded!.defaultModel).toBe(BASE_CREATE.defaultModel);
  });

  test("update other fields → generationMode preserved", async () => {
    const created = await store.create({ name: "Test", generationMode: GENERATION_MODE.completion, ...BASE_CREATE });
    await store.update(created.id, { temperature: 0.7 });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.generationMode).toBe(GENERATION_MODE.completion);
    expect(reloaded!.temperature).toBe(0.7);
  });

  test("profile copy carries generationMode", async () => {
    const created = await store.create({ name: "Test", generationMode: GENERATION_MODE.completion, ...BASE_CREATE });
    const copy = await store.duplicate(created.id);
    expect(copy.generationMode).toBe(GENERATION_MODE.completion);
  });
});
