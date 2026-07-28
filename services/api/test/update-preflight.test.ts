/**
 * Free-space preflight and the pre-update database snapshot.
 *
 * Between them these are the update's two recovery guarantees: refuse before
 * spending anything when the disk cannot hold the result, and never modify the
 * install without a readable copy of the database from before it.
 */

import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { checkFreeSpace, estimateRequiredBytes } from "../src/server/update-preflight.js";
import { snapshotDatabase, snapshotPathFor } from "../src/domain/update/update-db-snapshot.js";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vt-preflight-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("estimateRequiredBytes", () => {
	it("budgets the archive plus a 3x extracted copy plus headroom", () => {
		const archive = 65 * 1024 * 1024;
		const required = estimateRequiredBytes(archive);
		expect(required).toBeGreaterThan(archive * 4);
		// Matches the measured ratio: 65 MB tar.gz -> 192 MB extracted.
		expect(required).toBeLessThan(archive * 4 + 512 * 1024 * 1024);
	});

	it("still demands headroom for a zero-size (unknown) archive", () => {
		expect(estimateRequiredBytes(0)).toBeGreaterThan(0);
	});
});

describe("checkFreeSpace", () => {
	it("passes when the volume has room for a realistic archive", async () => {
		const result = await checkFreeSpace(root, 1024);
		expect(result.ok).toBe(true);
		expect(result.message).toBeNull();
		expect(result.availableBytes).not.toBeNull();
	});

	it("fails with a message naming both the required and the available space", async () => {
		// Demand more than any test machine has free.
		const absurd = 1024 ** 5; // 1 PB
		const result = await checkFreeSpace(root, absurd);

		expect(result.ok).toBe(false);
		expect(result.message).not.toBeNull();
		expect(result.message ?? "").toMatch(/Need about/);
		expect(result.message ?? "").toMatch(/is available/);
		expect(result.message ?? "").toContain(root);
		expect(result.requiredBytes).toBeGreaterThan(absurd);
	});

	it("does not block the update when free space cannot be determined", async () => {
		// A path that does not exist makes statfs throw; an unknown answer must
		// never be the reason an otherwise-fine update is refused.
		const result = await checkFreeSpace(join(root, "definitely", "not", "here"), 1024);
		expect(result.ok).toBe(true);
		expect(result.availableBytes).toBeNull();
	});

	it("never throws", async () => {
		await expect(checkFreeSpace("", -1)).resolves.toBeDefined();
	});
});

describe("snapshotDatabase", () => {
	async function makeWalDb(rows: number): Promise<{ dbPath: string; dataDir: string }> {
		const dataDir = join(root, "data");
		await mkdir(dataDir, { recursive: true });
		const dbPath = join(dataDir, "vibe-tavern.db");
		const db = new Database(dbPath, { create: true });
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("CREATE TABLE chats (id TEXT PRIMARY KEY, body TEXT);");
		for (let i = 0; i < rows; i++) db.run("INSERT INTO chats VALUES (?, ?)", [`c${i}`, `body ${i}`]);
		// Deliberately left open and un-checkpointed, exactly as a running
		// server would have it when an update starts.
		return { dbPath, dataDir };
	}

	it("produces a snapshot that opens and holds the same rows, WAL included", async () => {
		const { dbPath, dataDir } = await makeWalDb(500);

		const result = await snapshotDatabase(dbPath, dataDir, "1.2.3");

		expect(result.ok).toBe(true);
		expect(result.path).toBe(snapshotPathFor(dataDir, "1.2.3"));
		expect(result.bytes).toBeGreaterThan(0);

		const snap = new Database(result.path ?? "", { readonly: true });
		try {
			const row = snap.query("SELECT COUNT(*) AS n FROM chats").get() as { n: number } | null;
			expect(row?.n).toBe(500);
		} finally {
			snap.close();
		}
	});

	it("writes into data/backups/ as pre-update-<version>.db", async () => {
		const { dbPath, dataDir } = await makeWalDb(1);
		const result = await snapshotDatabase(dbPath, dataDir, "9.9.9");
		expect(result.path).toBe(join(dataDir, "backups", "pre-update-9.9.9.db"));
		expect((await stat(result.path ?? "")).isFile()).toBe(true);
	});

	it("emits a single file with no WAL sidecar", async () => {
		const { dbPath, dataDir } = await makeWalDb(50);
		const result = await snapshotDatabase(dbPath, dataDir, "1.0.0");
		expect(await stat(`${result.path}-wal`).then(() => true, () => false)).toBe(false);
	});

	it("sanitizes a hostile version string instead of writing outside backups/", async () => {
		const { dbPath, dataDir } = await makeWalDb(1);
		const result = await snapshotDatabase(dbPath, dataDir, "../../escaped");

		expect(result.ok).toBe(true);
		// The real property: the file lands directly in backups/, whatever the
		// separators got mangled into. (Dots survive sanitization — only the
		// path separators are replaced — so a substring check for ".." would
		// fail on the harmless name "..\_..\_escaped".)
		expect(dirname(result.path ?? "")).toBe(join(dataDir, "backups"));
		expect((await stat(result.path ?? "")).isFile()).toBe(true);
	});

	it("keeps an existing snapshot for the same version rather than failing", async () => {
		const { dbPath, dataDir } = await makeWalDb(10);
		const first = await snapshotDatabase(dbPath, dataDir, "2.0.0");
		const second = await snapshotDatabase(dbPath, dataDir, "2.0.0");
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(second.path).toBe(first.path);
	});

	it("reports a failure — without throwing — when there is no database", async () => {
		const dataDir = join(root, "empty");
		await mkdir(dataDir, { recursive: true });
		const result = await snapshotDatabase(join(dataDir, "missing.db"), dataDir, "1.0.0");
		expect(result.ok).toBe(false);
		expect(result.message ?? "").toMatch(/No database found/);
	});

	it("reports a failure — without throwing — when the source is not a database", async () => {
		const dataDir = join(root, "garbage");
		await mkdir(dataDir, { recursive: true });
		const dbPath = join(dataDir, "vibe-tavern.db");
		await writeFile(dbPath, "this is not a sqlite file");
		const result = await snapshotDatabase(dbPath, dataDir, "1.0.0");
		expect(result.ok).toBe(false);
		expect(result.message ?? "").toMatch(/Could not create a pre-update database backup/);
	});

	it("does not run the migration stack — the source is opened read-only", async () => {
		const { dbPath, dataDir } = await makeWalDb(5);
		const before = (await stat(dbPath)).mtimeMs;
		await snapshotDatabase(dbPath, dataDir, "3.0.0");
		const after = (await stat(dbPath)).mtimeMs;
		expect(after).toBe(before);
	});
});
