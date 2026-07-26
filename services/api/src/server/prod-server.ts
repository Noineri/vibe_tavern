/*
 * Production server entry point.
 *
 * Serves the built frontend + API from one Bun process. Kept as a stable
 * entrypoint for dev scripts, Docker, and production bundles; shared bootstrap
 * lives in server-runtime.ts.
 *
 * Usage:
 *   bun services/api/src/server/prod-server.ts
 *   bun out/services/api/prod-server.js
 *
 * Environment:
 *   VIBE_TAVERN_ROOT_DIR   — project root (default: cwd)
 *   VIBE_TAVERN_DATA_DIR   — user data dir (default: <root>/data)
 *   VIBE_TAVERN_HOST       — listen host (default: 0.0.0.0)
 *   VIBE_TAVERN_PORT       — listen port (default: 8787)
 */

import { resolve } from "node:path";
import { startServerRuntime } from "./server-runtime.js";

const rootDir = resolve(process.env.VIBE_TAVERN_ROOT_DIR ?? process.cwd());
const staticDir = resolve(rootDir, "out", "apps", "web");
const dataDir = resolve(process.env.VIBE_TAVERN_DATA_DIR ?? resolve(rootDir, "data"));
const assetsDir = resolve(dataDir, "assets");
const staticEnabled = await Bun.file(resolve(staticDir, "index.html")).exists();

startServerRuntime({
	mode: "prod",
	rootDir,
	dataDir,
	assetsDir,
	staticDir,
	staticEnabled,
	host: process.env.VIBE_TAVERN_HOST ?? "0.0.0.0",
	port: Number(process.env.VIBE_TAVERN_PORT ?? "8787"),
	checkPortBeforeListen: true,
	shutdownSignals: ["SIGINT", "SIGTERM"],
	missingFrontendMessage: 'Frontend not built. Run "bun run build:web" first, or use dev mode.',
}).catch((err) => {
	console.error("[prod] Fatal error:", err);
	process.exit(1);
});
