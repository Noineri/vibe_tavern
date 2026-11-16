/**
 * Token-padding knob (LOCAL_SUPPORT_PLAN LS-1d) — store-level plumbing:
 * the new `token_padding` column round-trips through create/update/copy and
 * defaults to 0 for pre-existing rows (the migration adds it NOT NULL
 * DEFAULT 0, so existing profiles keep their behavior unchanged).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "../src/db-connection.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { effectiveContextBudget } from "@vibe-tavern/domain";
import { makeCreateProviderData } from "./provider-test-builders.js";

const REAL_DRIZZLE = resolve(import.meta.dir, "..", "drizzle");
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

async function buildPre0066Folder(root: string): Promise<string> {
  const folder = join(root, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });
  await cp(REAL_DRIZZLE, folder, { recursive: true });

  const journalPath = join(meta, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const idx = journal.entries.findIndex((entry) => entry.tag.startsWith("0066_"));
  if (idx === -1) throw new Error("Migration 0066 is missing from the real migration journal");

  for (const entry of journal.entries.slice(idx)) {
    const prefix = entry.tag.slice(0, 4);
    await rm(join(folder, `${entry.tag}.sql`), { force: true });
    await rm(join(meta, `${prefix}_snapshot.json`), { force: true });
  }
  journal.entries = journal.entries.slice(0, idx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

describe("ProviderStore tokenPadding persistence (LS-1d)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: ProviderStore;

  beforeEach(async () => {
    clockTick = 0;
    idCounters = new Map();
    db = await createTestDb();
    store = new ProviderStore(db, { idGenerator: testIdGen, clock: testClock });
  });

  test("defaults to 0 when not provided and backfills pre-0066 rows during migration", async () => {
    const created = await store.create(makeCreateProviderData({ name: "Test" }));
    expect(created.tokenPadding).toBe(0);

    const work = await mkdtemp(join(tmpdir(), "vt-token-pad-pre-"));
    const preFolder = await buildPre0066Folder(work);
    const dbPath = join(work, "upgrade.db");
    const preDb = await createDb(dbPath, preFolder);
    try {
      const colsBefore = preDb.$client
        .query<{ name: string }, []>("PRAGMA table_info('provider_profiles')")
        .all()
        .map((c) => c.name);
      expect(colsBefore).not.toContain("token_padding");
      preDb.$client.exec(`
        INSERT INTO provider_profiles (
          id, name, provider_preset, endpoint, max_tokens,
          temperature, top_p, top_k, min_p,
          frequency_penalty, presence_penalty, repetition_penalty,
          reasoning_effort, stream_response, custom_samplers, is_active,
          created_at, updated_at
        ) VALUES (
          'prov_legacy', 'LegacyProvider', 'openai', 'http://localhost', 2000,
          1.0, 1.0, 0, 0,
          0, 0, 1.0,
          'auto', 1, 0, 1,
          '${FIXED_NOW}', '${FIXED_NOW}'
        )
      `);
    } finally {
      preDb.$client.close();
    }

    const upgradedDb = await createDb(dbPath, REAL_DRIZZLE);
    try {
      const colsAfter = upgradedDb.$client
        .query<{ name: string }, []>("PRAGMA table_info('provider_profiles')")
        .all()
        .map((c) => c.name);
      expect(colsAfter).toContain("token_padding");

      const upgradedStore = new ProviderStore(upgradedDb, { idGenerator: testIdGen, clock: testClock });
      const legacy = await upgradedStore.getById("prov_legacy");
      expect(legacy?.name).toBe("LegacyProvider");
      expect(legacy?.tokenPadding).toBe(0);
    } finally {
      upgradedDb.$client.close();
    }
  });

  test("create with tokenPadding → read back", async () => {
    const created = await store.create(makeCreateProviderData({ name: "Test", tokenPadding: 256 }));
    expect(created.tokenPadding).toBe(256);
    const reloaded = await store.getById(created.id);
    expect(reloaded!.tokenPadding).toBe(256);
  });

  test("update tokenPadding to a new value", async () => {
    const created = await store.create(makeCreateProviderData({ name: "Test", tokenPadding: 100 }));
    await store.update(created.id, { tokenPadding: 512 });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.tokenPadding).toBe(512);
  });

  test("update other fields → tokenPadding preserved", async () => {
    const created = await store.create(makeCreateProviderData({ name: "Test", tokenPadding: 300 }));
    await store.update(created.id, { temperature: 0.7 });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.tokenPadding).toBe(300);
    expect(reloaded!.temperature).toBe(0.7);
  });

  test("profile copy carries tokenPadding", async () => {
    const created = await store.create(makeCreateProviderData({ name: "Test", tokenPadding: 128 }));
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
