/**
 * Linux distribution archive build for Vibe Tavern.
 *
 * Produces a self-contained archive a user can download, extract, and run:
 *   - out/linux-dist/vibe-tavern       (compiled standalone server)
 *   - out/linux-dist/web/              (pre-built frontend SPA)
 *   - out/linux-dist/tokenizers/       (runtime tokenizer JSON files)
 *   - out/linux-dist/drizzle/          (SQLite DB migrations)
 *   - out/linux-dist/prompts/         (AI assistant prompt files)
 *   - out/vibe-tavern-linux-x64.tar.gz
 *
 * Usage:
 *   bun run build:linux-dist
 *
 * The archive contains ONLY runtime files — no Docker configs,
 * no source code, no node_modules, no dev tooling.
 */

import { chmod, copyFile, cp, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VERSION } from "./_version.js";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "out");
const DIST = join(OUT, "linux-dist");
const ARCHIVE = join(OUT, "vibe-tavern-linux-x64.tar.gz");
const WEB_SOURCE = join(ROOT, "out", "apps", "web");
const WEB_TARGET = join(DIST, "web");

function exists(path: string): Promise<boolean> {
	return stat(path).then(() => true, () => false);
}

async function step(label: string, fn: () => Promise<void>) {
	console.log(`\n🔨 ${label}`);
	try {
		await fn();
	} catch (e) {
		console.error(`❌ ${label} failed:`, e);
		process.exit(1);
	}
}

async function run(command: string[], cwd = ROOT) {
	const proc = Bun.spawn(command, {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
	}
}

async function copyRequiredDir(source: string, target: string, label: string) {
	if (!(await exists(source))) {
		throw new Error(`${label} source not found: ${source}`);
	}
	await cp(source, target, { recursive: true });
	console.log(`   → ${target}`);
}

async function main() {
	console.log("📦 Vibe Tavern — Linux Distribution Build\n");
	console.log(`   Version: ${VERSION}`);
	console.log(`   Output:  ${DIST}`);
	console.log(`   Archive: ${ARCHIVE}`);

	// ── Step 1: Clean previous output ─────────────────────────────────────

	await step("Cleaning previous build", async () => {
		await rm(DIST, { recursive: true, force: true });
		await rm(ARCHIVE, { force: true });
		await mkdir(DIST, { recursive: true });
	});

	// ── Step 2: Build frontend ─────────────────────────────────────────────

	await step("Building frontend (vite build)", async () => {
		await run(["bun", "run", "--filter", "@vibe-tavern/web", "build"]);
	});

	// ── Step 3: Copy frontend ──────────────────────────────────────────────

	await step("Copying frontend to distribution", async () => {
		if (!(await Bun.file(join(WEB_SOURCE, "index.html")).exists())) {
			throw new Error(`Frontend not found at ${WEB_SOURCE}. Build may have failed.`);
		}
		await cp(WEB_SOURCE, WEB_TARGET, { recursive: true });
		console.log(`   → ${WEB_TARGET}`);
	});

	// ── Step 4: Copy tokenizer files ───────────────────────────────────────

	await step("Copying tokenizer files", async () => {
		await copyRequiredDir(
			join(ROOT, "services", "api", "assets", "tokenizers"),
			join(DIST, "tokenizers"),
			"Tokenizer",
		);
	});

	// ── Step 5: Copy AI assistant prompt files ─────────────────────────────

	await step("Copying AI assistant prompt files", async () => {
		const { readdir } = await import("node:fs/promises");
		const promptDir = join(ROOT, "services", "api", "assets");
		const files = (await readdir(promptDir)).filter((f: string) => f.endsWith(".md"));
		if (files.length === 0) {
			throw new Error(`No .md prompt files found in ${promptDir}`);
		}
		// Create prompts/ subdirectory
		await mkdir(join(DIST, "prompts"), { recursive: true });
		for (const file of files) {
			await copyFile(join(promptDir, file), join(DIST, "prompts", file));
			console.log(`   → ${join(DIST, "prompts", file)}`);
		}
	});

	// ── Step 6: Copy DB migrations ─────────────────────────────────────────

	await step("Copying DB migrations", async () => {
		await copyRequiredDir(
			join(ROOT, "packages", "db", "drizzle"),
			join(DIST, "drizzle"),
			"DB migrations",
		);
	});

	// ── Step 6b: Copy launcher script (version substituted) ──────────────

	await step("Copying launcher script", async () => {
		const wrapperSource = join(ROOT, "scripts", "dist-linux", "Vibe_Tavern.sh");
		const wrapperTarget = join(DIST, "Vibe_Tavern.sh");
		if (!(await exists(wrapperSource))) {
			throw new Error(`Launcher script not found: ${wrapperSource}`);
		}
		let content = await Bun.file(wrapperSource).text();
		content = content.replaceAll("__VERSION__", VERSION);
		await Bun.write(wrapperTarget, content);
		await chmod(wrapperTarget, 0o755);
		console.log(`   → ${wrapperTarget}`);
	});

	// ── Step 7: Compile standalone binary ──────────────────────────────────

	await step("Compiling standalone binary", async () => {
		const entrypoint = join(ROOT, "services", "api", "src", "server", "standalone-server.ts");
		const outfile = join(DIST, "vibe-tavern");

		if (!(await Bun.file(entrypoint).exists())) {
			throw new Error(`Entrypoint not found: ${entrypoint}`);
		}

		await run([
			"bun",
			"build",
			"--compile",
			"--minify",
			"--define",
			`VIBE_TAVERN_VERSION="${VERSION}"`,
			entrypoint,
			"--outfile",
			outfile,
		]);

		if (!(await Bun.file(outfile).exists())) {
			throw new Error(`Expected output not found: ${outfile}`);
		}

		await chmod(outfile, 0o755).catch(() => undefined);
		console.log(`   → ${outfile}`);
	});

	// ── Step 7b: Write VERSION file ────────────────────────────────────────

	await step("Writing VERSION file", async () => {
		const versionFile = join(DIST, "VERSION");
		await Bun.write(versionFile, `${VERSION}\n`);
		console.log(`   → ${versionFile}`);
	});

	// ── Step 8: Create tar.gz archive ──────────────────────────────────────

	await step("Packaging archive", async () => {
		await run([
			"tar",
			"-czf",
			ARCHIVE,
			"-C",
			DIST,
			".",
		]);
		console.log(`   → ${ARCHIVE}`);
	});

	// ── Done ───────────────────────────────────────────────────────────────

	console.log("\n✅ Linux distribution build complete!");
	console.log(`   Archive: ${ARCHIVE}`);
	console.log("\n   To run:");
	console.log("     tar xzf vibe-tavern-linux-x64.tar.gz");
	console.log("     ./vibe-tavern");
	console.log("\n   The server starts on http://127.0.0.1:8787");
}

main();
