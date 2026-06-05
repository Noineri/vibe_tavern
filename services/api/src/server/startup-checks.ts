import { readdir, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { resolveMigrationsFolder } from "@vibe-tavern/db";
import { resolveTokenizerDir } from "../ai/tokenizer-service.js";
import { resolveScriptAiPromptPath } from "../scripts-engine/script-ai-assistant.js";
import { resolveRuntimeStorePaths } from "../session/session-runtime-store.js";

export interface StartupFileCheckOptions {
	readonly mode: string;
	readonly rootDir?: string;
	readonly dataDir?: string;
	readonly staticDir?: string;
	readonly requireStatic?: boolean;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function fileExists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

async function checkFile(label: string, path: string, required = true): Promise<boolean> {
	try {
		const info = await Bun.file(path).stat();
		if (!info.isFile()) {
			console.log(`[startup-check] ❌ ${label}: not a file — ${path}`);
			return false;
		}
		console.log(`[startup-check] ✅ ${label}: ${path} (${formatSize(info.size)})`);
		return true;
	} catch {
		const icon = required ? "❌" : "⚠️";
		console.log(`[startup-check] ${icon} ${label}: missing — ${path}`);
		return !required;
	}
}

async function checkDir(label: string, path: string, required = true): Promise<boolean> {
	try {
		const info = await Bun.file(path).stat();
		if (!info.isDirectory()) {
			console.log(`[startup-check] ❌ ${label}: not a directory — ${path}`);
			return false;
		}
		console.log(`[startup-check] ✅ ${label}: ${path}`);
		return true;
	} catch {
		const icon = required ? "❌" : "⚠️";
		console.log(`[startup-check] ${icon} ${label}: missing — ${path}`);
		return !required;
	}
}

async function countFiles(path: string, predicate: (name: string) => boolean): Promise<number> {
	try {
		const entries = await readdir(path);
		return entries.filter(predicate).length;
	} catch {
		return 0;
	}
}

export async function runStartupFileChecks(options: StartupFileCheckOptions): Promise<void> {
	const rootDir = resolve(options.rootDir ?? process.env.RP_PLATFORM_ROOT_DIR ?? process.cwd());
	const storePaths = resolveRuntimeStorePaths(options.dataDir);
	const dataDir = storePaths.dataDir;

	console.log(`[startup-check] ${options.mode}: verifying runtime files...`);
	console.log(`[startup-check] Root: ${rootDir}`);
	console.log(`[startup-check] Data: ${dataDir}`);

	await mkdir(dataDir, { recursive: true });
	await mkdir(resolve(dataDir, "assets"), { recursive: true });

	let ok = true;
	ok = await checkDir("data directory", dataDir) && ok;
	ok = await checkDir("asset directory", resolve(dataDir, "assets")) && ok;

	if (await fileExists(storePaths.dbPath)) {
		ok = await checkFile("database", storePaths.dbPath) && ok;
	} else {
		console.log(`[startup-check] ✅ database: will be created at ${storePaths.dbPath}`);
	}

	const migrationsDir = await resolveMigrationsFolder();
	ok = await checkDir("migrations directory", migrationsDir) && ok;
	ok = await checkFile("migrations journal", join(migrationsDir, "meta", "_journal.json")) && ok;
	const migrationCount = await countFiles(migrationsDir, (name) => name.endsWith(".sql"));
	if (migrationCount > 0) {
		console.log(`[startup-check] ✅ migrations: ${migrationCount} SQL file(s)`);
	} else {
		console.log(`[startup-check] ❌ migrations: no SQL files found in ${migrationsDir}`);
		ok = false;
	}

	const tokenizerDir = await resolveTokenizerDir();
	ok = await checkDir("tokenizer directory", tokenizerDir) && ok;
	for (const tokenizerFile of [
		"claude.json",
		"llama3.json",
		"mistral.json",
		"nemo.json",
		"qwen2.json",
		"deepseek.json",
		"mimo.json",
		"glm-4.6.json",
		"command-r.json",
		"command-a.json",
	]) {
		ok = await checkFile(`tokenizer ${tokenizerFile}`, join(tokenizerDir, tokenizerFile)) && ok;
	}

	const promptPath = await resolveScriptAiPromptPath();
	ok = await checkFile("Script AI prompt", promptPath) && ok;

	if (options.staticDir) {
		const staticRequired = options.requireStatic ?? false;
		ok = await checkDir("web bundle", options.staticDir, staticRequired) && ok;
		ok = await checkFile("web index", join(options.staticDir, "index.html"), staticRequired) && ok;
	}

	if (!ok) {
		throw new Error("Startup file check failed. See [startup-check] lines above for missing files.");
	}

	console.log(`[startup-check] ${options.mode}: all required runtime files are available.`);
}
