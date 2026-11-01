import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb } from "../src/db-connection.js";

/**
 * Characterization for the heal-order rule in healPartialMigrations.
 *
 * The bug (CI 2026-11-01, macOS npm smoke): the first migrate() pass failed
 * inside a table-rebuild migration (0030). The heal then stamped every LATER
 * non-rebuild migration (0031..0135) around the skipped rebuild — advancing
 * drizzle's watermark past it — so the retry migrate() ran NOTHING: the
 * rebuilds 0030/0131 were silently skipped forever, agent_review_rounds kept
 * its pre-0131 shape, and startup died on the unique-column guard with a
 * message pointing far away from the real defect.
 *
 * The rule: an unstamped table-rebuild STOPS the heal. Later entries are left
 * for the retry migrate(), which either applies them in order or fails loudly
 * — never a silently wrong schema. The partial-state scenario the heal was
 * built for (a non-rebuild whose effects already exist) is untouched: no
 * rebuild below it means the heal still runs to the end.
 *
 * Synthetic migrations mirror drizzle-kit's emitted rebuild pattern (see
 * db-connection-fk-rebuild.test.ts for the template's provenance).
 */

const INIT_SQL = `CREATE TABLE "parent" ("id" integer PRIMARY KEY, "mode" text NOT NULL DEFAULT 'a');`;

// drizzle-kit's rebuild shape + a trailing statement that ALWAYS fails, so
// both the first migrate() pass AND the retry throw inside this migration
// (any real-world cause — transient SQLITE error, platform quirk — lands
// here), and its transaction rolls back, exactly like the 0030 failure did.
const REBUILD_WITH_POISON_SQL = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE "__new_parent" ("id" integer PRIMARY KEY, "mode" text NOT NULL DEFAULT 'b');--> statement-breakpoint
INSERT INTO "__new_parent"("id","mode") SELECT "id","mode" FROM "parent";--> statement-breakpoint
DROP TABLE "parent";--> statement-breakpoint
ALTER TABLE "__new_parent" RENAME TO "parent";--> statement-breakpoint
INSERT INTO "no_such_table" ("id") VALUES (1);`;

const TAIL_SQL = `CREATE TABLE "tail" ("id" integer PRIMARY KEY);`;

interface JournalEntry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

async function writeJournal(folder: string, entries: JournalEntry[]): Promise<void> {
	const meta = resolve(folder, "meta");
	await mkdir(meta, { recursive: true });
	await Bun.write(resolve(meta, "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
}

async function writeMigrationsFolder(folder: string): Promise<void> {
	await rm(folder, { recursive: true, force: true });
	await mkdir(folder, { recursive: true });
	await Bun.write(resolve(folder, "0000_init.sql"), INIT_SQL);
	await Bun.write(resolve(folder, "0001_rebuild_poison.sql"), REBUILD_WITH_POISON_SQL);
	await Bun.write(resolve(folder, "0002_tail.sql"), TAIL_SQL);
	await writeJournal(folder, [
		{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
		{ idx: 1, version: "6", when: 1700000001000, tag: "0001_rebuild_poison", breakpoints: true },
		{ idx: 2, version: "6", when: 1700000002000, tag: "0002_tail", breakpoints: true },
	]);
}

/** The upgrade-path seed: the db exists with 0000 applied and stamped, and the
 * newer binary brings the poisoned rebuild + a tail migration. */
async function seedAtInit(dbPath: string, folder: string): Promise<void> {
	const single = join(resolve(folder, ".."), "drizzle-init-only");
	await rm(single, { recursive: true, force: true });
	await mkdir(single, { recursive: true });
	await Bun.write(resolve(single, "0000_init.sql"), INIT_SQL);
	await writeJournal(single, [{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true }]);
	const client = new Database(dbPath);
	client.exec("PRAGMA journal_mode = WAL");
	migrate(drizzle(client), { migrationsFolder: single });
	client.close();
	await rm(single, { recursive: true, force: true });
}

describe("heal-order — an unstamped rebuild stops the heal", () => {
	test("a rebuild migration that keeps failing is re-run (or fails loudly), never silently watermarked past", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-heal-order-"));
		const folder = join(dir, "drizzle");
		const dbPath = join(dir, "test.db");
		await writeMigrationsFolder(folder);
		await seedAtInit(dbPath, folder);

		// Before the fix: the heal stamped 0002 around the skipped 0001,
		// the retry migrate() ran nothing, and createDb RESOLVED with
		// `parent` still in its pre-rebuild shape — a silent wrong schema.
		// After: the retry re-runs 0001, hits the poison again, and
		// createDb rejects with the real failure.
		await expect(createDb(dbPath, folder)).rejects.toThrow(/no such table|Failed to run the query/);
	});

	test("the partial-state heal (non-rebuild whose effects already exist) still completes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-heal-partial-"));
		const folder = join(dir, "drizzle");
		const dbPath = join(dir, "test.db");
		await rm(folder, { recursive: true, force: true });
		await mkdir(folder, { recursive: true });
		// 0000 creates parent; 0001 is a plain ALTER that a prior pre-flight
		// already applied without stamping (the heal's designed scenario).
		await Bun.write(resolve(folder, "0000_init.sql"), INIT_SQL);
		await writeJournal(folder, [
			{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
		]);
		const client = new Database(dbPath);
		client.exec("PRAGMA journal_mode = WAL");
		migrate(drizzle(client), { migrationsFolder: folder });
		client.close();
		// The newer binary's 0001 arrives unstamped...
		await Bun.write(resolve(folder, "0001_alter.sql"), `ALTER TABLE "parent" ADD COLUMN "extra" text;--> statement-breakpoint`);
		await writeJournal(folder, [
			{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
			{ idx: 1, version: "6", when: 1700000001000, tag: "0001_alter", breakpoints: true },
		]);
		// ...and a prior pre-flight already added its column without stamping.
		const preflight = new Database(dbPath);
		preflight.exec(`ALTER TABLE "parent" ADD COLUMN "extra" text;`);
		preflight.close();

		const db = await createDb(dbPath, folder);
		const cols = db.$client.query("PRAGMA table_info(parent)").all() as { name: string }[];
		expect(cols.map((c) => c.name)).toContain("extra");
	});
});
