// Test support: a copy of the committed drizzle folder whose journal STOPS at
// a given migration tag — build a database at that historical schema, seed
// legacy rows with raw SQL, then let `createDb(dbPath)` apply the rest of the
// real journal (the exact upgrade path a user's DB takes).
//
// The older migration tests (lore-scope-collapse, lore-script-owner-links,
// script-origin) each carry an inline copy of this builder; new migration
// tests use this module instead.
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REAL_DRIZZLE_DIR = resolve(import.meta.dir, "..", "drizzle");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** Drizzle folder copy whose journal ends at `lastTag` (inclusive). */
export async function buildJournalCutFolder(lastTag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vt-journal-cut-"));
  const folder = join(dir, "drizzle");
  await mkdir(folder);
  const journal = JSON.parse(await readFile(resolve(REAL_DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`journal does not contain ${lastTag} — update the test's cut tag for the new baseline`);
  const kept = journal.entries.slice(0, cut + 1);
  for (const entry of kept) {
    const sql = await readFile(resolve(REAL_DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    await Bun.write(resolve(folder, `${entry.tag}.sql`), sql);
  }
  await mkdir(resolve(folder, "meta"), { recursive: true });
  await Bun.write(resolve(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}
