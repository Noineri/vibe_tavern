/**
 * Pins the soft-vs-fatal boundary.
 *
 * `fatal` must mean exactly one thing: a rename landed on disk and was not
 * fully undone, so the install is in a mixed old/new state. Everything else —
 * network, checksum, extraction, and even a swap that failed but rolled back
 * cleanly — is `soft` and must offer Retry.
 *
 * These are the regression pins for the two defects Wave 1 fixes:
 *   1. `swapStarted = true` was set BEFORE performSwap, so a failure while
 *      merely preparing the swap was reported as a corrupted install.
 *   2. `fetchReleaseAssets` had no try/catch, so a DNS blip threw past
 *      downloadAndSwap and reached the orchestrator as a non-SoftUpdateError.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchReleaseAssets, performSwap } from "../src/server/updater.js";

/**
 * Every case that needs a FAILING swap injects it with POSIX mode bits, which
 * Windows ignores for rename and delete — the injection silently does nothing
 * there and the swap succeeds. See updater-swap.test.ts's header; those cases
 * are skipped on Windows rather than asserted into a false green.
 */
const IS_WINDOWS = process.platform === "win32";

let root = "";
let installDir = "";
let stagingDir = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vt-classify-"));
	installDir = join(root, "install");
	stagingDir = join(root, "staging");
	await mkdir(installDir, { recursive: true });
	await mkdir(stagingDir, { recursive: true });
});

afterEach(async () => {
	for (const name of await readdir(installDir).catch(() => [])) {
		await chmod(join(installDir, name), 0o755).catch(() => undefined);
	}
	await rm(root, { recursive: true, force: true });
});

async function write(dir: string, rel: string, contents: string): Promise<void> {
	const full = join(dir, rel);
	await mkdir(join(full, ".."), { recursive: true });
	await writeFile(full, contents);
}

/**
 * Make `installDir/<name>`'s backup rename fail with EACCES. Renaming a
 * directory requires write permission on the directory itself (its ".." entry
 * is rewritten), so mode 0555 blocks exactly this one entry.
 * See updater-swap.test.ts for the full rationale.
 */
async function sabotage(name: string): Promise<void> {
	await chmod(join(installDir, name), 0o555);
}

describe("performSwap install-modified signal", () => {
	it.skipIf(IS_WINDOWS)("never reports modified when the very first backup fails", async () => {
		await write(installDir, "solo/file", "OLD");
		await write(stagingDir, "solo/file", "NEW");
		await sabotage("solo");

		const signals: boolean[] = [];
		await expect(
			performSwap(installDir, stagingDir, (m) => signals.push(m)),
		).rejects.toThrow();

		// Nothing landed on disk: the listener was never told otherwise.
		expect(signals).toEqual([]);
		expect(await readFile(join(installDir, "solo", "file"), "utf8")).toBe("OLD");
	});

	it.skipIf(IS_WINDOWS)("reports modified=true then modified=false when a mid-flight failure rolls back cleanly", async () => {
		const names = ["alpha", "bravo", "charlie", "delta"];
		for (const n of names) {
			await write(installDir, `${n}/file`, `OLD ${n}`);
			await write(stagingDir, `${n}/file`, `NEW ${n}`);
		}
		const entries = await readdir(stagingDir);
		const last = entries[entries.length - 1];
		if (last === undefined) throw new Error("staging dir is empty");
		await sabotage(last);

		const signals: boolean[] = [];
		await expect(
			performSwap(installDir, stagingDir, (m) => signals.push(m)),
		).rejects.toThrow();

		// It DID mutate, then it fully undid the mutation — so the final word
		// to the caller is "not modified", which is what keeps this soft.
		expect(signals[0]).toBe(true);
		expect(signals.at(-1)).toBe(false);
		for (const n of names) {
			expect(await readFile(join(installDir, n, "file"), "utf8")).toBe(`OLD ${n}`);
		}
	});

	it("reports modified=true exactly once on a successful swap", async () => {
		await write(installDir, "a", "OLD a");
		await write(installDir, "b", "OLD b");
		await write(stagingDir, "a", "NEW a");
		await write(stagingDir, "b", "NEW b");

		const signals: boolean[] = [];
		await performSwap(installDir, stagingDir, (m) => signals.push(m));

		expect(signals).toEqual([true]);
	});
});

describe("performSwap — half-swapped entry is restored", () => {
	it.skipIf(IS_WINDOWS)("puts back an entry whose backup landed but whose replacement did not", async () => {
		// The staging replacement is removed after planning, so the backup
		// rename succeeds and the move rename fails with ENOENT. Before the
		// Wave 1 fix this entry was never restored — the install simply lost it.
		await write(installDir, "only", "OLD only");
		await write(stagingDir, "only", "NEW only");
		const plannedButMissing = join(stagingDir, "only");

		// Replace the staging file with a directory that cannot be renamed onto
		// the (now vacant) install path in one step: an unreadable, non-empty
		// dir whose parent denies the move.
		await rm(plannedButMissing);
		await mkdir(plannedButMissing, { recursive: true });
		await writeFile(join(plannedButMissing, "inner"), "NEW");
		await chmod(stagingDir, 0o555);

		const signals: boolean[] = [];
		try {
			await expect(
				performSwap(installDir, stagingDir, (m) => signals.push(m)),
			).rejects.toThrow();
		} finally {
			await chmod(stagingDir, 0o755);
		}

		// The install still has its original file, and the caller was told the
		// mutation was undone.
		expect(await readFile(join(installDir, "only"), "utf8")).toBe("OLD only");
		expect(signals.at(-1)).toBe(false);
	});
});

describe("fetchReleaseAssets network failures", () => {
	// Every case here must RESOLVE to null, never reject. A rejection escapes
	// downloadAndSwap's try block and reaches the orchestrator as a
	// non-SoftUpdateError, which is reported to the user as "install may be
	// corrupted" — for what is only a failed HTTP request.
	const originalBase = process.env.VT_UPDATE_API_BASE;

	afterEach(() => {
		if (originalBase === undefined) delete process.env.VT_UPDATE_API_BASE;
		else process.env.VT_UPDATE_API_BASE = originalBase;
	});

	it("returns null when the host refuses the connection", async () => {
		// Bind and immediately release a port so nothing is listening on it.
		const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const deadPort = probe.port;
		probe.stop(true);
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${deadPort}`;

		expect(await fetchReleaseAssets("v1.0.0")).toBeNull();
	});

	it("returns null on a non-2xx response", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${server.port}`;
		try {
			expect(await fetchReleaseAssets("v1.0.0")).toBeNull();
		} finally {
			server.stop(true);
		}
	});

	it("returns null when the body is not valid JSON", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("<html>rate limited</html>", {
				headers: { "content-type": "application/json" },
			}),
		});
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${server.port}`;
		try {
			expect(await fetchReleaseAssets("v1.0.0")).toBeNull();
		} finally {
			server.stop(true);
		}
	});

	it("parses a well-formed release from the mock server", async () => {
		const suffix = process.platform === "win32" ? "-windows.zip" : "-linux.tar.gz";
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					tag_name: "v1.0.0",
					body: "notes",
					assets: [
						{ name: `Vibe-Tavern-v1.0.0${suffix}`, browser_download_url: "http://x.test/a" },
						{ name: "SHA256SUMS.txt", browser_download_url: "http://x.test/s" },
					],
				}),
		});
		process.env.VT_UPDATE_API_BASE = `http://127.0.0.1:${server.port}`;
		try {
			const release = await fetchReleaseAssets("v1.0.0");
			expect(release?.version).toBe("1.0.0");
			expect(release?.archiveAsset.name).toBe(`Vibe-Tavern-v1.0.0${suffix}`);
		} finally {
			server.stop(true);
		}
	});
});
