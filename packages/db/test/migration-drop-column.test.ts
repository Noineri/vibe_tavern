import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb } from "../src/db-connection.js";

/**
 * Characterization for the DROP-column awareness of createDb's additive repair
 * steps (`repairMissingTables` + `ensureAlterColumns`).
 *
 * Both steps historically parsed only `CREATE TABLE` and `ALTER TABLE … ADD
 * COLUMN` and re-applied a migration whose added column was absent — they had
 * NO concept of `ALTER TABLE … DROP COLUMN`. The first drop migration in the
 * project (HRF-6's 0017, dropping the transitional `characters.folder_name`
 * that 0016 added) exposed this: `migrate()` applied 0017 (DROP), then
 * `repairMissingTables` saw 0016's `ADD COLUMN folder_name` as "missing" and
 * re-added it, so the drop was silently undone on every startup. Same for
 * `ensureAlterColumns`, which checks EVERY migration's ADD columns regardless
 * of stamp status.
 *
 * The fix: pre-compute the set of columns dropped by ANY migration and exclude
 * them from the "must exist" checks. These tests pin that an ADD-then-DROP
 * column ends up ABSENT after createDb (the drop is respected, not repaired).
 *
 * Synthetic migrations mirror the real 0016/0017 shape exactly: a column added
 * via `ALTER TABLE … ADD COLUMN` in 0001, then dropped in 0002.
 */

const INIT_SQL = `CREATE TABLE "widgets" ("id" integer PRIMARY KEY, "name" text NOT NULL DEFAULT '');`;

const ADD_COLUMN_SQL = `ALTER TABLE "widgets" ADD COLUMN "transitional" text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE TABLE "repair_probe" ("id" integer PRIMARY KEY);`;

const DROP_COLUMN_SQL = `ALTER TABLE "widgets" DROP COLUMN "transitional";`;

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
	await writeFile(
		resolve(meta, "_journal.json"),
		JSON.stringify({ version: "7", dialect: "sqlite", entries }),
	);
}

async function writeFolder(folder: string, withDrop: boolean): Promise<void> {
	await rm(folder, { recursive: true, force: true });
	await mkdir(folder, { recursive: true });
	const entries: JournalEntry[] = [
		{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
		{ idx: 1, version: "6", when: 1700000001000, tag: "0001_add_column", breakpoints: true },
	];
	await writeFile(resolve(folder, "0000_init.sql"), INIT_SQL);
	await writeFile(resolve(folder, "0001_add_column.sql"), ADD_COLUMN_SQL);
	if (withDrop) {
		entries.push({ idx: 2, version: "6", when: 1700000002000, tag: "0002_drop_column", breakpoints: true });
		await writeFile(resolve(folder, "0002_drop_column.sql"), DROP_COLUMN_SQL);
	}
	await writeJournal(folder, entries);
}

function hasColumn(dbPath: string, column: string): boolean {
	const conn = new Database(dbPath);
	const cols = conn.prepare(`PRAGMA table_info("widgets")`).all() as { name: string }[];
	conn.close();
	return cols.some((c) => c.name === column);
}

describe("createDb DROP-column awareness — repair must not re-add a dropped column", () => {
	test("WITHOUT a drop migration: the ADDed column survives createDb (sanity)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-drop-aware-addonly-"));
		const folder = join(dir, "drizzle");
		const dbPath = join(dir, "test.db");

		await writeFolder(folder, false);
		const db = await createDb(dbPath, folder);
		(db as unknown as { $client: Database }).$client.close();

		expect(hasColumn(dbPath, "transitional")).toBe(true);
	});

	test("WITH a drop migration: createDb leaves the column ABSENT (repair does not re-add it)", async () => {
		// Realistic upgrade: user's DB already has the ADD migration applied
		// (column present), a new binary ships the DROP migration.
		const dir = await mkdtemp(join(tmpdir(), "vt-drop-aware-upgrade-"));
		const folder = join(dir, "drizzle");
		const dbPath = join(dir, "test.db");

		// Phase A: only init + add-column. Apply via raw migrate, column present.
		await writeFolder(folder, false);
		const setupClient = new Database(dbPath);
		setupClient.exec("PRAGMA journal_mode = WAL");
		setupClient.exec("PRAGMA foreign_keys = ON");
		const setupDb = drizzle(setupClient);
		migrate(setupDb, { migrationsFolder: folder });
		setupClient.close();
		expect(hasColumn(dbPath, "transitional")).toBe(true);

		// Phase B: ship the drop migration. Run via createDb — migrate() drops the
		// column, then repairMissingTables + ensureAlterColumns must NOT re-add it.
		await writeFolder(folder, true);
		const db = await createDb(dbPath, folder);
		(db as unknown as { $client: Database }).$client.close();

		// THE FIX: the dropped column stays dropped.
		expect(hasColumn(dbPath, "transitional")).toBe(false);
	});

	test("repairing another object does not resurrect a column that a later migration dropped", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-drop-aware-mixed-repair-"));
		const folder = join(dir, "drizzle");
		const dbPath = join(dir, "test.db");

		// Apply the full chain first: repair_probe exists, transitional is dropped.
		await writeFolder(folder, true);
		const setupClient = new Database(dbPath);
		setupClient.exec("PRAGMA journal_mode = WAL");
		const setupDb = drizzle(setupClient);
		migrate(setupDb, { migrationsFolder: folder });
		setupClient.close();
		expect(hasColumn(dbPath, "transitional")).toBe(false);

		// Simulate partial/corrupt schema: another object from the ADD migration is
		// missing, forcing repairMissingTables to replay that migration statement-
		// by-statement. It must restore the table but skip the obsolete ADD COLUMN.
		const corrupt = new Database(dbPath);
		corrupt.exec(`DROP TABLE "repair_probe"`);
		corrupt.close();

		const db = await createDb(dbPath, folder);
		(db as unknown as { $client: Database }).$client.close();

		const check = new Database(dbPath);
		const repairedTable = check.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repair_probe'`,
		).all();
		check.close();
		expect(repairedTable).toHaveLength(1);
		expect(hasColumn(dbPath, "transitional")).toBe(false);
	});

	test("the real project migration chain leaves characters.folder_name and its index absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-drop-aware-project-"));
		const dbPath = join(dir, "test.db");
		const db = await createDb(dbPath);
		(db as unknown as { $client: Database }).$client.close();

		const conn = new Database(dbPath);
		const columns = conn.prepare(`PRAGMA table_info("characters")`).all() as { name: string }[];
		const index = conn.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_characters_folder_name'`,
		).all();
		conn.close();

		expect(columns.some((c) => c.name === "folder_name")).toBe(false);
		expect(index).toEqual([]);
	});
});
