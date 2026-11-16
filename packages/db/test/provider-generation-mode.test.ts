/**
 * Generation-mode column (LOCAL_SUPPORT_PLAN LS-2a) — store-level plumbing:
 * the new `generation_mode` column round-trips through create/update/copy and
 * defaults to 'chat' for pre-existing rows (the migration adds it NOT NULL
 * DEFAULT 'chat', so existing profiles keep their behavior unchanged — the
 * flip to text completion is a silent, opt-in profile edit).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb } from "../src/db-connection.js";
import { ProviderStore, type CreateProviderData } from "../src/stores/provider-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";
import { GENERATION_MODE } from "@vibe-tavern/domain";
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

async function buildPre0067Folder(root: string): Promise<string> {
  const folder = join(root, "drizzle");
  const meta = join(folder, "meta");
  await mkdir(meta, { recursive: true });
  await cp(REAL_DRIZZLE, folder, { recursive: true });

  const journalPath = join(meta, "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const idx = journal.entries.findIndex((entry) => entry.tag.startsWith("0067_"));
  if (idx === -1) throw new Error("Migration 0067 is missing from the real migration journal");

  for (const entry of journal.entries.slice(idx)) {
    const prefix = entry.tag.slice(0, 4);
    await rm(join(folder, `${entry.tag}.sql`), { force: true });
    await rm(join(meta, `${prefix}_snapshot.json`), { force: true });
  }
  journal.entries = journal.entries.slice(0, idx);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

const LMSTUDIO_PRESET = {
  providerPreset: "lmstudio",
  endpoint: "http://localhost:1234/v1",
  apiKey: null,
  defaultModel: "local-model",
} as const satisfies Partial<CreateProviderData>;

function lmstudioProvider(over: Partial<CreateProviderData> = {}): CreateProviderData {
  return makeCreateProviderData({ ...LMSTUDIO_PRESET, ...over });
}

describe("ProviderStore generationMode persistence (LS-2a)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let store: ProviderStore;

  beforeEach(async () => {
    clockTick = 0;
    idCounters = new Map();
    db = await createDb(":memory:");
    store = new ProviderStore(db, { idGenerator: testIdGen, clock: testClock });
  });

  test("defaults to 'chat' when not provided and backfills pre-0067 rows during migration", async () => {
    const created = await store.create(lmstudioProvider({ name: "Test" }));
    expect(created.generationMode).toBe(GENERATION_MODE.chat);

    const work = await mkdtemp(join(tmpdir(), "vt-gen-mode-pre-"));
    const preFolder = await buildPre0067Folder(work);
    const dbPath = join(work, "upgrade.db");
    const preDb = await createDb(dbPath, preFolder);
    try {
      const colsBefore = preDb.$client
        .query<{ name: string }, []>("PRAGMA table_info('provider_profiles')")
        .all()
        .map((c) => c.name);
      expect(colsBefore).not.toContain("generation_mode");
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
      expect(colsAfter).toContain("generation_mode");

      const upgradedStore = new ProviderStore(upgradedDb, { idGenerator: testIdGen, clock: testClock });
      const legacy = await upgradedStore.getById("prov_legacy");
      expect(legacy?.name).toBe("LegacyProvider");
      expect(legacy?.generationMode).toBe(GENERATION_MODE.chat);
    } finally {
      upgradedDb.$client.close();
    }
  });

  test("create with generationMode 'completion' → read back", async () => {
    const created = await store.create(lmstudioProvider({ name: "Test", generationMode: GENERATION_MODE.completion }));
    expect(created.generationMode).toBe(GENERATION_MODE.completion);
    const reloaded = await store.getById(created.id);
    expect(reloaded!.generationMode).toBe(GENERATION_MODE.completion);
  });

  test("flip to completion and back — the silent toggle (owner decision)", async () => {
    const created = await store.create(lmstudioProvider({ name: "Test" }));
    await store.update(created.id, { generationMode: GENERATION_MODE.completion });
    expect((await store.getById(created.id))!.generationMode).toBe(GENERATION_MODE.completion);
    // Flipping back is instant; nothing else on the row moves.
    await store.update(created.id, { generationMode: GENERATION_MODE.chat });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.generationMode).toBe(GENERATION_MODE.chat);
    expect(reloaded!.defaultModel).toBe(LMSTUDIO_PRESET.defaultModel);
  });

  test("update other fields → generationMode preserved", async () => {
    const created = await store.create(lmstudioProvider({ name: "Test", generationMode: GENERATION_MODE.completion }));
    await store.update(created.id, { temperature: 0.7 });
    const reloaded = await store.getById(created.id);
    expect(reloaded!.generationMode).toBe(GENERATION_MODE.completion);
    expect(reloaded!.temperature).toBe(0.7);
  });

  test("profile copy carries generationMode", async () => {
    const created = await store.create(lmstudioProvider({ name: "Test", generationMode: GENERATION_MODE.completion }));
    const copy = await store.duplicate(created.id);
    expect(copy.generationMode).toBe(GENERATION_MODE.completion);
  });
});
