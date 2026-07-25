/**
 * Dev orchestrator — one command, full-HMR webapp with a live backend.
 *
 * Spawns two long-running children and ties their lifetimes together:
 *   - API           — copies runtime assets, then runs prod-server.ts from the
 *                     repo ROOT (cwd matters: the server resolves tokenizers /
 *                     migrations / data against cwd, and only the root layout
 *                     is correct — running it from services/api/ misresolves
 *                     `out/` and fails startup checks).
 *   - web (HMR)     — Bun-native HMR server on :4173 (dev-server.ts --debug)
 *                     that proxies /api and /assets → :8787, so the frontend
 *                     hot-reloads while talking to the real backend.
 *
 * This is the everyday `bun run dev`. The former `dev` (full prod build, then
 * serve the static artifacts) now lives under `bun run preview`.
 *
 * IMPORTANT — two ports, only one hot-reloads:
 *   :4173  the HMR dev UI  ← edit files against THIS (auto-opened below)
 *   :8787  the raw API + a STATIC one-shot bundle (no HMR); the browser
 *          auto-open baked into the prod server is suppressed here so it
 *          doesn't lure you into editing against the port that never updates.
 *
 * Lifecycle: if either child exits, we tear down the other and exit with the
 * same code; SIGINT/SIGTERM (Ctrl-C) propagates to both.
 */
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath;

// Runtime assets (tokenizers, prompts, migrations) must be in out/ before the
// API boots — its startup checks hard-fail on missing tokenizers.
const copy = Bun.spawn([BUN, "scripts/copy-api-assets.ts"], {
	cwd: ROOT,
	stdio: ["inherit", "inherit", "inherit"],
});
const copyCode = await copy.exited;
if (copyCode !== 0) process.exit(copyCode);

const procs = [
	// API from repo root so cwd-relative path resolution is correct.
	// RP_PLATFORM_OPEN_BROWSER=0: the prod server otherwise auto-opens a
	// browser at :8787 — the STATIC bundle, which has NO HMR. That trains you
	// to edit against the wrong port and see nothing change. In dev the live
	// surface is the HMR server on :4173 (opened below), so suppress :8787.
	Bun.spawn([BUN, "services/api/src/server/prod-server.ts"], {
		cwd: ROOT,
		env: { ...process.env, RP_PLATFORM_OPEN_BROWSER: "0" },
		stdio: ["inherit", "inherit", "inherit"],
	}),
	// Web HMR server (proxies /api + /assets → :8787). Spawn the dev-server
	// entrypoint directly rather than via `bun run dev:web:debug` — the
	// `--filter` wrapper is an intermediate process that .kill() won't
	// propagate through, orphaning the real server and leaking port 4173.
	Bun.spawn([BUN, "apps/web/dev-server.ts", "--debug"], {
		cwd: ROOT,
		stdio: ["inherit", "inherit", "inherit"],
	}),
];

// Open the HMR surface (:4173), not the API's static bundle (:8787), once the
// web server answers. Matches the old auto-open habit but points at the port
// that actually hot-reloads. Opt out with RP_PLATFORM_OPEN_BROWSER=0.
const WEB_URL = "http://localhost:4173";
if (process.env.RP_PLATFORM_OPEN_BROWSER !== "0") {
	void (async () => {
		for (let i = 0; i < 60; i++) {
			try {
				const res = await fetch(`${WEB_URL}/`);
				if (res.ok) break;
			} catch {
				// server not up yet — keep polling
			}
			await Bun.sleep(500);
		}
		console.log(`\n  ▶ Dev UI with HMR: ${WEB_URL}  (edit files here — :8787 is the no-HMR static build)\n`);
		const args =
			process.platform === "win32" ? ["cmd", "/c", "start", "", WEB_URL]
			: process.platform === "darwin" ? ["open", WEB_URL]
			: ["xdg-open", WEB_URL];
		Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
	})();
}

let shuttingDown = false;
function shutdown(code: number): never {
	if (!shuttingDown) {
		shuttingDown = true;
		for (const p of procs) p.kill();
	}
	process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => shutdown(0));
}

// First child to exit tears down the rest.
const code = await Promise.race(procs.map((p) => p.exited));
shutdown(code);
