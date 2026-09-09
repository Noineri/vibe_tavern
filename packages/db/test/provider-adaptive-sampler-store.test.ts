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

// LOCAL_SAMPLERS_ADDITION_REPORT B2 — llama-server numeric tail columns on the
// same boundary (provider_profiles persistence). Pins the migration defaults
// (dynatemp 0/1, top_n_sigma 0, smoothing_factor 0, dry_penalty_last_n −1 =
// disabled), create round-trip, update, and duplicate.
describe("provider_profiles numeric-tail columns (B2)", () => {
  test("defaults are disabled per upstream: dynatemp 0/1, top_n_sigma 0, smoothing 0, dry window −1", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
    });
    expect(profile.dynatempRange).toBe(0);
    expect(profile.dynatempExponent).toBe(1);
    expect(profile.topNSigma).toBe(0);
    expect(profile.smoothingFactor).toBe(0);
    // −1 = disabled: the mapper omits dry_penalty_last_n entirely (llama-server
    // rejects −1 with HTTP 400; 0 would be a zero window = DRY inert).
    expect(profile.dryPenaltyLastN).toBe(-1);
  });

  test("create round-trips explicit numeric-tail values", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
      dynatempRange: 1.5,
      dynatempExponent: 0.8,
      topNSigma: 0.95,
      smoothingFactor: 0.7,
      dryPenaltyLastN: 512,
    });
    expect(profile.dynatempRange).toBe(1.5);
    expect(profile.dynatempExponent).toBe(0.8);
    expect(profile.topNSigma).toBe(0.95);
    expect(profile.smoothingFactor).toBe(0.7);
    expect(profile.dryPenaltyLastN).toBe(512);

    const fetched = await store.getById(profile.id);
    expect(fetched?.dynatempRange).toBe(1.5);
    expect(fetched?.dynatempExponent).toBe(0.8);
    expect(fetched?.topNSigma).toBe(0.95);
    expect(fetched?.smoothingFactor).toBe(0.7);
    expect(fetched?.dryPenaltyLastN).toBe(512);
  });

  test("update rewrites the numeric-tail fields", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
    });
    const updated = await store.update(profile.id, {
      dynatempRange: 0.5,
      dynatempExponent: 1.3,
      topNSigma: 0.4,
      smoothingFactor: 0.9,
      dryPenaltyLastN: 1024,
    });
    expect(updated.dynatempRange).toBe(0.5);
    expect(updated.dynatempExponent).toBe(1.3);
    expect(updated.topNSigma).toBe(0.4);
    expect(updated.smoothingFactor).toBe(0.9);
    expect(updated.dryPenaltyLastN).toBe(1024);
  });

  test("duplicate carries the numeric-tail fields over", async () => {
    const profile = await store.create({
      name: "llama-server",
      providerPreset: "llamacpp",
      endpoint: "http://localhost:8080/v1",
      dynatempRange: 1.5,
      smoothingFactor: 0.7,
      dryPenaltyLastN: 512,
    });
    const copy = await store.duplicate(profile.id);
    expect(copy.dynatempRange).toBe(1.5);
    expect(copy.smoothingFactor).toBe(0.7);
    expect(copy.dryPenaltyLastN).toBe(512);
  });
});
