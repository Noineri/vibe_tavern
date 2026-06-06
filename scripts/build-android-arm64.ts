/**
 * Android ARM64 release artifact build pipeline for Vibe Tavern.
 *
 * Produces a prebuilt archive intended for Termux + proot Ubuntu on Android:
 *   - out/android-arm64/vibe-tavern      (compiled linux-arm64 standalone server)
 *   - out/android-arm64/web/             (pre-built frontend)
 *   - out/android-arm64/drizzle/         (DB migrations)
 *   - out/android-arm64/tokenizers/      (runtime tokenizer JSON files)
 *   - out/vibe-tavern-android-arm64.tar.gz
 *
 * Usage:
 *   bun run build:android-arm64
 */

import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "out");
const ANDROID_DIST = join(OUT, "android-arm64");
const ARCHIVE = join(OUT, "vibe-tavern-android-arm64.tar.gz");
const WEB_SOURCE = join(ROOT, "out", "apps", "web");
const WEB_TARGET = join(ANDROID_DIST, "web");

function exists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
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
	console.log("📦 Vibe Tavern — Android ARM64 Artifact Build\n");
	console.log(`   Root:    ${ROOT}`);
	console.log(`   Output:  ${ANDROID_DIST}`);
	console.log(`   Archive: ${ARCHIVE}`);

	await step("Cleaning Android output", async () => {
		await rm(ANDROID_DIST, { recursive: true, force: true });
		await rm(ARCHIVE, { force: true });
		await mkdir(ANDROID_DIST, { recursive: true });
	});

	await step("Building frontend", async () => {
		await run(["bun", "run", "--filter", "@vibe-tavern/web", "build"]);
	});

	await step("Copying frontend to out/android-arm64/web/", async () => {
		if (!(await Bun.file(join(WEB_SOURCE, "index.html")).exists())) {
			throw new Error(`Frontend not found at ${WEB_SOURCE}. Build may have failed.`);
		}
		await cp(WEB_SOURCE, WEB_TARGET, { recursive: true });
		console.log(`   → ${WEB_TARGET}`);
	});

	await step("Copying tokenizer files", async () => {
		await copyRequiredDir(
			join(ROOT, "services", "api", "assets", "tokenizers"),
			join(ANDROID_DIST, "tokenizers"),
			"Tokenizer",
		);
	});

	await step("Copying Script AI prompt", async () => {
		const promptSource = join(ROOT, "services", "api", "assets", "script-ai-prompt.md");
		const promptTarget = join(ANDROID_DIST, "script-ai-prompt.md");
		if (!(await exists(promptSource))) {
			throw new Error(`Script AI prompt source not found: ${promptSource}`);
		}
		await copyFile(promptSource, promptTarget);
		console.log(`   → ${promptTarget}`);
	});

	await step("Copying DB migrations", async () => {
		await copyRequiredDir(
			join(ROOT, "packages", "db", "drizzle"),
			join(ANDROID_DIST, "drizzle"),
			"DB migrations",
		);
	});

	await step("Compiling linux-arm64 standalone binary", async () => {
		const entrypoint = join(ROOT, "services", "api", "src", "server", "standalone-server.ts");
		const outfile = join(ANDROID_DIST, "vibe-tavern");
		const compileCwd = join(tmpdir(), "vibe-tavern-android-arm64-build");

		if (!(await Bun.file(entrypoint).exists())) {
			throw new Error(`Entrypoint not found: ${entrypoint}`);
		}

		// Bun cross-compilation on Windows can fail while extracting the target
		// runtime when the process cwd is on a non-system drive. Keep entry/output
		// absolute, but run the compile step from the OS temp directory.
		await rm(compileCwd, { recursive: true, force: true });
		await mkdir(compileCwd, { recursive: true });
		await run([
			"bun",
			"build",
			"--compile",
			"--target=bun-linux-arm64",
			"--minify",
			entrypoint,
			"--outfile",
			outfile,
		], compileCwd);

		if (!(await Bun.file(outfile).exists())) {
			throw new Error(`Expected output not found: ${outfile}`);
		}

		await chmod(outfile, 0o755).catch(() => undefined);
		console.log(`   → ${outfile}`);
	});

	await step("Packaging out/vibe-tavern-android-arm64.tar.gz", async () => {
		await run([
			"tar",
			"-czf",
			join("out", "vibe-tavern-android-arm64.tar.gz"),
			"-C",
			join("out", "android-arm64"),
			".",
		]);
	});

	console.log("\n✅ Android ARM64 artifact build complete!");
	console.log(`   Archive: ${ARCHIVE}`);
	console.log("   Runtime env expected on Android/proot:");
	console.log("     RP_PLATFORM_OPEN_BROWSER=0");
	console.log("     RP_PLATFORM_HOST=127.0.0.1");
	console.log("     RP_PLATFORM_PORT=8787");
	console.log("     RP_PLATFORM_DATA_DIR=$HOME/.local/share/vibe-tavern");
	console.log("     RP_PLATFORM_WEB_DIR=$HOME/vibe-tavern/web");
}

main();
