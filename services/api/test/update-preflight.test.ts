/**
 * Free-space preflight and the pre-update database snapshot.
 *
 * Between them these are the update's two recovery guarantees: refuse before
 * spending anything when the disk cannot hold the result, and never modify the
 * install without a readable copy of the database from before it.
 */

import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { checkFreeSpace, estimateRequiredBytes } from "../src/server/update-preflight.js";
import {
	SNAPSHOT_ATTEMPTS,
	type SnapshotResult,
	snapshotDatabase,
	snapshotPathFor,
} from "../src/domain/update/update-db-snapshot.js";

let root = "";

/**
 * Every Database this file opens, so cleanup can close them.
 *
 * `makeWalDb` deliberately leaves its connection open for the duration of a
 * test — the whole point is to snapshot a live, uncheckpointed WAL database,
 * exactly as a running server would have it. Leaving it open past the test is
 * not part of that intent, and on Windows an open SQLite handle locks the file:
 * `rm(root)` then fails with EBUSY, the temp dir survives, and later tests
 * inherit the mess until `VACUUM INTO` cannot even open its destination. On
 * Linux the unlink succeeds regardless, which is why the leak stayed invisible.
 */
const openDatabases: Database[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vt-preflight-"));
});

afterEach(async () => {
	for (const db of openDatabases.splice(0)) db.close();
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
	/**
	 * Assert a snapshot succeeded, in a way that says why when it did not.
	 *
	 * `snapshotDatabase` never throws: a failure is `ok: false` plus a message,
	 * and the message is the only place the reason exists. Asserting on `ok`
	 * alone reduces every failure to "Expected: true, Received: false" — which
	 * is exactly what a Windows-only CI flake here produced, throwing away the
	 * one sentence that identified it. Assert the message first so a red run
	 * carries the diagnosis.
	 */
	function expectSnapshotOk(result: SnapshotResult): void {
		expect(result.message).toBeNull();
		expect(result.ok).toBe(true);
	}

	async function makeWalDb(rows: number): Promise<{ dbPath: string; dataDir: string; db: Database }> {
		const dataDir = join(root, "data");
		await mkdir(dataDir, { recursive: true });
		const dbPath = join(dataDir, "vibe-tavern.db");
		const db = new Database(dbPath, { create: true });
		openDatabases.push(db);
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("CREATE TABLE chats (id TEXT PRIMARY KEY, body TEXT);");
		for (let i = 0; i < rows; i++) db.run("INSERT INTO chats VALUES (?, ?)", [`c${i}`, `body ${i}`]);
		// Deliberately left open and un-checkpointed for the duration of the
		// test, exactly as a running server would have it when an update starts.
		// afterEach closes it; see openDatabases.
		return { dbPath, dataDir, db };
	}

	it("produces a snapshot that opens and holds the same rows, WAL included", async () => {
		const { dbPath, dataDir } = await makeWalDb(500);

		const result = await snapshotDatabase(dbPath, dataDir, "1.2.3");

		expectSnapshotOk(result);
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

		expectSnapshotOk(result);
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
		expectSnapshotOk(first);
		expectSnapshotOk(second);
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
		// Pinned on the source's schema rather than its mtime: running the
		// migration stack would add drizzle's bookkeeping table and the whole
		// application schema alongside `chats`, which is directly observable.
		// mtime is not — NTFS updates it even for a read-only SQLite open, so
		// that spelling of this pin only ever held on Linux.
		interface SchemaRow {
			readonly type: string;
			readonly name: string;
			readonly sql: string | null;
		}

		const { dbPath, dataDir, db } = await makeWalDb(5);
		// Read through the connection the fixture already holds: opening more
		// handles to a WAL database is exactly the contention that makes this
		// file unreliable on Windows.
		const schemaOf = (): SchemaRow[] =>
			db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() as SchemaRow[];

		const before = schemaOf();
		await snapshotDatabase(dbPath, dataDir, "3.0.0");

		expect(schemaOf()).toEqual(before);
		// Guard the guard: the comparison above is only meaningful if the
		// baseline actually described the fixture's schema.
		expect(before.map((r) => r.name)).toContain("chats");
		expect(schemaOf().map((r) => r.name)).not.toContain("__drizzle_migrations");
	});

	// ── Transient SQLITE_CANTOPEN is retried ───────────────────────────────
	//
	// Windows hands out "unable to open database file" when an antivirus or the
	// search indexer momentarily holds a handle on a file that was created
	// seconds ago — which is precisely the shape of every snapshot the updater
	// takes. The retry is driven through the `openSource` seam rather than by
	// sabotaging the filesystem: mode bits are inert on Windows, so a real
	// injection there would fail open and the pin would prove nothing.

	/** An opener that fails the first `failures` calls, then behaves normally. */
	function flakyOpener(failures: number, failure: Error, onFail?: (destination: string) => void) {
		const state = { calls: 0 };
		const open = (path: string): Database => {
			state.calls++;
			if (state.calls <= failures) {
				onFail?.(path);
				throw failure;
			}
			return new Database(path, { readonly: true });
		};
		return { state, open };
	}

	/**
	 * The SQLITE_CANTOPEN object bun:sqlite actually throws.
	 *
	 * It cannot be fabricated — `new SQLiteError(...)` throws "SQLiteError can
	 * only be constructed by bun:sqlite" — so it has to be provoked, and opening
	 * a database under a directory that does not exist provokes it on every
	 * platform. Retrying is keyed on `code`, and only a real error object has one.
	 */
	function realCantOpenError(): SQLiteError {
		try {
			new Database(join(root, "no-such-directory", "x.db"), { readonly: true });
		} catch (err) {
			if (err instanceof SQLiteError) return err;
			throw err;
		}
		throw new Error("opening a database under a missing directory was expected to fail");
	}

	it("retries a transient 'unable to open database file' instead of giving up", async () => {
		const { dbPath, dataDir } = await makeWalDb(20);
		const opener = flakyOpener(1, new Error("unable to open database file"));

		const result = await snapshotDatabase(dbPath, dataDir, "4.0.0", {
			openSource: opener.open,
			retryDelayMs: 0,
		});

		expectSnapshotOk(result);
		expect(opener.state.calls).toBe(2);
		const snap = new Database(result.path ?? "", { readonly: true });
		openDatabases.push(snap);
		expect((snap.query("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n).toBe(20);
	});

	it("clears a partial destination between attempts — VACUUM INTO refuses to overwrite", async () => {
		const { dbPath, dataDir } = await makeWalDb(3);
		const destination = snapshotPathFor(dataDir, "5.0.0");
		// A half-written snapshot is what a torn VACUUM INTO leaves behind. If the
		// retry did not clear it, the second attempt would fail for a brand-new
		// reason ("output file already exists") and the retry would be useless.
		const opener = flakyOpener(1, new Error("unable to open database file"), () => {
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, "torn write");
		});

		const result = await snapshotDatabase(dbPath, dataDir, "5.0.0", {
			openSource: opener.open,
			retryDelayMs: 0,
		});

		expectSnapshotOk(result);
		expect(result.bytes).toBeGreaterThan("torn write".length);
	});

	it("gives up after the attempt budget and reports the failure", async () => {
		const { dbPath, dataDir } = await makeWalDb(1);
		const opener = flakyOpener(Number.MAX_SAFE_INTEGER, new Error("unable to open database file"));

		const result = await snapshotDatabase(dbPath, dataDir, "6.0.0", {
			openSource: opener.open,
			retryDelayMs: 0,
		});

		expect(result.ok).toBe(false);
		expect(opener.state.calls).toBe(SNAPSHOT_ATTEMPTS);
		expect(result.message ?? "").toMatch(/unable to open database file/);
	});

	it("does not retry a failure that is not a transient open", async () => {
		const { dbPath, dataDir } = await makeWalDb(1);
		const opener = flakyOpener(Number.MAX_SAFE_INTEGER, new Error("disk I/O error"));

		const result = await snapshotDatabase(dbPath, dataDir, "7.0.0", {
			openSource: opener.open,
			retryDelayMs: 0,
		});

		expect(result.ok).toBe(false);
		expect(opener.state.calls).toBe(1);
	});

	it("retries the destination spelling of CANTOPEN — 'unable to open database: <path>'", async () => {
		// The regression this pins. SQLITE_CANTOPEN reaches the retry under two
		// messages: sqlite3_open on the source says "unable to open database
		// file", and the ATTACH that VACUUM INTO runs on its destination says
		// "unable to open database: <path>". Only the first was matched, so the
		// second — the one Windows CI actually produced, naming
		// backups/pre-update-1.2.3.db — was treated as permanent and the whole
		// retry sat idle.
		const { dbPath, dataDir } = await makeWalDb(20);
		const destination = snapshotPathFor(dataDir, "8.0.0");
		const opener = flakyOpener(1, new Error(`unable to open database: ${destination}`));

		const result = await snapshotDatabase(dbPath, dataDir, "8.0.0", {
			openSource: opener.open,
			retryDelayMs: 0,
		});

		expectSnapshotOk(result);
		expect(opener.state.calls).toBe(2);
	});

	it("retries on the error object bun:sqlite really throws, not just its wording", async () => {
		// Production never sees a hand-written Error — it sees a SQLiteError, and
		// its `code` is the same SQLITE_CANTOPEN under either message. Keying on
		// the code is what stops the next reword of SQLite's error strings from
		// silently disabling this retry again.
		const { dbPath, dataDir } = await makeWalDb(5);
		const cantOpen = realCantOpenError();
		expect(cantOpen.code).toBe("SQLITE_CANTOPEN");
		const opener = flakyOpener(1, cantOpen);

		const result = await snapshotDatabase(dbPath, dataDir, "9.0.0", {
			openSource: opener.open,
			retryDelayMs: 0,
		});

		expectSnapshotOk(result);
		expect(opener.state.calls).toBe(2);
	});

	it("waits longer after each failed attempt instead of a flat delay", async () => {
		// Two failures means two waits. Flat would spend 40 + 40; backing off
		// spends 40 + 80. Asserted as a lower bound only: a loaded CI box makes
		// timers overshoot, never undershoot, so this cannot flake the way an
		// upper bound would.
		const { dbPath, dataDir } = await makeWalDb(1);
		const opener = flakyOpener(2, new Error("unable to open database file"));

		const started = performance.now();
		const result = await snapshotDatabase(dbPath, dataDir, "10.0.0", {
			openSource: opener.open,
			retryDelayMs: 40,
		});
		const elapsed = performance.now() - started;

		expectSnapshotOk(result);
		expect(opener.state.calls).toBe(3);
		expect(elapsed).toBeGreaterThanOrEqual(110);
	});
});
