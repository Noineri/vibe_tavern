/**
 * Standalone build pipeline for Claw Tavern.
 *
 * Produces a self-contained dist/ directory with:
 *   - claw-tavern.exe (compiled standalone server)
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
 *   dist/
 *     claw-tavern.exe
 *     web/
 *       index.html
 *       assets/
 *       fonts/
 *       ...
 */

import { join, resolve } from "node:path";
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const WEB_SOURCE = join(ROOT, "apps", "web", "dist");
const WEB_TARGET = join(DIST, "web");

function step(label: string, fn: () => void | Promise<void>) {
	console.log(`\n🔨 ${label}`);
	try {
		const result = fn();
		if (result instanceof Promise) {
			result.catch((e) => {
				console.error(`❌ ${label} failed:`, e);
				process.exit(1);
			});
			return result;
		}
	} catch (e) {
		console.error(`❌ ${label} failed:`, e);
		process.exit(1);
	}
}

async function main() {
	console.log("📦 Claw Tavern — Standalone Build\n");
	console.log(`   Root: ${ROOT}`);
	console.log(`   Output: ${DIST}`);

	// ── Step 1: Clean previous output ────────────────────────────────────

	step("Cleaning dist/", () => {
		if (existsSync(DIST)) {
			rmSync(DIST, { recursive: true, force: true });
		}
		mkdirSync(DIST, { recursive: true });
	});

	// ── Step 2: Build frontend ───────────────────────────────────────────

	await step("Building frontend (vite build)", async () => {
		const proc = Bun.spawn(["bun", "x", "vite", "build", "apps/web"], {
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

	// ── Step 3: Copy frontend to dist/web/ ───────────────────────────────

	step("Copying frontend to dist/web/", () => {
		if (!existsSync(join(WEB_SOURCE, "index.html"))) {
			throw new Error(`Frontend not found at ${WEB_SOURCE}. Build may have failed.`);
		}
		cpSync(WEB_SOURCE, WEB_TARGET, { recursive: true });
		console.log(`   → ${WEB_TARGET}`);
	});

	// ── Step 4: Compile standalone server ────────────────────────────────

	await step("Compiling claw-tavern.exe (bun build --compile)", async () => {
		const entrypoint = join(ROOT, "services", "api", "src", "standalone-server.ts");
		const outfile = join(DIST, "claw-tavern.exe");

		if (!existsSync(entrypoint)) {
			throw new Error(`Entrypoint not found: ${entrypoint}`);
		}

		const proc = Bun.spawn([
			"bun", "build",
			"--compile",
			entrypoint,
			"--outfile", outfile,
		], {
			cwd: ROOT,
			stdout: "inherit",
			stderr: "inherit",
			stdin: "inherit",
		});

		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`bun build --compile exited with code ${exitCode}`);
		}

		if (!existsSync(outfile)) {
			throw new Error(`Expected output not found: ${outfile}`);
		}

		console.log(`   → ${outfile}`);
	});

	// ── Done ─────────────────────────────────────────────────────────────

	console.log("\n✅ Standalone build complete!");
	console.log(`   Run: ${join(DIST, "claw-tavern.exe")}`);
}

main();
