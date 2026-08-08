/**
 * Standalone path resolution for Vibe Tavern.
 *
 * Centralizes all directory resolution for the standalone .exe build.
 * Priority: environment variable → OS convention → throw.
 *
 * Environment variables:
 *   VIBE_TAVERN_DATA_DIR  — all user data (DB, assets, traces, logs)
 *   VIBE_TAVERN_WEB_DIR   — built frontend static files
 *   VIBE_TAVERN_HOST      — listen host (default: 127.0.0.1)
 *   VIBE_TAVERN_PORT      — listen port (default: 8787)
 *
 * OS convention defaults:
 *   Windows: %LOCALAPPDATA%\VibeTavern
 *   macOS:   ~/Library/Application Support/VibeTavern
 *   Linux:   ~/.local/share/vibe-tavern
 */

import { homedir } from "node:os";
import { resolve, join } from "node:path";

export interface StandalonePaths {
	/** Root directory for all user data. */
	readonly dataDir: string;
	/** SQLite database file path. */
	readonly dbPath: string;
	/** Avatar/image assets directory. */
	readonly assetsDir: string;
	/** Prompt trace export directory. */
	readonly traceDir: string;
	/** Debug log file directory. */
	readonly logsDir: string;
	/** Built frontend static files directory. May not exist in API-only mode. */
	readonly webDir: string;
	/** Whether the frontend static dir exists and contains index.html. */
	readonly webEnabled: boolean;
	/** Listen host. */
	readonly host: string;
	/** Listen port. */
	readonly port: number;
}

function defaultDataDir(): string {
	const platform = process.platform;

	if (platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			return resolve(localAppData, "VibeTavern");
		}
		return resolve(homedir(), "AppData", "Local", "VibeTavern");
	}

	if (platform === "darwin") {
		return resolve(homedir(), "Library", "Application Support", "VibeTavern");
	}

	// Linux and other POSIX
	const xdgData = process.env.XDG_DATA_HOME;
	if (xdgData) {
		return resolve(xdgData, "vibe-tavern");
	}
	return resolve(homedir(), ".local", "share", "vibe-tavern");
}

/**
 * Where `web/` sits relative to the running program.
 *
 * `baseDir` exists because the anchor is not the same in every distribution.
 * A compiled binary keeps web/ next to the executable, so process.execPath is
 * right. An npm install runs under the USER'S bun — process.execPath points at
 * ~/.bun/bin/bun, nowhere near the package — so npm-server.ts passes its own
 * import.meta.dir instead.
 */
async function defaultWebDir(baseDir: string | undefined): Promise<string> {
	const anchor = baseDir ?? resolve(process.execPath, "..");
	const anchoredWebDir = resolve(anchor, "web");
	if (await Bun.file(resolve(anchoredWebDir, "index.html")).exists()) {
		return anchoredWebDir;
	}

	return resolve(process.cwd(), "out", "apps", "web");
}

export interface StandalonePathOptions {
	/** Anchor for `web/`. Defaults to the executable's directory. */
	readonly baseDir?: string;
}

export async function resolveStandalonePaths(
	options: StandalonePathOptions = {},
): Promise<StandalonePaths> {
	const dataDir = process.env.VIBE_TAVERN_DATA_DIR
		? resolve(process.env.VIBE_TAVERN_DATA_DIR)
		: defaultDataDir();

	const webDir = process.env.VIBE_TAVERN_WEB_DIR
		? resolve(process.env.VIBE_TAVERN_WEB_DIR)
		: await defaultWebDir(options.baseDir);

	const webEnabled = await Bun.file(resolve(webDir, "index.html")).exists();

	return {
		dataDir,
		dbPath: resolve(dataDir, "vibe-tavern.db"),
		assetsDir: resolve(dataDir, "assets"),
		traceDir: resolve(dataDir, "traces"),
		logsDir: resolve(dataDir, "logs"),
		webDir,
		webEnabled,
		host: process.env.VIBE_TAVERN_HOST ?? "127.0.0.1",
		port: Number(process.env.VIBE_TAVERN_PORT ?? "8787"),
	};
}
