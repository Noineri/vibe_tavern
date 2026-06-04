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

import { resolveStandalonePaths } from "./standalone-paths.js";
import { startServerRuntime } from "./server-runtime.js";

const paths = await resolveStandalonePaths();
const host = process.env.RP_PLATFORM_HOST ?? "0.0.0.0";

startServerRuntime({
	mode: "standalone",
	dataDir: paths.dataDir,
	assetsDir: paths.assetsDir,
	staticDir: paths.webDir,
	staticEnabled: paths.webEnabled,
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
