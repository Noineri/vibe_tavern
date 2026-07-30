/*
 * Standalone server entry point for Vibe Tavern .exe / Android distributions.
 *
 * Uses resolveStandalonePaths() for OS-specific data and web directory
 * resolution. Kept as a stable compile entrypoint for standalone, installer,
 * and Android build scripts; shared bootstrap lives in server-runtime.ts.
 *
 * Usage:
 *   vibe-tavern.exe
 *   bun services/api/src/server/standalone-server.ts
 */

import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { resolveStandalonePaths } from "./standalone-paths.js";
import { startServerRuntime } from "./server-runtime.js";
import { embeddedWebFiles } from "./embedded-web-manifest.js";
import {
	cleanupOldInstall,
	finalizeUpdatePending,
	getCurrentVersion,
	isUpdatePending,
	printVersion,
	runCheckUpdate,
	runRollback,
	runUpdate,
} from "./updater.js";

declare const VIBE_TAVERN_VERSION: string | undefined;
const _version: string = getCurrentVersion();

const rawArgs = process.argv.slice(2);
const options = {
	version: { type: "boolean", short: "v" },
	yes: { type: "boolean", short: "y" },
} as const;
const initial = parseArgs({
	args: rawArgs,
	options,
	strict: false,
	allowPositionals: true,
	tokens: true,
});
const args = [...new Set(initial.tokens.flatMap((token) =>
	token.kind === "option-terminator" ? [] : [token.index]
))].flatMap((index) => {
	const arg = rawArgs[index];
	return arg === undefined ? [] : [arg];
});
const { values, positionals } = parseArgs({
	args,
	options,
	strict: false,
	allowPositionals: true,
});
const subcommand = positionals[0];
const hasVersionFlag = values.version === true;

if (hasVersionFlag) {
	printVersion();
	process.exit(0);
}
if (subcommand === "check-update") {
	void runCheckUpdate();
} else if (subcommand === "update") {
	const yes = values.yes === true;
	void runUpdate({ yes });
} else if (subcommand === "rollback") {
	void runRollback();
} else {
	void main();
}

async function main() {
	const paths = await resolveStandalonePaths();
	const host = process.env.VIBE_TAVERN_HOST ?? "0.0.0.0";

	console.log(`[standalone] Vibe Tavern v${_version}`);

	const installDir = dirname(process.execPath);

	// Clear update backups left by a previous self-update — the legacy `.old/`
	// and every timestamped `.old-<epoch>/`. Best-effort: Windows may briefly
	// hold .exe handles, in which case this no-ops and retries next launch.
	//
	// EXCEPT on the first boot after an update: those backups are the only way
	// back, and this is precisely the boot that might fail. They are swept below
	// once the new build has actually answered a request.
	const updatePending = await isUpdatePending(installDir);
	if (updatePending) {
		console.log("[standalone] First start after an update — keeping rollback backups until this build is confirmed healthy.");
	} else {
		await cleanupOldInstall(installDir);
	}

	await startServerRuntime({
		mode: "standalone",
		dataDir: paths.dataDir,
		assetsDir: paths.assetsDir,
		staticDir: paths.webDir,
		staticEnabled: paths.webEnabled,
		embeddedWebFiles,
		host,
		port: paths.port,
		logsDir: paths.logsDir,
		extraDataDirs: [paths.traceDir],
		shutdownSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
		missingFrontendMessage: "Frontend not found. Install the web/ directory next to the executable.",
	}).catch((err) => {
		console.error("[standalone] Fatal error:", err);
		process.exit(1);
	});

	if (updatePending) {
		await confirmUpdateHealthy(installDir, paths.port);
	}
}

/**
 * Release the rollback backups, but only once the updated build is genuinely
 * serving.
 *
 * startServerRuntime resolves both when initialization succeeded AND when it
 * failed (it swaps in a static error page and keeps the process alive so the
 * user can read it), so its return is not a health signal. Asking the server
 * itself is: until the real app is mounted, the placeholder handler answers
 * every /api route with 503.
 */
async function confirmUpdateHealthy(installDir: string, port: number): Promise<void> {
	const url = `http://127.0.0.1:${port}/api/runtime/version`;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
			if (response.ok) {
				await finalizeUpdatePending(installDir);
				console.log("[standalone] Update confirmed healthy — previous version discarded.");
				return;
			}
		} catch (err) {
			// Not up yet, or refusing connections; retry below.
			if (attempt === 9) {
				console.error(
					"[standalone] Health probe never succeeded:",
					err instanceof Error ? err.message : String(err),
				);
			}
		}
		await Bun.sleep(1_000);
	}
	console.warn("[standalone] Could not confirm this build is healthy — keeping the previous version.");
	console.warn("[standalone] Run `vibe-tavern rollback` to go back to it.");
}
