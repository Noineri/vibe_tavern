/**
 * Pins the test-suite temp-dir sweep's safety and bounded-work contracts
 * (closeAllDbs in src/db-connection.ts, wired via the store-cleanup preload):
 *
 *  - SAFETY: only prefixed dirs whose mtime is inside THIS run are removed;
 *    an older prefixed dir survives, and a non-prefixed fresh dir survives.
 *  - BOUNDED WORK: the sweep honors sweepDeadlineMs — when the deadline is
 *    already expired it removes nothing and returns, instead of grinding
 *    through rm-retry passes until the afterAll hook times out. That
 *    unbounded tail is the CI windows flake: a global `(unnamed)` hook
 *    timeout (73s > the 60s hook budget) misattributed to the last test
 *    file (run 34748163545, attributed to profile-md.test.ts, which has no
 *    hooks of its own).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAllDbs } from "../src/db-connection.js";

async function exists(path: string): Promise<boolean> {
	const { stat } = await import("node:fs/promises");
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** A prefixed dir whose mtime places it inside `since` (fresh) or before it. */
async function makePrefixedDir(name: string, mtime: Date): Promise<string> {
	const dir = join(tmpdir(), name);
	await mkdir(dir, { recursive: true });
	await utimes(dir, mtime, mtime);
	return dir;
}

describe("closeAllDbs temp-dir sweep", () => {
	const created: string[] = [];

	test("removes fresh prefixed dirs, keeps older prefixed and non-prefixed ones", async () => {
		const now = Date.now();
		const fresh = await makePrefixedDir(`vt-sweep-fresh-${now}`, new Date(now));
		const old = await makePrefixedDir(`vt-sweep-old-${now}`, new Date(now - 3 * 60_000));
		const other = await mkdtemp(join(tmpdir(), "unrelated-"));
		created.push(fresh, old, other);

		await closeAllDbs({ sweepSince: now - 60_000, sweepDeadlineMs: 10_000 });

		expect(await exists(fresh)).toBe(false);
		expect(await exists(old)).toBe(true);
		expect(await exists(other)).toBe(true);
	});

	test("honors sweepDeadlineMs: an expired deadline removes nothing and returns", async () => {
		const now = Date.now();
		const fresh = await makePrefixedDir(`vt-sweep-deadline-${now}`, new Date(now));
		created.push(fresh);

		// Deadline already elapsed at entry: the sweep must not start removing
		// (the unbounded version ground on through rm-retry passes until the
		// afterAll hook itself timed out on the windows runner).
		await closeAllDbs({ sweepSince: now - 60_000, sweepDeadlineMs: 1 });

		expect(await exists(fresh)).toBe(true);
	});

	afterAll(async () => {
		for (const dir of created) await rm(dir, { recursive: true, force: true });
	});
});
