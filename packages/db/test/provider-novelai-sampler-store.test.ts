import { describe, test, expect, beforeEach } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// NOVELAI_PROVIDER_PLAN NAI-1a — the six NovelAI sampler columns on
// provider_profiles. Pins: (1) the migration defaults (unified_linear 1,
// unified_quad 0, unified_conf 0, repetition_penalty_slope 0, phrase_rep_pen
// "off", thinking_mode "auto"), (2) create round-trip, (3) update round-trip,
// and (4) duplicate carrying the fields over.

const FIXED_NOW = "2026-10-05T00:00:00.000Z";

const testClock: StoreClock = { now: () => FIXED_NOW };

let idCounters: Map<string, number>;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    const n = (idCounters.get(prefix) ?? 0) + 1;
    idCounters.set(prefix, n);
    return `${prefix}_novelai_${String(n).padStart(4, "0")}`;
  },
};

let db: Awaited<ReturnType<typeof createDb>>;
let store: ProviderStore;

beforeEach(async () => {
  db = await createDb(":memory:");
  idCounters = new Map();
  store = new ProviderStore(db, { clock: testClock, idGenerator: testIdGen, content: null });
});

describe("provider_profiles NovelAI sampler columns (NAI-1a)", () => {
  test("defaults: unified 1/0/0, slope 0, phrase_rep_pen off, thinking_mode auto", async () => {
    const profile = await store.create({
      name: "novelai",
      providerPreset: "novelai_oa",
      endpoint: "https://text.novelai.net/oa/v1",
    });
    expect(profile.unifiedLinear).toBe(1);
    expect(profile.unifiedQuad).toBe(0);
    expect(profile.unifiedConf).toBe(0);
    expect(profile.repetitionPenaltySlope).toBe(0);
    expect(profile.phraseRepPen).toBe("off");
    expect(profile.thinkingMode).toBe("auto");
  });

  test("create round-trips explicit NovelAI sampler values", async () => {
    const profile = await store.create({
      name: "novelai",
      providerPreset: "novelai_oa",
      endpoint: "https://text.novelai.net/oa/v1",
      unifiedLinear: 0.8,
      unifiedQuad: 0.25,
      unifiedConf: -0.1,
      repetitionPenaltySlope: 0.33,
      phraseRepPen: "very_light",
      thinkingMode: "off",
    });
    expect(profile.unifiedLinear).toBe(0.8);
    expect(profile.unifiedQuad).toBe(0.25);
    expect(profile.unifiedConf).toBe(-0.1);
    expect(profile.repetitionPenaltySlope).toBe(0.33);
    expect(profile.phraseRepPen).toBe("very_light");
    expect(profile.thinkingMode).toBe("off");

    const fetched = await store.getById(profile.id);
    expect(fetched?.unifiedLinear).toBe(0.8);
    expect(fetched?.unifiedQuad).toBe(0.25);
    expect(fetched?.unifiedConf).toBe(-0.1);
    expect(fetched?.repetitionPenaltySlope).toBe(0.33);
    expect(fetched?.phraseRepPen).toBe("very_light");
    expect(fetched?.thinkingMode).toBe("off");
  });

  test("update rewrites the NovelAI sampler fields", async () => {
    const profile = await store.create({
      name: "novelai",
      providerPreset: "novelai_oa",
      endpoint: "https://text.novelai.net/oa/v1",
    });
    const updated = await store.update(profile.id, {
      unifiedLinear: 0.5,
      unifiedQuad: 0.4,
      unifiedConf: -0.4,
      repetitionPenaltySlope: 10,
      phraseRepPen: "aggressive",
      thinkingMode: "on",
    });
    expect(updated.unifiedLinear).toBe(0.5);
    expect(updated.unifiedQuad).toBe(0.4);
    expect(updated.unifiedConf).toBe(-0.4);
    expect(updated.repetitionPenaltySlope).toBe(10);
    expect(updated.phraseRepPen).toBe("aggressive");
    expect(updated.thinkingMode).toBe("on");
  });

  test("duplicate carries the NovelAI sampler fields over", async () => {
    const profile = await store.create({
      name: "novelai",
      providerPreset: "novelai_oa",
      endpoint: "https://text.novelai.net/oa/v1",
      unifiedLinear: 0.9,
      unifiedQuad: 0.2,
      unifiedConf: -0.2,
      repetitionPenaltySlope: 1.5,
      phraseRepPen: "medium",
      thinkingMode: "on",
    });
    const copy = await store.duplicate(profile.id);
    expect(copy.unifiedLinear).toBe(0.9);
    expect(copy.unifiedQuad).toBe(0.2);
    expect(copy.unifiedConf).toBe(-0.2);
    expect(copy.repetitionPenaltySlope).toBe(1.5);
    expect(copy.phraseRepPen).toBe("medium");
    expect(copy.thinkingMode).toBe("on");
  });
});
