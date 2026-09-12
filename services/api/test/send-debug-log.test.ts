/**
 * TH-1 — logSendDebug mkdir/appendFile race (TEST_SUITE_HYGIENE_REPORT).
 *
 * Pins the contract after the 2026-09-11 fix:
 *   - the first write to a cold, non-existent (nested) log directory eventually
 *     lands on disk — appendFile is chained AFTER mkdir resolves, so a slow FS
 *     cannot lose the race;
 *   - a failed write never surfaces as an unhandled rejection (bun bills those
 *     to whatever file is currently running — the original CI incident);
 *   - secret-looking keys are redacted on the way out.
 *
 * The poll loop below asserts an EVENT (file appears), not a frame — it exits
 * as soon as the write lands and only the bounded tail is timing-sensitive.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { configureLogDir, logSendDebug } from "../src/shared/send-debug-log.js";

const root = resolve(tmpdir(), "vt-send-debug-" + crypto.randomUUID().slice(0, 8));
// Deep, deliberately non-existent chain: mkdir({ recursive }) must create it
// before the first append, or the append ENOENTs — the exact original race.
const coldDir = resolve(root, "a", "b", "c");

afterAll(async () => {
	try { await rm(root, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
});

async function waitForContent(path: string, marker: string, attempts = 40): Promise<string> {
	for (let i = 0; i < attempts; i++) {
		try {
			const text = await readFile(path, "utf8");
			// Readiness = the TERMINAL event landed, not "file exists": existence
		// alone races the in-flight appends of earlier events (seen on the fast
		// CI filesystem, run 34664108932 — evt-probe present, evt-two mid-flight).
			if (text.includes(marker)) return text;
		} catch { /* not created yet */ }
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`marker "${marker}" did not land within ${attempts * 25}ms: ${path}`);
}

describe("logSendDebug (TH-1 race fix)", () => {
	it("first write to a cold nested dir eventually lands, with secrets redacted", async () => {
		configureLogDir(coldDir);
		logSendDebug("evt-probe", { apiKey: "hunter2", plain: 7 });
		const text = await waitForContent(resolve(coldDir, "send-debug.log"), "evt-probe");
		expect(text).toContain("evt-probe");
		expect(text).toContain("[redacted]");
		expect(text).not.toContain("hunter2");
		expect(text).toContain("\"plain\":7");
	});

	it("subsequent writes append after the ensured dir; unhandled rejections would fail this file", async () => {
		logSendDebug("evt-two", {});
		logSendDebug("evt-three", {});
		// evt-three is the terminal event — once it is on disk, evt-two must be
		// there too (both chain on the same dir-ensure; containment, not order,
		// is pinned: the two appends may legally interleave).
		const text = await waitForContent(resolve(coldDir, "send-debug.log"), "evt-three");
		expect(text).toContain("evt-probe");
		expect(text).toContain("evt-two");
		expect(text).toContain("evt-three");
	});

	it("a target that cannot be created (dir path occupied by a file) fails silently, never throws", async () => {
		// dirname(...) occupied by a regular file → mkdir rejects → the chained
		// append must never run and the swallowed rejection must not escape.
		const occupied = resolve(root, "occupied.log");
		await mkdir(root, { recursive: true });
		const { writeFile } = await import("node:fs/promises");
		await writeFile(occupied, "i am a file");
		configureLogDir(resolve(occupied, "sub", "send-debug.log"));
		expect(() => logSendDebug("evt-would-lose", {})).not.toThrow();
		// Give the losing chain a moment to reject; an unhandled rejection here
		// fails the whole test file under bun — that IS the regression pin.
		await new Promise((r) => setTimeout(r, 150));
	});
});
