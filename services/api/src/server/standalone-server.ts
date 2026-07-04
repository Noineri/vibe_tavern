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

import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStandalonePaths } from "./standalone-paths.js";
import { startServerRuntime } from "./server-runtime.js";
import { embeddedWebFiles } from "./embedded-web-manifest.js";
import { checkForUpdate, getCurrentVersion, printVersion, runCheckUpdate, runUpdate } from "./updater.js";

declare const VIBE_TAVERN_VERSION: string | undefined;
const _version: string = getCurrentVersion();

const argv = process.argv.slice(2);
const subcommand = argv[0];
const hasVersionFlag = argv.includes("--version") || argv.includes("-v");

if (hasVersionFlag) {
	printVersion();
	process.exit(0);
}
if (subcommand === "check-update") {
	void runCheckUpdate();
} else if (subcommand === "update") {
	const yes = argv.includes("--yes") || argv.includes("-y");
	void runUpdate({ yes });
} else {
	void main();
}

async function main() {
	const paths = await resolveStandalonePaths();
	const host = process.env.RP_PLATFORM_HOST ?? "0.0.0.0";

	console.log(`[standalone] Vibe Tavern v${_version}`);

	// Clear leftover .old/ from a previous self-update. Best-effort: Windows
	// may briefly hold .exe handles, in which case this no-ops and retries
	// next launch.
	const installDir = dirname(process.execPath);
	const oldDir = join(installDir, ".old");
	await stat(oldDir).then(
		() => rm(oldDir, { recursive: true, force: true }).catch(() => undefined),
		() => undefined,
	);

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
}
