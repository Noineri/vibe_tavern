/**
 * Native Android launcher payload build pipeline for Vibe Tavern.
 *
 * Produces generated APK inputs (never committed):
 *   - mobile/android/app/src/main/assets/payload/{web,drizzle,tokenizers,prompts}/
 *   - mobile/android/app/src/main/jniLibs/arm64-v8a/libvibetavern.so
 *
 * Usage:
 *   bun run build:android-native
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathExists } from "./_fs.js";
import { copyPromptAssets } from "./_prompt-assets.js";
import { VERSION as PACKAGE_VERSION } from "./_version.js";

const VERSION = process.env.VIBE_TAVERN_BUILD_VERSION?.trim() || PACKAGE_VERSION;
const ROOT = resolve(import.meta.dir, "..");
const PAYLOAD = join(ROOT, "mobile", "android", "app", "src", "main", "assets", "payload");
const NATIVE_DIR = join(ROOT, "mobile", "android", "app", "src", "main", "jniLibs", "arm64-v8a");
const NATIVE_OUT = join(NATIVE_DIR, "libvibetavern.so");
const WEB_SOURCE = join(ROOT, "out", "apps", "web");

async function step(label: string, fn: () => Promise<void>) {
	console.log(`\n🔨 ${label}`);
	try {
		await fn();
	} catch (error) {
		console.error(`❌ ${label} failed:`, error);
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
	if (!(await pathExists(source))) {
		throw new Error(`${label} source not found: ${source}`);
	}
	await cp(source, target, { recursive: true });
	console.log(`   → ${target}`);
}

async function main() {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(VERSION)) {
		throw new Error(`Invalid Android build version: ${VERSION}`);
	}

	console.log("📦 Vibe Tavern — Native Android Build\n");
	console.log(`   Root:    ${ROOT}`);
	console.log(`   Payload: ${PAYLOAD}`);
	console.log(`   Native:  ${NATIVE_OUT}`);
	console.log(`   Version: ${VERSION}`);

	await step("Cleaning native Android build inputs", async () => {
		await rm(PAYLOAD, { recursive: true, force: true });
		await rm(NATIVE_OUT, { force: true });
		await mkdir(PAYLOAD, { recursive: true });
		await mkdir(NATIVE_DIR, { recursive: true });
	});

	await step("Building frontend", async () => {
		await run(["bun", "run", "--filter", "@vibe-tavern/web", "build"]);
	});

	await step("Copying frontend payload", async () => {
		if (!(await Bun.file(join(WEB_SOURCE, "index.html")).exists())) {
			throw new Error(`Frontend not found at ${WEB_SOURCE}. Build may have failed.`);
		}
		await cp(WEB_SOURCE, join(PAYLOAD, "web"), { recursive: true });
		console.log(`   → ${join(PAYLOAD, "web")}`);
	});

	await step("Copying tokenizer payload", async () => {
		await copyRequiredDir(
			join(ROOT, "services", "api", "assets", "tokenizers"),
			join(PAYLOAD, "tokenizers"),
			"Tokenizer",
		);
	});

	await step("Copying AI assistant prompt payload", async () => {
		const promptTargets = await copyPromptAssets(
			join(ROOT, "services", "api", "assets"),
			join(PAYLOAD, "prompts"),
		);
		console.log(`   → ${promptTargets.length} prompt file(s)/tree(s)`);
	});

	await step("Copying DB migration payload", async () => {
		await copyRequiredDir(
			join(ROOT, "packages", "db", "drizzle"),
			join(PAYLOAD, "drizzle"),
			"DB migrations",
		);
	});

	await step("Compiling native Android ARM64 server", async () => {
		const entrypoint = join(ROOT, "services", "api", "src", "server", "standalone-server.ts");
		const compileCwd = join(tmpdir(), "vibe-tavern-android-native-build");

		if (!(await Bun.file(entrypoint).exists())) {
			throw new Error(`Entrypoint not found: ${entrypoint}`);
		}

		// Bun cross-compilation on Windows can fail while extracting the target
		// runtime when its cwd is on a non-system drive. Keep source and output
		// absolute, but invoke Bun from the operating system temp directory.
		await rm(compileCwd, { recursive: true, force: true });
		await mkdir(compileCwd, { recursive: true });
		await run([
			"bun",
			"build",
			"--compile",
			"--target=bun-linux-arm64-android",
			"--minify",
			"--define",
			`VIBE_TAVERN_VERSION=\"${VERSION}\"`,
			"--define",
			"VIBE_TAVERN_INSTALL_KIND=\"android\"",
			entrypoint,
			"--outfile",
			NATIVE_OUT,
		], compileCwd);

		if (!(await Bun.file(NATIVE_OUT).exists())) {
			throw new Error(`Expected native output not found: ${NATIVE_OUT}`);
		}
		console.log(`   → ${NATIVE_OUT}`);
	});

	console.log("\n✅ Native Android build complete!");
	console.log(`   Payload: ${PAYLOAD}`);
	console.log(`   Native:  ${NATIVE_OUT}`);
}

main();
