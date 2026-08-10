/**
 * Full installer build pipeline for Vibe Tavern.
 *
 * Orchestrates:
 *   1. Run build-standalone.ts (produces out/standalone/vibe-tavern.exe + out/standalone/web/)
 *   2. Invoke ISCC (Inno Setup Compiler) to produce the installer
 *
 * Usage:
 *   bun scripts/build-installer.ts [--fast-compression]
 *
 * Prerequisites:
 *   - Bun runtime
 *   - Inno Setup 6+ installed and ISCC on PATH
 *     (or set ISCC_PATH environment variable)
 *
 * Output:
 *   out/installer/vibe-tavern-setup.exe
 */

import { join, resolve } from "node:path";
import { VERSION } from "./_version.js";

export const FAST_COMPRESSION_FLAG = "--fast-compression";

const ROOT = resolve(import.meta.dir, "..");
const STANDALONE_OUT = join(ROOT, "out", "standalone");
const INSTALLER_DIR = join(ROOT, "installer");
const ISS_FILE = join(INSTALLER_DIR, "vibe-tavern.iss");
const OUTPUT_DIR = join(ROOT, "out", "installer");
const EXPECTED_SETUP = join(OUTPUT_DIR, "vibe-tavern-setup.exe");

async function findIscc(): Promise<string> {
	const envPath = process.env.ISCC_PATH;
	if (envPath && await Bun.file(envPath).exists()) {
		return envPath;
	}

	if (process.platform === "win32") {
		const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const candidates = [
			join(programFilesX86, "Inno Setup 6", "ISCC.exe"),
			join(programFilesX86, "Inno Setup 7", "ISCC.exe"),
		];
		if (localAppData) {
			candidates.unshift(
				join(localAppData, "Programs", "Inno Setup 6", "ISCC.exe"),
				join(localAppData, "Programs", "Inno Setup 7", "ISCC.exe"),
			);
		}
		for (const candidate of candidates) {
			if (await Bun.file(candidate).exists()) return candidate;
		}
	}

	return "ISCC";
}

/**
 * ISCC command line. `fastCompression` is for callers that only need to know the
 * installer compiles — CI throws the artifact away, and lzma2/ultra64 over a
 * solid block costs ~95s of a ~108s step there. The compile still verifies what
 * it always did: the script parses, every [Files] entry resolves, [Code]
 * compiles. What it stops exercising is the LZMA pass itself, which release.yml
 * runs on every tag. Release builds must never pass it.
 *
 * `none` rather than a level like `lzma2/fast` on purpose: ISPP evaluates `/D`
 * values as expressions, so a `/` in the value is a division operator waiting to
 * happen. Every value here must stay a bare identifier.
 */
export function isccArgs(
	isccPath: string,
	root: string,
	version: string,
	issFile: string,
	fastCompression: boolean,
): readonly string[] {
	return [
		isccPath,
		`/DProjectRoot=${root}`,
		`/DAppVersion=${version}`,
		...(fastCompression ? ["/DCompression=none", "/DSolidCompression=no"] : []),
		issFile,
	];
}

async function main() {
	console.log("📦 Vibe Tavern — Installer Build\n");

	if (!(await Bun.file(ISS_FILE).exists())) {
		console.error(`❌ Inno Setup script not found: ${ISS_FILE}`);
		process.exit(1);
	}

	console.log("🔨 Step 1: Building standalone distribution...\n");

	const buildProc = Bun.spawn(
		["bun", "scripts/build-standalone.ts"],
		{ cwd: ROOT, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
	);

	const buildExit = await buildProc.exited;
	if (buildExit !== 0) {
		console.error("❌ Standalone build failed");
		process.exit(1);
	}

	if (!(await Bun.file(join(STANDALONE_OUT, "vibe-tavern.exe")).exists())) {
		console.error("❌ out/standalone/vibe-tavern.exe not found after build");
		process.exit(1);
	}

	if (!(await Bun.file(join(STANDALONE_OUT, "web", "index.html")).exists())) {
		console.error("❌ out/standalone/web/index.html not found after build");
		process.exit(1);
	}

	console.log("\n🔨 Step 2: Building installer with Inno Setup...\n");

	console.log(`   Version: ${VERSION}`);

	const fastCompression = process.argv.slice(2).includes(FAST_COMPRESSION_FLAG);
	if (fastCompression) {
		console.log("   Compression: lzma2/fast, non-solid (verification build — do not ship)");
	}

	const isccPath = await findIscc();
	console.log(`   ISCC: ${isccPath}`);

	const isccProc = Bun.spawn(
		[...isccArgs(isccPath, ROOT, VERSION, ISS_FILE, fastCompression)],
		{ cwd: ROOT, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
	);

	const isccExit = await isccProc.exited;
	if (isccExit !== 0) {
		console.error("❌ Inno Setup compilation failed");
		console.error("   Make sure Inno Setup 6+ is installed.");
		console.error("   Download: https://jrsoftware.org/isinfo.php");
		console.error("   Or set ISCC_PATH environment variable.");
		process.exit(1);
	}

	if (!(await Bun.file(EXPECTED_SETUP).exists())) {
		console.error(`❌ Installer not found at expected location: ${EXPECTED_SETUP}`);
		process.exit(1);
	}

	console.log(`\n✅ Installer built successfully!`);
	console.log(`   ${EXPECTED_SETUP}`);
}

// Guarded so `isccArgs` can be imported without running an installer build.
if (import.meta.main) {
	await main();
}
