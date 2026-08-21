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

describe("createDb: busy_timeout", () => {
	test("createDb connections wait instead of throwing instantly on write contention", async () => {
		const db = await createDb(":memory:");
		const raw = (db as unknown as { $client: Database }).$client;
		const pragma = raw.prepare("PRAGMA busy_timeout").get() as { timeout: number };
		expect(pragma.timeout).toBe(BUSY_TIMEOUT_MS);
		raw.close();
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

		expect(instantElapsed).toBeLessThan(100);
		expect(patientElapsed).toBeGreaterThanOrEqual(200);

		writer.exec("COMMIT");
		writer.close();
		impatient.close();
		patient.close();
	});
});
