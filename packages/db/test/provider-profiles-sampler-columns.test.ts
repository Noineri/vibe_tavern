import { describe, expect, it } from "bun:test";
import { SAMPLER_FIELDS } from "@vibe-tavern/domain";
import { providerProfiles } from "../src/db-schema.js";

// ─── provider_profiles sampler column coverage (ERA-1) ─────────────────────
// The canonical sampler field list is `SAMPLER_FIELDS` (@vibe-tavern/domain).
// Every one of those fields MUST have a persistence column on `providerProfiles`
// — a sampler the domain knows about but the DB cannot store is the
// avatarFullExt disease in another module: silently dropped on round-trip.
//
// Column-name shape: most sampler fields map 1:1 (camelCase JS accessor ===
// field id), but the three JSON-array fields use a `Json` suffix
// (`drySequenceBreakers` → `drySequenceBreakersJson`, `stopSequences` →
// `stopSequencesJson`, `logitBias` → `logitBiasJson`). The check accepts either
// the direct name or the `Json`-suffixed name, so it does not need a parallel
// hand-maintained field→column map that could itself drift.
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

  // Document the three intentional Json-suffixed columns explicitly, so a
  // future rename that drops the suffix (and would break the store's
  // JSON.stringify/parse mapping) is caught here, not at runtime.
  it("pins the three Json-suffixed sampler columns", () => {
    expect(columnKeys.has("drySequenceBreakersJson")).toBe(true);
    expect(columnKeys.has("stopSequencesJson")).toBe(true);
    expect(columnKeys.has("logitBiasJson")).toBe(true);
  });
});
