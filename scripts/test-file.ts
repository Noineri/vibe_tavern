/**
 * Spot-test wrapper — `bun run test:file -- <test-file> [extra bun-test args]`.
 *
 * WHY THIS EXISTS (owner 2026-09-21: «тесты засирают диск C»): the official
 * runner (`scripts/test.ts`) redirects TEMP/TMP/TMPDIR into a per-suite
 * disposable root and sweeps it at the end, but the skill-mandated per-file
 * verification runs (`bun test <file>`) bypass all of that — every SQLite
 * store, mkdtemp dir and WAL file lands directly in the system TEMP on C:.
 * A killed/crashed run leaves them behind forever (48 000+ `vt-*` dirs and
 * ~700 `vibe-tavern-*` dirs had accumulated to ~30 GB by 2026-09-21).
 *
 * This wrapper gives spot runs the SAME contract as the runner:
 * - a PRIVATE mkdtemp root (under `VIBE_TAVERN_TEST_TEMP_BASE ?? tmpdir()`)
 *   is created per invocation and handed to the child as TEMP/TMP/TMPDIR —
 *   everything the test writes lands there, never in the system TEMP;
 * - the root is swept on exit, red or green, with bounded Windows retries
 *   (bun:sqlite releases WAL/SHM handles asynchronously — the same measured
 *   ~700-1200ms window `closeAllDbs` handles in-process);
 * - STALE self-healing: roots older than SPOT_STALE_MS from crashed past
 *   invocations are swept at startup (24h beats any live run; a concurrent
 *   spot run's fresh root is never touched).
 *
 * Usage notes:
 * - pass paths exactly as `bun test` takes them (repo-relative or absolute);
 *   `--`-separated extras ride through verbatim (`-t "name"`, `--timeout …`);
 * - the desktop proxy variables are stripped exactly like the runner's
 *   `suiteSpawnEnv` (proxy-env incident 2026-09-14: in-file env mutation is
 *   too late — the values are captured before any test file's code runs);
 * - exit code is the child's exit code.
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SPOT_PREFIX = "vibe-tavern-spot-";
/** A crashed invocation's root is garbage after a day; a LIVE concurrent
 *  root is minutes old and never matches. */
const SPOT_STALE_MS = 24 * 60 * 60 * 1000;

const HOST_PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

function childEnv(tempRoot: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value === undefined) continue;
		if ((HOST_PROXY_ENV_KEYS as readonly string[]).includes(key)) continue;
		env[key] = value;
	}
	env.TEMP = tempRoot;
	env.TMP = tempRoot;
	env.TMPDIR = tempRoot;
	return env;
}

/** rm -rf with bounded retries for Windows' asynchronous handle release. */
async function sweepDir(path: string): Promise<void> {
	for (let pass = 0; pass < 5; pass++) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 300 * (pass + 1)));
		}
	}
}

/** Sweep roots from crashed earlier invocations (mtime older than
 *  SPOT_STALE_MS). Best-effort: an unreadable entry is skipped, never fatal. */
async function sweepStaleRoots(tempBase: string): Promise<void> {
	let entries: readonly string[];
	try {
		entries = await readdir(tempBase);
	} catch {
		return;
	}
	const now = Date.now();
	await Promise.all(
		entries
			.filter((entry) => entry.startsWith(SPOT_PREFIX))
			.map(async (entry) => {
				const path = join(tempBase, entry);
				try {
					const info = await stat(path);
					if (now - info.mtimeMs > SPOT_STALE_MS) await sweepDir(path);
				} catch {
					// Missing mid-scan or unreadable — nothing to do.
				}
			}),
	);
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error("Usage: bun run test:file -- <test-file> [extra bun-test args, e.g. -t \"name\"]");
		return 2;
	}
	const tempBase = resolve(Bun.env.VIBE_TAVERN_TEST_TEMP_BASE ?? tmpdir());
	await sweepStaleRoots(tempBase);
	const tempRoot = await mkdtemp(join(tempBase, SPOT_PREFIX));
	const child = Bun.spawn(["bun", "test", ...args], {
		cwd: process.cwd(),
		stdout: "inherit",
		stderr: "inherit",
		env: childEnv(tempRoot),
	});
	const exitCode = await child.exited;
	await sweepDir(tempRoot);
	return exitCode;
}

process.exitCode = await main();
