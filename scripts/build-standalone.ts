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
import { cp, mkdir, rm } from "node:fs/promises";
import { statSync, writeFileSync } from "node:fs";
import { pathExists } from "./_fs.js";
import { copyPromptAssets } from "./_prompt-assets.js";
import { VERSION } from "./_version.js";
import {
	generateEmbeddedWebManifest,
	writeEmbeddedWebStub,
	MANIFEST_PATH,
	STUB_CONTENT,
} from "./generate-embedded-web-manifest.js";

const ROOT = resolve(import.meta.dir, "..");
const STANDALONE_OUT = join(ROOT, "out", "standalone");
const WEB_SOURCE = join(ROOT, "out", "apps", "web");
const WEB_TARGET = join(STANDALONE_OUT, "web");

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
	console.log("📦 Vibe Tavern — Standalone Build\n");
	console.log(`   Root: ${ROOT}`);
	console.log(`   Output: ${STANDALONE_OUT}`);
	console.log(`   Version: ${VERSION}`);

	// ── Step 1: Clean previous output ────────────────────────────────────

	await step("Cleaning out/standalone/", async () => {
		if (await pathExists(STANDALONE_OUT)) {
			await rm(STANDALONE_OUT, { recursive: true, force: true });
		}
		await mkdir(STANDALONE_OUT, { recursive: true });
	});

	// ── Step 2: Build frontend ───────────────────────────────────────────

	await step("Building frontend (Bun build)", async () => {
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
		if (!(await pathExists(tokenizerSource))) {
			throw new Error(`Tokenizer source not found: ${tokenizerSource}`);
		}
		await cp(tokenizerSource, tokenizerTarget, { recursive: true });
		console.log(`   → ${tokenizerTarget}`);
	});

	// ── Step 3c: Copy AI assistant prompt files to out/standalone/prompts/ ────────

	await step("Copying AI assistant prompt files", async () => {
		const promptDir = join(ROOT, "services", "api", "assets");
		// Flat *.md + every nested prompt tree (coauthor/, experience-copilot/)
		// via the shared copier — see _prompt-assets.ts history.
		const targets = await copyPromptAssets(promptDir, join(STANDALONE_OUT, "prompts"));
		for (const target of targets) {
			console.log(`   → ${target}`);
		}
	});

	// ── Step 3d: Copy DB migrations to out/standalone/drizzle/ ────────────

	await step("Copying DB migrations to out/standalone/drizzle/", async () => {
		const drizzleSource = join(ROOT, "packages", "db", "drizzle");
		const drizzleTarget = join(STANDALONE_OUT, "drizzle");
		if (!(await pathExists(drizzleSource))) {
			throw new Error(`DB migrations source not found: ${drizzleSource}`);
		}
		await cp(drizzleSource, drizzleTarget, { recursive: true });
		console.log(`   → ${drizzleTarget}`);
	});

	// ── Step 4: Generate embedded-web manifest ─────────────────────────
	//
	// Bake the entire frontend (out/apps/web/**) into the .exe via Bun's
	// `import ... with { type: "file" }` mechanism. The generated manifest
	// replaces the committed stub just for the duration of the compile step
	// below; it's restored to the stub afterward so the working tree stays
	// clean and dev/typecheck remains unaffected.
	await step("Generating embedded web manifest", async () => {
		const { fileCount } = await generateEmbeddedWebManifest();
		console.log(`   → ${fileCount} file(s) will be embedded into the binary.`);
	});

	// Safety net: if anything below calls process.exit() (e.g. a failed `step`
	// calls process.exit(1)), the finally below won't run. Restore the stub
	// synchronously in an exit handler so the working tree is never left with
	// a generated manifest referencing out/apps/web/** (which may be cleaned).
	process.on("exit", () => {
		// Exit handlers cannot await, so keep metadata and restoration on Node's
		// synchronous APIs. Registration follows successful generation, so stat the
		// recovery target and restore the known-good stub without a size heuristic.
		try {
			if (!statSync(MANIFEST_PATH).isFile()) {
				console.error("[build-standalone] Cannot restore embedded-web-manifest.ts: recovery target is not a file.");
				return;
			}
			writeFileSync(MANIFEST_PATH, STUB_CONTENT, "utf-8");
			console.log("[build-standalone] Restored embedded-web-manifest.ts stub (exit handler).");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[build-standalone] Failed to restore embedded-web-manifest.ts stub: ${detail}`);
		}
	});

	// ── Step 5: Compile standalone server ────────────────────────

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
				VIBE_TAVERN_VERSION: `"${VERSION}"`,
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

	// ── Step 6: Restore embedded-web-manifest.ts stub ────────────────────
	await step("Restoring embedded-web-manifest.ts stub", async () => {
		await writeEmbeddedWebStub();
	});

	// ── Done ─────────────────────────────────────────────────────────────

	const ext = process.platform === "win32" ? ".exe" : "";
	console.log("\n✅ Standalone build complete!");
	console.log(`   Run: ${join(STANDALONE_OUT, `vibe-tavern${ext}`)}`);
}

main();
