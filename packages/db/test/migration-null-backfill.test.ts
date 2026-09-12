import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";

/**
 * 0059-class regression tests (2026-09-04 incident): a drizzle-kit table
 * rebuild that tightens a nullable column to `DEFAULT <v> NOT NULL` dies on
 * the INSERT…SELECT whenever legacy rows still hold NULLs in that column —
 * and the resulting heal stamps LATER migrations, jumping the watermark past
 * the skipped rebuild so migrate() never retries it (silent permanent gap).
 *
 * The two db-connection hooks under test:
 *  1. preBackfillPendingRebuilds — legacy NULLs are backfilled BEFORE
 *     migrate(), so a still-pending rebuild applies in-order (no crash, no
 *     scary heal output at boot).
 *  2. repairSkippedRebuilds — an UNSTAMPED rebuild whose target table is
 *     still in the legacy shape (nullable where NOT NULL is required) is
 *     re-applied transactionally and stamped, closing the watermark gap.
 *
 * The synthetic migrations folder mirrors the incident's exact shape: the
 * real squashed baseline (0000), a lore_entries rebuild (0001) that tightens
 * `content_hash` (nullable in the baseline) to `DEFAULT '' NOT NULL`, and a
 * trivial later migration (0002) that plays the role of 0060 — the simple
 * migration whose heal-stamp stranded the rebuild.
 */

const W0 = 1_700_000_000_000;
const W1 = W0 + 1_000;
const W2 = W1 + 1_000;
const REBUILD_TAG = "0001_rebuild_lore_nulls";
const MARKER_TAG = "0002_synthetic_marker";

/** Derive the synthetic lore_entries rebuild from the real baseline: same
 *  columns, but `content_hash` tightened from nullable to DEFAULT '' NOT NULL.
 *  Derived at runtime (not copy-pasted) so the test tracks baseline drift. */
function deriveRebuildSql(baselineSql: string): string {
  const block = baselineSql.match(/CREATE TABLE `lore_entries` \(([\s\S]*?)\n\);/);
  if (!block) throw new Error("baseline lore_entries block not found");
  const body = block[1];
  const columns = [...body.matchAll(/^\t`(\w+)`/gm)].map((m) => m[1]);
  if (columns.length < 10) throw new Error(`unexpected baseline column count: ${columns.length}`);
  if (!columns.includes("content_hash")) throw new Error("content_hash missing from baseline");
  const rebuiltBody = body.replace("`content_hash` text", "`content_hash` text DEFAULT '' NOT NULL");
  const colList = columns.map((c) => "`" + c + "`").join(", ");
  return [
    "PRAGMA foreign_keys=OFF;",
    "CREATE TABLE `__new_lore_entries` (" + rebuiltBody + "\n);",
    `INSERT INTO \`__new_lore_entries\`(${colList}) SELECT ${colList} FROM \`lore_entries\`;`,
    "DROP TABLE `lore_entries`;",
    "ALTER TABLE `__new_lore_entries` RENAME TO `lore_entries`;",
    "CREATE INDEX `idx_lore_entries_lorebook` ON `lore_entries` (`lorebook_id`);",
  ].join("\n--> statement-breakpoint\n");
}

interface SyntheticFolders {
  folderBase: string;
  folderFull: string;
  rebuildSql: string;
  rebuildHash: string;
  markerSql: string;
}

async function buildSyntheticFolders(): Promise<SyntheticFolders> {
  const baselineSrc = resolve(import.meta.dir, "..", "drizzle", "0000_baseline.sql");
  const baselineSql = await Bun.file(baselineSrc).text();
  const rebuildSql = deriveRebuildSql(baselineSql);
  const rebuildHash = new Bun.CryptoHasher("sha256").update(rebuildSql).digest("hex");
  const markerSql = "CREATE INDEX `idx_synthetic_marker` ON `lore_entries` (`sort_order`);";

  const root = await mkdtemp(join(tmpdir(), "vt-nullfix-"));
  const folderBase = join(root, "base", "drizzle");
  const folderFull = join(root, "full", "drizzle");
  await mkdir(join(folderBase, "meta"), { recursive: true });
  await mkdir(join(folderFull, "meta"), { recursive: true });

  await copyFile(baselineSrc, join(folderBase, "0000_baseline.sql"));
  await Bun.write(join(folderBase, "meta", "_journal.json"), JSON.stringify({
    version: "7",
    dialect: "sqlite",
    entries: [{ idx: 0, version: "6", when: W0, tag: "0000_baseline", breakpoints: true }],
  }));

  await copyFile(baselineSrc, join(folderFull, "0000_baseline.sql"));
  await Bun.write(join(folderFull, `${REBUILD_TAG}.sql`), rebuildSql);
  await Bun.write(join(folderFull, `${MARKER_TAG}.sql`), markerSql);
  await Bun.write(join(folderFull, "meta", "_journal.json"), JSON.stringify({
    version: "7",
    dialect: "sqlite",
    entries: [
      { idx: 0, version: "6", when: W0, tag: "0000_baseline", breakpoints: true },
      { idx: 1, version: "6", when: W1, tag: REBUILD_TAG, breakpoints: true },
      { idx: 2, version: "6", when: W2, tag: MARKER_TAG, breakpoints: true },
    ],
  }));

  return { folderBase, folderFull, rebuildSql, rebuildHash, markerSql };
}

function openRaw(dbPath: string): Database {
  return new Database(dbPath);
}

function contentHashInfo(dbPath: string): { notnull: number; nullCount: number; total: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const col = (db.query("PRAGMA table_info(lore_entries)").all() as { name: string; notnull: number }[])
      .find((c) => c.name === "content_hash");
    const nullCount = (db.query("SELECT COUNT(*) as n FROM lore_entries WHERE content_hash IS NULL").get() as { n: number }).n;
    const total = (db.query("SELECT COUNT(*) as n FROM lore_entries").get() as { n: number }).n;
    return { notnull: col ? Number(col.notnull) : -1, nullCount, total };
  } finally {
    db.close();
  }
}

function stampCount(dbPath: string, hash: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) as n FROM __drizzle_migrations WHERE hash = ?").get(hash) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Build a pre-rebuild DB (baseline schema only) holding one lorebook entry
 *  whose content_hash is NULL — the legacy-NULL state that kills the rebuild. */
/** Insert one lorebook + one entry with RAW SQL (the LorebookStore writes
 *  post-baseline columns that folderBase's baseline-only lorebooks lacks —
 *  raw keeps the fixture pinned to exactly the legacy shape under test). */
async function buildLegacyNullDb(dbPath: string, folders: SyntheticFolders): Promise<void> {
  const db = await createDb(dbPath, folders.folderBase);
  (db as unknown as { $client: Database }).$client.close();
  const raw = openRaw(dbPath);
  raw.run(
    "INSERT INTO lorebooks (id, name, scope_type, created_at, updated_at) VALUES ('lb1', 'Null-fix lorebook', 'global', '2026-09-04', '2026-09-04')",
  );
  raw.run(
    "INSERT INTO lore_entries (id, lorebook_id, title, created_at, updated_at) VALUES ('le1', 'lb1', 'legacy', '2026-09-04', '2026-09-04')",
  );
  raw.run("UPDATE lore_entries SET content_hash = NULL");
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  raw.close();
  expect(contentHashInfo(dbPath).nullCount).toBe(1);
  expect(contentHashInfo(dbPath).total).toBe(1);
}

describe("createDb rebuild NULL pre-repair + gap-repair (0059 class)", () => {
  test("pending rebuild applies in-order over legacy NULLs (no crash, no heal)", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-nullfix-pending-"));
    const dbPath = join(work, "test.db");
    const folders = await buildSyntheticFolders();
    await buildLegacyNullDb(dbPath, folders);

    // Without the pre-backfill this createDb throws NOT NULL constraint failed.
    const db = await createDb(dbPath, folders.folderFull);

    // The rebuild applied: column tightened, legacy NULL backfilled to ''.
    const info = contentHashInfo(dbPath);
    expect(info.notnull).toBe(1);
    expect(info.nullCount).toBe(0);
    expect(info.total).toBe(1);
    // And it was migrate() that applied it — stamped once, in-order.
    expect(stampCount(dbPath, folders.rebuildHash)).toBe(1);
    (db as unknown as { $client: Database }).$client.close();
  });

  test("gap-repair re-applies a rebuild the watermark skipped (owner's 0059 state)", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-nullfix-gap-"));
    const dbPath = join(work, "test.db");
    const folders = await buildSyntheticFolders();
    await buildLegacyNullDb(dbPath, folders);

    // Simulate the incident's aftermath: the LATER migration got stamped by
    // the heal (watermark = W2 > W1) while the rebuild stayed un-stamped.
    const markerHash = new Bun.CryptoHasher("sha256").update(folders.markerSql).digest("hex");
    const raw = openRaw(dbPath);
    raw.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [markerHash, W2]);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();

    // migrate() alone would skip the rebuild forever (watermark past it) —
    // the gap-repair must close it. No throw, data preserved.
    const db = await createDb(dbPath, folders.folderFull);

    const info = contentHashInfo(dbPath);
    expect(info.notnull).toBe(1);
    expect(info.nullCount).toBe(0);
    expect(info.total).toBe(1); // the entry survived the repair
    expect(stampCount(dbPath, folders.rebuildHash)).toBe(1); // repaired + stamped

    (db as unknown as { $client: Database }).$client.close();
    const probe = new Database(dbPath, { readonly: true });
    const titles = probe.query("SELECT title FROM lore_entries").all() as { title: string }[];
    probe.close();
    expect(titles.map((t) => t.title)).toEqual(["legacy"]);
  });

  test("healthy DBs are untouched — no re-apply over a stamped rebuild", async () => {
    const work = await mkdtemp(join(tmpdir(), "vt-nullfix-healthy-"));
    const dbPath = join(work, "test.db");
    const folders = await buildSyntheticFolders();

    // Fresh DB on the full folder: baseline + rebuild + marker all applied.
    const db = await createDb(dbPath, folders.folderFull);
    (db as unknown as { $client: Database }).$client.close();
    const raw = openRaw(dbPath);
    raw.run(
      "INSERT INTO lorebooks (id, name, scope_type, created_at, updated_at) VALUES ('lb2', 'Healthy lorebook', 'global', '2026-09-04', '2026-09-04')",
    );
    raw.run(
      "INSERT INTO lore_entries (id, lorebook_id, title, created_at, updated_at) VALUES ('le2', 'lb2', 'healthy', '2026-09-04', '2026-09-04')",
    );
    raw.run("UPDATE lore_entries SET content_hash = 'keepme'");
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    expect(stampCount(dbPath, folders.rebuildHash)).toBe(1);

    // Next boot: the rebuild is stamped and the table is in target shape —
    // the gap-repair must no-op. A wrongful re-apply would hit "index already
    // exists" inside its transaction and throw, so no-throw is the guard.
    const again = await createDb(dbPath, folders.folderFull);
    (again as unknown as { $client: Database }).$client.close();

    const probe = new Database(dbPath, { readonly: true });
    const kept = probe.query("SELECT content_hash FROM lore_entries WHERE title = 'healthy'").get() as { content_hash: string };
    probe.close();
    expect(kept.content_hash).toBe("keepme");
    expect(stampCount(dbPath, folders.rebuildHash)).toBe(1);
  });
});
