/**
 * Standalone path resolution for Vibe Tavern.
 *
 * Centralizes all directory resolution for the standalone .exe build.
 * Priority: environment variable → OS convention → throw.
 *
 * Environment variables:
 *   RP_PLATFORM_DATA_DIR  — all user data (DB, assets, traces, logs)
 *   RP_PLATFORM_WEB_DIR   — built frontend static files
 *   RP_PLATFORM_HOST      — listen host (default: 127.0.0.1)
 *   RP_PLATFORM_PORT      — listen port (default: 8787)
 *
 * OS convention defaults:
 *   Windows: %LOCALAPPDATA%\ClawTavern
 *   macOS:   ~/Library/Application Support/ClawTavern
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
			return resolve(localAppData, "ClawTavern");
		}
		return resolve(homedir(), "AppData", "Local", "ClawTavern");
	}

	if (platform === "darwin") {
		return resolve(homedir(), "Library", "Application Support", "ClawTavern");
	}

	// Linux and other POSIX
	const xdgData = process.env.XDG_DATA_HOME;
	if (xdgData) {
		return resolve(xdgData, "vibe-tavern");
	}
	return resolve(homedir(), ".local", "share", "vibe-tavern");
}

async function defaultWebDir(): Promise<string> {
	const exeDir = resolve(process.execPath, "..");
	const exeWebDir = resolve(exeDir, "web");
	if (await Bun.file(resolve(exeWebDir, "index.html")).exists()) {
		return exeWebDir;
	}

	return resolve(process.cwd(), "out", "apps", "web");
}

export async function resolveStandalonePaths(): Promise<StandalonePaths> {
	const dataDir = process.env.RP_PLATFORM_DATA_DIR
		? resolve(process.env.RP_PLATFORM_DATA_DIR)
		: defaultDataDir();

	const webDir = process.env.RP_PLATFORM_WEB_DIR
		? resolve(process.env.RP_PLATFORM_WEB_DIR)
		: await defaultWebDir();

	const webEnabled = await Bun.file(resolve(webDir, "index.html")).exists();

	return {
		dataDir,
		dbPath: resolve(dataDir, "vibe-tavern.db"),
		assetsDir: resolve(dataDir, "assets"),
		traceDir: resolve(dataDir, "traces"),
		logsDir: resolve(dataDir, "logs"),
		webDir,
		webEnabled,
		host: process.env.RP_PLATFORM_HOST ?? "127.0.0.1",
		port: Number(process.env.RP_PLATFORM_PORT ?? "8787"),
	};
}
