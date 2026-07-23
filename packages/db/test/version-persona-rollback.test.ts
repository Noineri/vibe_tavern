import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore } from "../src/file-store.js";
import { CharacterFolder } from "../src/stores/character-folder.js";
import { CharacterStore } from "../src/stores/character-store.js";
import { VersionStore } from "../src/stores/version-store.js";
import { PersonaStore } from "../src/stores/persona-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ASYNC_TRANSACTION_AUDIT fix-step 5 (version + persona single-selection):
// pins the three transactions are truly SYNCHRONOUS bun:sqlite callbacks AND
// carries the validate-before-clear change the audit names for persona
// setDefault (a stale id used to clear every default flag then update zero
// rows without throwing — leaving NO persona as default). version-store
// `activateOnly` is private and both its callers (setActive, ensureBaseVersion)
// already validate the target up front, so its clear-then-set-stale path is
// unreachable; the createVersion test below covers the same synchronous
// clear-then-insert tx pattern for the version store.

// ─── Test harness ────────────────────────────────────────────────────────────

let counter = 0;
const clock: StoreClock = { now: () => `2026-07-22T00:00:${String((counter++ % 60)).padStart(2, "0")}.000Z` };
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_arb_${++counter}` };

async function setupVersion() {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-ver-rollback-"));
  const db = await createDb(join(dataRoot, "test.db"));
  const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
  const folder = new CharacterFolder(content);
  const characters = new CharacterStore(db, { folder, clock, idGenerator: idGen });
  const versions = new VersionStore(db, { clock, idGenerator: idGen, folder });
  return { db, characters, versions };
}

async function setupPersona() {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-pers-rollback-"));
  const db = await createDb(join(dataRoot, "test.db"));
  const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
  const store = new PersonaStore(db, { content, clock, idGenerator: idGen });
  return { db, store };
}

// ─── Version store ───────────────────────────────────────────────────────────

describe("VersionStore synchronous-transaction rollback (ASYNC_TRANSACTION_AUDIT step 5)", () => {
  test("createVersion preserves the prior active version when the insert fails after the clear", async () => {
    const { db, characters, versions } = await setupVersion();
    const char = await characters.create({ name: "Aria", description: "mage", firstMessage: "Hi" });
    const v1 = await versions.createVersion(char.id, "Base");
    const v2 = await versions.createVersion(char.id, "v2");
    expect((await versions.getActiveVersion(char.id))?.id).toBe(v2.id);

    // Fail any further INSERT on character_versions — the tx clears the active
    // flag first, THEN inserts; the insert abort must roll the clear back too.
    db.run(sql`CREATE TRIGGER fail_ver_insert BEFORE INSERT ON character_versions BEGIN SELECT RAISE(ABORT, 'injected ver boom'); END`);

    await expect(versions.createVersion(char.id, "v3")).rejects.toThrow("injected ver boom");

    // v2 still active (the clear rolled back); no v3 row landed.
    expect((await versions.getActiveVersion(char.id))?.id).toBe(v2.id);
    const all = await versions.listVersions(char.id);
    expect(all.find((v) => v.title === "v3")).toBeUndefined();
  });
});

// ─── Persona store ───────────────────────────────────────────────────────────

describe("PersonaStore synchronous-transaction rollback + validate-before-clear (ASYNC_TRANSACTION_AUDIT step 5)", () => {
  test("setDefault on a stale id throws and preserves the currently-default persona", async () => {
    const { store } = await setupPersona();
    const a = await store.create({ name: "A", description: "" });
    await store.create({ name: "B", description: "" });
    await store.setDefault(a.id);
    expect((await store.getDefault())?.id).toBe(a.id);

    // Stale id: OLD code cleared every default flag first, then updated zero
    // rows on the missing id without throwing → NO persona default. The
    // validate-before-clear makes it throw BEFORE any write, so A stays default.
    await expect(store.setDefault("persona_does_not_exist")).rejects.toThrow(/not found/i);
    expect((await store.getDefault())?.id).toBe(a.id);

    // Control: setDefault on a real id still flips the default.
    const b = (await store.listAll()).find((p) => p.name === "B")!;
    await store.setDefault(b.id);
    expect((await store.getDefault())?.id).toBe(b.id);
  });

  test("setDefault preserves the prior default when the set step fails after the clear", async () => {
    const { db, store } = await setupPersona();
    const a = await store.create({ name: "A", description: "" });
    const b = await store.create({ name: "B", description: "" });
    await store.setDefault(a.id);
    expect((await store.getDefault())?.id).toBe(a.id);

    // Fail any UPDATE that sets default_for_new_chats = 1 (the second stmt).
    db.run(sql`CREATE TRIGGER fail_pers_set BEFORE UPDATE ON personas WHEN NEW.default_for_new_chats = 1 BEGIN SELECT RAISE(ABORT, 'injected pers boom'); END`);

    await expect(store.setDefault(b.id)).rejects.toThrow("injected pers boom");

    // A still default — the clear rolled back together with the failed set.
    expect((await store.getDefault())?.id).toBe(a.id);
  });
});
