import { describe, expect, test } from "bun:test";

import { createDb, ScriptSafetySettingsStore } from "../src/index.js";
import type { StoreClock } from "../src/persistence.js";

const clock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };

async function makeStore(): Promise<ScriptSafetySettingsStore> {
  const db = await createDb(":memory:");
  return new ScriptSafetySettingsStore(db, { clock });
}

// SS-2 (SCRIPT_SAFETY_PLAN): the server-side singleton "don't show again"
// flag for imported-script warnings. Mirrors the proxy-store singleton
// pattern — fixed id 'default', read returns the default when absent, upsert
// replaces the row wholesale.
describe("ScriptSafetySettingsStore (SS-2 singleton)", () => {
  test("defaults to not suppressed when no row exists", async () => {
    const store = await makeStore();
    const settings = await store.get();
    expect(settings.suppressImportWarnings).toBe(false);
    expect(settings.updatedAt).toBe("");
  });

  test("upsert + get round-trips the suppress flag", async () => {
    const store = await makeStore();
    const upserted = await store.upsert({ suppressImportWarnings: true });
    expect(upserted.suppressImportWarnings).toBe(true);
    expect(upserted.updatedAt).toBe("2026-06-15T00:00:00.000Z");
    expect((await store.get()).suppressImportWarnings).toBe(true);
  });

  test("upsert replaces the previous value (singleton, never duplicates rows)", async () => {
    const store = await makeStore();
    await store.upsert({ suppressImportWarnings: true });
    await store.upsert({ suppressImportWarnings: false });
    expect((await store.get()).suppressImportWarnings).toBe(false);
  });
});
