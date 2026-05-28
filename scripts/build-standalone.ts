/**
 * Standalone build pipeline for Vibe Tavern.
 *
 * Produces a self-contained dist/ directory with:
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
 *   dist/
 *     vibe-tavern.exe
 *     web/
 *       index.html
 *       assets/
 *       fonts/
 *       ...
 */

import { join, resolve } from "node:path";
import { cp, rm, mkdir, stat } from "node:fs/promises";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const WEB_SOURCE = join(ROOT, "apps", "web", "dist");
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

async function main() {
	console.log("📦 Vibe Tavern — Standalone Build\n");
	console.log(`   Root: ${ROOT}`);
	console.log(`   Output: ${DIST}`);

	// ── Step 1: Clean previous output ────────────────────────────────────

	await step("Cleaning dist/", async () => {
		if (await exists(DIST)) {
			await rm(DIST, { recursive: true, force: true });
		}
		await mkdir(DIST, { recursive: true });
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

	await step("Copying frontend to dist/web/", async () => {
		if (!(await Bun.file(join(WEB_SOURCE, "index.html")).exists())) {
			throw new Error(`Frontend not found at ${WEB_SOURCE}. Build may have failed.`);
		}
		await cp(WEB_SOURCE, WEB_TARGET, { recursive: true });
		console.log(`   → ${WEB_TARGET}`);
	});

	// ── Step 3b: Copy tokenizer files to dist/tokenizers/ ───────────────────

	await step("Copying tokenizer files to dist/tokenizers/", async () => {
		const tokenizerSource = join(ROOT, "services", "api", "src", "tokenizers");
		const tokenizerTarget = join(DIST, "tokenizers");
		if (!(await exists(tokenizerSource))) {
			throw new Error(`Tokenizer source not found: ${tokenizerSource}`);
		}
		await cp(tokenizerSource, tokenizerTarget, { recursive: true });
		console.log(`   → ${tokenizerTarget}`);
	});

	// ── Step 3c: Copy DB migrations to dist/drizzle/ ────────────────────────

	await step("Copying DB migrations to dist/drizzle/", async () => {
		const drizzleSource = join(ROOT, "packages", "db", "drizzle");
		const drizzleTarget = join(DIST, "drizzle");
		if (!(await exists(drizzleSource))) {
			throw new Error(`DB migrations source not found: ${drizzleSource}`);
		}
		await cp(drizzleSource, drizzleTarget, { recursive: true });
		console.log(`   → ${drizzleTarget}`);
	});

	// ── Step 4: Compile standalone server ────────────────────────────────

	await step("Compiling standalone binary (bun build --compile)", async () => {
		const entrypoint = join(ROOT, "services", "api", "src", "standalone-server.ts");
		const ext = process.platform === "win32" ? ".exe" : "";
		const binName = `vibe-tavern${ext}`;
		const outfile = join(DIST, binName);

		if (!(await Bun.file(entrypoint).exists())) {
			throw new Error(`Entrypoint not found: ${entrypoint}`);
		}

		const proc = Bun.spawn([
			"bun", "build",
			"--compile",
			"--windows-icon", join(ROOT, "apps", "web", "public", "logo.ico"),
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

		if (!(await Bun.file(outfile).exists())) {
			throw new Error(`Expected output not found: ${outfile}`);
		}

		console.log(`   → ${outfile}`);
	});

	// ── Done ─────────────────────────────────────────────────────────────

	const ext = process.platform === "win32" ? ".exe" : "";
	console.log("\n✅ Standalone build complete!");
	console.log(`   Run: ${join(DIST, `vibe-tavern${ext}`)}`);
}

main();
