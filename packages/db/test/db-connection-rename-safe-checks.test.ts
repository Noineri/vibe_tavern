import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb } from "../src/db-connection.js";
import {
	normalizeDunderCheckReferences,
	stageRenameSafeMigrationsFolder,
} from "../src/db-migration-repair.js";

/**
 * Rename-safe CHECK normalization (macOS smoke, CI 2026-11-01).
 *
 * drizzle-kit emits table-rebuild CHECK constraints referencing the temporary
 * table name: CHECK(("__new_provider_profiles"."proxy_mode" = …)). SQLite
 * ≥ 3.46 rewrites those on RENAME; bun's macOS/arm64 build links a pre-3.46
 * SQLite whose RENAME leaves them dangling and fails the schema re-parse
 * ("error in table provider_profiles after rename: no such column:
 * __new_provider_profiles.proxy_mode"). Unqualified references are valid under
 * either name on every SQLite ≥ 3.25, so migrate() runs from a staged copy
 * with the qualification stripped — committed migration files untouched.
 */

const INIT_SQL = `CREATE TABLE "provider_profiles" ("id" text PRIMARY KEY NOT NULL, "proxy_mode" text DEFAULT 'inherit' NOT NULL, "proxy_id" text);`;

// The exact drizzle-kit dunder-CHECK shape, mirroring 0030's
// provider_profiles_proxy_policy_check and 0131's agent_review_rounds_one_owner.
const REBUILD_SQL = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE "__new_provider_profiles" ("id" text PRIMARY KEY NOT NULL, "proxy_mode" text DEFAULT 'inherit' NOT NULL, "proxy_id" text,
CONSTRAINT "provider_profiles_proxy_policy_check" CHECK(("__new_provider_profiles"."proxy_mode" = 'proxy' AND "__new_provider_profiles"."proxy_id" IS NOT NULL) OR ("__new_provider_profiles"."proxy_mode" IN ('inherit', 'direct') AND "__new_provider_profiles"."proxy_id" IS NULL)));--> statement-breakpoint
INSERT INTO "__new_provider_profiles"("id","proxy_mode","proxy_id") SELECT "id","proxy_mode","proxy_id" FROM "provider_profiles";--> statement-breakpoint
DROP TABLE "provider_profiles";--> statement-breakpoint
ALTER TABLE "__new_provider_profiles" RENAME TO "provider_profiles";`;

interface JournalEntry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

async function writeFolder(folder: string): Promise<void> {
	await rm(folder, { recursive: true, force: true });
	await mkdir(resolve(folder, "meta"), { recursive: true });
	await Bun.write(resolve(folder, "0000_init.sql"), INIT_SQL);
	await Bun.write(resolve(folder, "0001_rebuild.sql"), REBUILD_SQL);
	await Bun.write(
		resolve(folder, "meta", "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "sqlite",
			entries: [
				{ idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
				{ idx: 1, version: "6", when: 1700000001000, tag: "0001_rebuild", breakpoints: true },
			],
		}),
	);
}

describe("normalizeDunderCheckReferences", () => {
	test("strips the __new_ table qualification from CHECK references", () => {
		expect(normalizeDunderCheckReferences(REBUILD_SQL)).not.toContain(`"__new_provider_profiles".`);
		expect(normalizeDunderCheckReferences(REBUILD_SQL)).toContain(`CHECK(("proxy_mode" = 'proxy'`);
	});

	test("leaves table names, foreign keys and non-dunder quotes untouched", () => {
		const input = `CREATE TABLE "__new_x" ("id" text);--> statement-breakpoint
ALTER TABLE "__new_x" RENAME TO "x";--> statement-breakpoint
CREATE TABLE "child" ("id" text REFERENCES "x"("id"));`;
		expect(normalizeDunderCheckReferences(input)).toBe(input);
	});

	test("is idempotent", () => {
		const once = normalizeDunderCheckReferences(REBUILD_SQL);
		expect(normalizeDunderCheckReferences(once)).toBe(once);
	});
});

describe("stageRenameSafeMigrationsFolder", () => {
	test("staged .sql files are normalized; meta is verbatim; temp tree is self-contained", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-stage-"));
		const folder = join(dir, "drizzle");
		await writeFolder(folder);
		const staged = await stageRenameSafeMigrationsFolder(folder);
		try {
			const stagedSql = await Bun.file(resolve(staged, "0001_rebuild.sql")).text();
			expect(stagedSql).not.toContain(`"__new_provider_profiles".`);
			// The official folder is untouched (committed migrations are immutable).
			expect(await Bun.file(resolve(folder, "0001_rebuild.sql")).text()).toContain(`"__new_provider_profiles".`);
			const journal = await Bun.file(resolve(staged, "meta", "_journal.json")).text();
			expect(journal).toContain('"tag":"0001_rebuild"');
		} finally {
			await rm(staged, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("fresh boot through the staged folder", () => {
	test("a dunder-CHECK rebuild migrates cleanly and leaves no __new_ references in the schema", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-stage-boot-"));
		const folder = join(dir, "drizzle");
		await writeFolder(folder);
		const dbPath = join(dir, "test.db");

		const db = await createDb(dbPath, folder);
		const schemaSql = (db.$client.query(
			"SELECT sql FROM sqlite_master WHERE name = 'provider_profiles'",
		).get() as { sql: string }).sql;
		expect(schemaSql).not.toContain("__new_");
		expect(schemaSql).toContain(`("proxy_mode" = 'proxy'`);
		// The CHECK is live and evaluates against the table's own columns.
		db.$client.exec(`INSERT INTO provider_profiles (id, proxy_mode, proxy_id) VALUES ('a', 'proxy', 'p1')`);
		expect(() =>
			db.$client.exec(`INSERT INTO provider_profiles (id, proxy_mode, proxy_id) VALUES ('b', 'proxy', NULL)`)
		).toThrow();
	});

	test("hasPendingMigrations gates staging: a fully-migrated boot runs from the official folder", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-stage-idle-"));
		const folder = join(dir, "drizzle");
		await writeFolder(folder);
		const dbPath = join(dir, "test.db");
		// Bring the db fully up to date OUTSIDE createDb (raw drizzle), so the
		// subsequent createDb boot has nothing pending.
		const client = new Database(dbPath);
		client.exec("PRAGMA journal_mode = WAL");
		migrate(drizzle(client), { migrationsFolder: folder });
		client.close();

		const db = await createDb(dbPath, folder);
		const watermark = db.$client.query(
			"SELECT MAX(created_at) AS m FROM __drizzle_migrations",
		).get() as { m: number };
		expect(watermark.m).toBe(1700000001000);
	});
});
