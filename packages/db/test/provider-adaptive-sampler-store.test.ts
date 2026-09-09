import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// LOCAL_SAMPLERS_ADDITION_REPORT B1 — adaptive-p persistence on provider_profiles.
// Pins: (1) the migration defaults (adaptive_target −1 = disabled, adaptive_decay
// 0.9 = llama.cpp default), (2) create round-trip, (3) update round-trip, and
// (4) duplicate carrying the adaptive fields over.

const FIXED_NOW = "2026-09-09T00:00:00.000Z";

const testClock: StoreClock = { now: () => FIXED_NOW };

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_adaptive_${String(n).padStart(4, "0")}`;
  },
};

let db: Awaited<ReturnType<typeof createDb>>;
let store: ProviderStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  store = new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
});

describe("provider_profiles adaptive-p columns (B1)", () => {
  test("defaults are disabled: adaptive_target −1, adaptive_decay 0.9", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
    });
    expect(profile.adaptiveTarget).toBe(-1);
    expect(profile.adaptiveDecay).toBe(0.9);
  });

  test("create round-trips explicit adaptive-p values", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
      adaptiveTarget: 0.55,
      adaptiveDecay: 0.9,
    });
    expect(profile.adaptiveTarget).toBe(0.55);
    expect(profile.adaptiveDecay).toBe(0.9);

    const fetched = await store.getById(profile.id);
    expect(fetched?.adaptiveTarget).toBe(0.55);
    expect(fetched?.adaptiveDecay).toBe(0.9);
  });

  test("update rewrites the adaptive fields", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
    });
    const updated = await store.update(profile.id, { adaptiveTarget: 0.7, adaptiveDecay: 0.85 });
    expect(updated.adaptiveTarget).toBe(0.7);
    expect(updated.adaptiveDecay).toBe(0.85);
  });

  test("duplicate carries the adaptive fields over", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
      adaptiveTarget: 0.55,
      adaptiveDecay: 0.75,
    });
    const copy = await store.duplicate(profile.id);
    expect(copy.adaptiveTarget).toBe(0.55);
    expect(copy.adaptiveDecay).toBe(0.75);
  });
});
