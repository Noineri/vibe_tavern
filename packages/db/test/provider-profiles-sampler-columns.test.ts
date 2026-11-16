import { describe, expect, it } from "bun:test";
import { SAMPLER_FIELDS } from "@vibe-tavern/domain";
import { createDb } from "../src/db-connection.js";
import { providerProfiles } from "../src/db-schema.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { makeCreateProviderData } from "./provider-test-builders.js";

// ─── provider_profiles sampler column coverage (ERA-1) ─────────────────────
// The canonical sampler field list is `SAMPLER_FIELDS` (@vibe-tavern/domain).
// Every one of those fields MUST have persistence coverage on `providerProfiles`
// — a sampler the domain knows about but the DB cannot store is the
// avatarFullExt disease in another module: silently dropped on round-trip.
//
// Most sampler fields map 1:1 (camelCase JS accessor === field id), while
// array-valued fields serialize into JSON columns; store round-trips below
// verify the JSON-backed fields behaviorally without coupling to suffix names.
describe("provider_profiles sampler column coverage (ERA-1)", () => {
  // Object.keys on a Drizzle table yields the camelCase column accessors
  // (Symbols are skipped by Object.keys, so no Drizzle internals leak in).
  const columnKeys = new Set(Object.keys(providerProfiles));

  it("every SAMPLER_FIELDS has a column in providerProfiles (direct or Json-suffixed)", () => {
    for (const f of SAMPLER_FIELDS) {
      const direct = columnKeys.has(f);
      const jsonSuffix = columnKeys.has(`${f}Json`);
      expect(
        direct || jsonSuffix,
        `no column for sampler field "${f}" (tried "${f}" and "${f}Json")`,
      ).toBe(true);
    }
  });

  it("round-trips JSON-serialized array sampler fields across create, getById, update, clear, and duplicate", async () => {
    const db = await createDb(":memory:");
    let tick = 0;
    const clock: StoreClock = {
      now: () => new Date(Date.parse("2026-06-06T00:00:00.000Z") + ++tick).toISOString(),
    };
    let nextId = 0;
    const idGenerator: StoreIdGenerator = { next: (prefix) => `${prefix}_col_${++nextId}` };
    const store = new ProviderStore(db, { clock, idGenerator });

    const initialBreakers = ["\n", "###", "<|eot|>"];
    const initialStops = ["\nUser:", "### End"];
    const initialBanned = [" finger", " purr"];
    const initialLogitBias = [
      { tokenId: 42, bias: -2.5, text: "foo", sourceText: "foo", model: "llama-3" },
      { tokenId: 99, bias: 1.25 },
    ];

    const created = await store.create(makeCreateProviderData({
      name: "ArraySamplers",
      drySequenceBreakers: initialBreakers,
      stopSequences: initialStops,
      bannedStrings: initialBanned,
      logitBias: initialLogitBias,
    }));
    expect(created.drySequenceBreakers).toEqual(initialBreakers);
    expect(created.stopSequences).toEqual(initialStops);
    expect(created.bannedStrings).toEqual(initialBanned);
    expect(created.logitBias).toEqual(initialLogitBias);

    const fetched = await store.getById(created.id);
    expect(fetched?.drySequenceBreakers).toEqual(initialBreakers);
    expect(fetched?.stopSequences).toEqual(initialStops);
    expect(fetched?.bannedStrings).toEqual(initialBanned);
    expect(fetched?.logitBias).toEqual(initialLogitBias);

    const copy = await store.duplicate(created.id);
    expect(copy.drySequenceBreakers).toEqual(initialBreakers);
    expect(copy.stopSequences).toEqual(initialStops);
    expect(copy.bannedStrings).toEqual(initialBanned);
    expect(copy.logitBias).toEqual(initialLogitBias);

    const nextBreakers = ["---"];
    const nextStops = ["STOP"];
    const nextBanned = [" whisper"];
    const nextLogitBias = [{ tokenId: 7, bias: -1 }];
    const updated = await store.update(created.id, {
      drySequenceBreakers: nextBreakers,
      stopSequences: nextStops,
      bannedStrings: nextBanned,
      logitBias: nextLogitBias,
    });
    expect(updated.drySequenceBreakers).toEqual(nextBreakers);
    expect(updated.stopSequences).toEqual(nextStops);
    expect(updated.bannedStrings).toEqual(nextBanned);
    expect(updated.logitBias).toEqual(nextLogitBias);

    const cleared = await store.update(created.id, {
      drySequenceBreakers: [],
      stopSequences: [],
      bannedStrings: [],
      logitBias: [],
    });
    expect(cleared.drySequenceBreakers).toEqual([]);
    expect(cleared.stopSequences).toEqual([]);
    expect(cleared.bannedStrings).toEqual([]);
    expect(cleared.logitBias).toEqual([]);
  });
});
