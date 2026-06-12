/**
 * Standalone build pipeline for Vibe Tavern.
 *
 * Produces a self-contained out/standalone/ directory with:
 *   - vibe-tavern.exe (compiled standalone server)
 *   - web/index.html + assets (pre-built frontend)
 *
 * Usage:
 *   bun scripts/build-standalone.ts
 *
 * Prerequisites:
 *   - Bun runtime
 *   - Frontend must be buildable via "bun run build:web"
 *
 * Output:
 *   out/standalone/
 *     vibe-tavern.exe
 *     web/
 *       index.html
 *       assets/
 *       fonts/
 *       ...
 */

import { join, resolve } from "node:path";
import { copyFile, cp, rm, mkdir } from "node:fs/promises";

const ROOT = resolve(import.meta.dir, "..");
const STANDALONE_OUT = join(ROOT, "out", "standalone");
const WEB_SOURCE = join(ROOT, "out", "apps", "web");
const WEB_TARGET = join(STANDALONE_OUT, "web");

function exists(path: string): Promise<boolean> {
	try { const { statSync } = require('node:fs'); return Promise.resolve(!!statSync(path)); } catch { return Promise.resolve(false); }
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

async function main() {
	const pkgVersion = ((await Bun.file(join(ROOT, "package.json")).json()).version as string) ?? "0.0.0";

	console.log("📦 Vibe Tavern — Standalone Build\n");
	console.log(`   Root: ${ROOT}`);
	console.log(`   Output: ${STANDALONE_OUT}`);
	console.log(`   Version: ${pkgVersion}`);

	// ── Step 1: Clean previous output ────────────────────────────────────

	await step("Cleaning out/standalone/", async () => {
		if (await exists(STANDALONE_OUT)) {
			await rm(STANDALONE_OUT, { recursive: true, force: true });
		}
		await mkdir(STANDALONE_OUT, { recursive: true });
	});

	// ── Step 2: Build frontend ───────────────────────────────────────────

	await step("Building frontend (vite build)", async () => {
		const proc = Bun.spawn(["bun", "run", "--filter", "@vibe-tavern/web", "build"], {
			cwd: ROOT,
			stdout: "inherit",
			stderr: "inherit",
			stdin: "inherit",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`Frontend build exited with code ${exitCode}`);
		}
	});

	// ── Step 3: Copy frontend to out/standalone/web/ ─────────────────────

	await step("Copying frontend to out/standalone/web/", async () => {
		if (!(await Bun.file(join(WEB_SOURCE, "index.html")).exists())) {
			throw new Error(`Frontend not found at ${WEB_SOURCE}. Build may have failed.`);
		}
		await cp(WEB_SOURCE, WEB_TARGET, { recursive: true });
		console.log(`   → ${WEB_TARGET}`);
	});

	// ── Step 3b: Copy tokenizer files to out/standalone/tokenizers/ ───────

	await step("Copying tokenizer files to out/standalone/tokenizers/", async () => {
		const tokenizerSource = join(ROOT, "services", "api", "assets", "tokenizers");
		const tokenizerTarget = join(STANDALONE_OUT, "tokenizers");
		if (!(await exists(tokenizerSource))) {
			throw new Error(`Tokenizer source not found: ${tokenizerSource}`);
		}
		await cp(tokenizerSource, tokenizerTarget, { recursive: true });
		console.log(`   → ${tokenizerTarget}`);
	});

	// ── Step 3c: Copy AI assistant prompt files to out/standalone/ ────────

	await step("Copying AI assistant prompt files", async () => {
		const { readdir } = await import("node:fs/promises");
		const promptDir = join(ROOT, "services", "api", "assets");
		const files = (await readdir(promptDir)).filter((f: string) => f.endsWith(".md"));
		if (files.length === 0) {
			throw new Error(`No .md prompt files found in ${promptDir}`);
		}
		for (const file of files) {
			await copyFile(join(promptDir, file), join(STANDALONE_OUT, file));
			console.log(`   → ${join(STANDALONE_OUT, file)}`);
		}
	});

	// ── Step 3d: Copy DB migrations to out/standalone/drizzle/ ────────────

	await step("Copying DB migrations to out/standalone/drizzle/", async () => {
		const drizzleSource = join(ROOT, "packages", "db", "drizzle");
		const drizzleTarget = join(STANDALONE_OUT, "drizzle");
		if (!(await exists(drizzleSource))) {
			throw new Error(`DB migrations source not found: ${drizzleSource}`);
		}
		await cp(drizzleSource, drizzleTarget, { recursive: true });
		console.log(`   → ${drizzleTarget}`);
	});

	// ── Step 4: Compile standalone server ────────────────────────────────

	await step("Compiling standalone binary (Bun.build API)", async () => {
		const entrypoint = join(ROOT, "services", "api", "src", "server", "standalone-server.ts");
		const ext = process.platform === "win32" ? ".exe" : "";
		const binName = `vibe-tavern${ext}`;
		const outfile = join(STANDALONE_OUT, "vibe-tavern"); // Bun automatically adds .exe

		if (!(await Bun.file(entrypoint).exists())) {
			throw new Error(`Entrypoint not found: ${entrypoint}`);
		}

		const iconPath = join(ROOT, "apps", "web", "public", "logo.ico");

		const result = await Bun.build({
			entrypoints: [entrypoint],
			target: "bun",
			minify: true,
			bytecode: true,
			define: {
				VIBE_TAVERN_VERSION: `"${pkgVersion}"`,
			},
			compile: {
				outfile,
				windows: {
					icon: iconPath,
					title: "Vibe Tavern",
					description: "A lightweight, self-hosted AI roleplay platform",
				},
			},
		});

		if (!result.success) {
			console.error("Build failed:");
			for (const msg of result.logs) {
				console.error(msg);
			}
			throw new Error("Bun.build API failed");
		}

		const finalOutfile = join(STANDALONE_OUT, binName);
		if (!(await Bun.file(finalOutfile).exists())) {
			throw new Error(`Expected output not found: ${finalOutfile}`);
		}

		console.log(`   → ${finalOutfile}`);
	});

	// ── Done ─────────────────────────────────────────────────────────────

	const ext = process.platform === "win32" ? ".exe" : "";
	console.log("\n✅ Standalone build complete!");
	console.log(`   Run: ${join(STANDALONE_OUT, `vibe-tavern${ext}`)}`);
}

main();
