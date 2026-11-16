import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db-connection.js";

// Incident 2026-08-21: a long-lived prod server died wholesale on
// `SQLITE_BUSY: database is locked` — bun:sqlite's default busy_timeout is 0
// (verified: `PRAGMA busy_timeout` → { timeout: 0 }), so ANY transient write
// contention (dev server + prod server + ad-hoc probes share the WAL db)
// threw instantly instead of waiting, and an unguarded background insert
// turned it into an unhandled rejection that killed the process. These tests
// pin (a) that createDb sets a real busy_timeout on its connection, and
// (b) that busy_timeout actually converts instant-SQLITE_BUSY into waiting.

const BUSY_TIMEOUT_MS = 5_000;

async function waitForChildLine(stdout: ReadableStream<Uint8Array>, expected: string): Promise<void> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (!buffer.includes(expected)) {
		const { done, value } = await reader.read();
		if (done) {
			throw new Error(`Child process exited before emitting ${JSON.stringify(expected)}; got: ${buffer}`);
		}
		buffer += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
}

describe("createDb: busy_timeout", () => {
	test("createDb connections wait instead of throwing instantly on write contention", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-create-db-busy-"));
		const dbPath = join(dir, "app.db");
		const db = await createDb(dbPath);
		const raw = db.$client;
		let impatient: Database | null = null;
		let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
		try {
			const pragma = raw.prepare("PRAGMA busy_timeout").get() as { timeout: number };
			expect(pragma.timeout).toBe(BUSY_TIMEOUT_MS);

			raw.exec("CREATE TABLE _busy_probe (id INTEGER PRIMARY KEY, writer TEXT NOT NULL)");

			const childScript = `
				import { Database } from "bun:sqlite";
				const holder = new Database(process.env.LOCK_DB_PATH!);
				holder.exec("BEGIN IMMEDIATE");
				holder.prepare("INSERT INTO _busy_probe (writer) VALUES ('holder')").run();
				process.stdout.write("LOCKED\\n");
				await Bun.sleep(150);
				holder.exec("COMMIT");
				holder.close();
			`;
			child = Bun.spawn([process.execPath, "-e", childScript], {
				env: { ...process.env, LOCK_DB_PATH: dbPath },
				stdout: "pipe",
				stderr: "pipe",
			});
			await waitForChildLine(child.stdout, "LOCKED");

			// Impatient default handle (busy_timeout = 0) fails immediately on the active lock.
			impatient = new Database(dbPath);
			expect(() => impatient!.prepare("INSERT INTO _busy_probe (writer) VALUES ('impatient')").run()).toThrow();

			// The file-backed createDb handle waits for the lock to release and succeeds.
			raw.prepare("INSERT INTO _busy_probe (writer) VALUES (?)").run("createDb");
			expect(await child.exited).toBe(0);

			const rows = raw.query("SELECT writer FROM _busy_probe ORDER BY id ASC").all() as { writer: string }[];
			expect(rows.map((r) => r.writer)).toEqual(["holder", "createDb"]);
		} finally {
			impatient?.close();
			if (child && child.exitCode === null) child.kill();
			raw.close();
		}
	});

	test("mechanism: busy_timeout makes a second writer WAIT (pin of why the pragma matters)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-busy-timeout-"));
		const path = join(dir, "busy.db");

		const writer = new Database(path);
		writer.exec("PRAGMA journal_mode = WAL");
		writer.exec("CREATE TABLE t (x)");
		writer.exec("BEGIN IMMEDIATE");
		writer.exec("INSERT INTO t VALUES (1)");

		// Without a timeout the contended write fails INSTANTLY…
		const impatient = new Database(path); // default busy_timeout = 0
		const instantStart = performance.now();
		expect(() => impatient.prepare("INSERT INTO t VALUES (2)").run()).toThrow();
		const instantElapsed = performance.now() - instantStart;

		// …with a timeout the same write only fails after WAITING for the lock
		// (the holder runs on this thread, so it cannot be released here — the
		// elapsed time is the observable: waiting happened instead of an
		// instant throw). In production the holder is another process and the
		// write succeeds once it commits.
		const patient = new Database(path);
		patient.exec(`PRAGMA busy_timeout = 250`);
		const patientStart = performance.now();
		expect(() => patient.prepare("INSERT INTO t VALUES (3)").run()).toThrow();
		const patientElapsed = performance.now() - patientStart;

		// The load-invariant observable is the CONTRAST, not absolute windows:
		// the instant path does real syscalls, so under a full parallel suite run
		// it can take hundreds of ms (observed 218ms on Windows, 2026-10-12),
		// while the busy handler always waits out its full 250ms budget before
		// giving up. Patient minus impatient stays ≈250ms at any load.
		expect(patientElapsed - instantElapsed).toBeGreaterThanOrEqual(150);
		expect(patientElapsed).toBeGreaterThanOrEqual(200);

		writer.exec("COMMIT");
		writer.close();
		impatient.close();
		patient.close();
	});
});
