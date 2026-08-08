/**
 * Experience resource store characterization tests
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 2 / IR-21).
 *
 * Proves the visual / chat-config / prompt-override CRUD works: visual source
 * hashing (and re-hash on edit), one-config-per-chat upsert, the global +
 * per-character prompt-override layers, and effective-override resolution. The
 * full trust-invalidation + starter-clone suite is Wave 8.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import { ExperienceResourceStore } from "../src/stores/experience-resource-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

const fixedClock: StoreClock = { now: () => "2026-08-02T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setupDb(): Promise<AppDb> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-xresource-test-"));
  return createDb(join(dataRoot, "test.db"));
}

async function seedParents(db: AppDb) {
  await db.run(
    sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'Hero', '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_1', 'Player', '', 0, 0, '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_1', 'char_1', 'branch_1', 'Test', '2026-01-01', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO chat_branches (id, chat_id, label, created_at) VALUES ('branch_1', 'chat_1', 'Main', '2026-01-01')`,
  );
  await db.run(
    sql`INSERT INTO scripts (id, name, created_at, updated_at) VALUES ('script_1', 'TTT Rules', '2026-01-01', '2026-01-01')`,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceResourceStore — visuals", () => {
  let db: AppDb;
  let store: ExperienceResourceStore;
  beforeEach(async () => {
    db = await setupDb();
    await seedParents(db);
    store = new ExperienceResourceStore(db, { clock: fixedClock, idGenerator: idGen });
    counter = 0;
  });

  test("create computes a SHA-256 source hash; update re-hashes on source change", async () => {
    const v = await store.createVisual({
      name: "Card Table",
      source: "<html>v1</html>",
      apiVersion: 1,
    });
    expect(v.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const hashV1 = v.sourceHash;

    // A non-source update does NOT change the hash.
    const renamed = await store.updateVisual(v.id, { name: "Card Table 2" });
    expect(renamed.sourceHash).toBe(hashV1);

    // A source edit DOES change the hash (trust-invalidation signal).
    const edited = await store.updateVisual(v.id, { source: "<html>v2</html>" });
    expect(edited.sourceHash).not.toBe(hashV1);
    expect(edited.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("CRUD round-trip; compatible manifest ids serialize", async () => {
    const v = await store.createVisual({
      name: "Grid",
      source: "src",
      apiVersion: 1,
      compatibleManifestIds: ["ttt", "checkers"],
      scopeType: "character",
      characterId: "char_1",
    });
    const fetched = await store.getVisualById(v.id);
    expect(fetched?.compatibleManifestIds).toEqual(["ttt", "checkers"]);
    expect(fetched?.scopeType).toBe("character");

    await store.deleteVisual(v.id);
    expect(await store.getVisualById(v.id)).toBeNull();
  });

  test("listVisualsForScope returns globals, or the scope-owned visual", async () => {
    await store.createVisual({ name: "G", source: "g", apiVersion: 1, scopeType: "global" });
    await store.createVisual({
      name: "CharOnly",
      source: "c",
      apiVersion: 1,
      scopeType: "character",
      characterId: "char_1",
    });
    expect((await store.listVisualsForScope("global", null))).toHaveLength(1);
    expect((await store.listVisualsForScope("character", "char_1"))).toHaveLength(1);
    expect((await store.listVisualsForScope("character", "char_other"))).toHaveLength(0);
  });
});

describe("ExperienceResourceStore — chat configs (one per chat)", () => {
  let db: AppDb;
  let store: ExperienceResourceStore;
  beforeEach(async () => {
    db = await setupDb();
    await seedParents(db);
    store = new ExperienceResourceStore(db, { clock: fixedClock, idGenerator: idGen });
    counter = 0;
  });

  test("getOrCreate creates a default disabled config; second call returns the same row", async () => {
    const first = await store.getOrCreateConfigForChat("chat_1");
    expect(first.enabled).toBe(false);
    expect(first.contextMode).toBe("none");
    const second = await store.getOrCreateConfigForChat("chat_1");
    expect(second.id).toBe(first.id);
  });

  test("update enables, sets grants/context, and binds a live script ref", async () => {
    await store.getOrCreateConfigForChat("chat_1");
    const updated = await store.updateConfig("chat_1", {
      enabled: true,
      scriptId: "script_1",
      capabilityGrants: ["participants", "deterministic_random"],
      contextMode: "current_branch",
    });
    expect(updated.enabled).toBe(true);
    expect(updated.scriptId).toBe("script_1");
    expect(updated.capabilityGrants).toEqual(["participants", "deterministic_random"]);
    expect(updated.contextMode).toBe("current_branch");
  });
});

describe("ExperienceResourceStore — prompt overrides (global + per-character)", () => {
  let db: AppDb;
  let store: ExperienceResourceStore;
  beforeEach(async () => {
    db = await setupDb();
    await seedParents(db);
    store = new ExperienceResourceStore(db, { clock: fixedClock, idGenerator: idGen });
    counter = 0;
  });

  test("setGlobal upserts a single global row", async () => {
    const a = await store.setGlobalOverride("be brief");
    const b = await store.setGlobalOverride("be vivid");
    expect(b.id).toBe(a.id); // same row, updated
    expect((await store.getGlobalOverride())?.content).toBe("be vivid");
  });

  test("per-character override is independent from global", async () => {
    await store.setGlobalOverride("global text");
    await store.setOverrideForCharacter("char_1", "char text");
    expect((await store.getGlobalOverride())?.content).toBe("global text");
    expect((await store.getOverrideForCharacter("char_1"))?.content).toBe("char text");
  });

  test("getEffectiveOverride prefers character over global", async () => {
    await store.setGlobalOverride("global text");
    await store.setOverrideForCharacter("char_1", "char text");
    expect((await store.getEffectiveOverride("char_1"))?.content).toBe("char text");
    expect((await store.getEffectiveOverride("char_2"))?.content).toBe("global text");
    expect(await store.getEffectiveOverride(null)).not.toBeNull();
  });

  test("deleteOverrideForCharacter removes only that character's override", async () => {
    await store.setGlobalOverride("global text");
    await store.setOverrideForCharacter("char_1", "char text");
    await store.deleteOverrideForCharacter("char_1");
    expect(await store.getOverrideForCharacter("char_1")).toBeNull();
    expect((await store.getGlobalOverride())?.content).toBe("global text");
  });
});
