/**
 * Full installer build pipeline for Vibe Tavern.
 *
 * Orchestrates:
 *   1. Run build-standalone.ts (produces out/standalone/vibe-tavern.exe + out/standalone/web/)
 *   2. Invoke ISCC (Inno Setup Compiler) to produce the installer
 *
 * Usage:
 *   bun scripts/build-installer.ts
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

	const packageJson = await Bun.file(join(ROOT, "package.json")).json();
	const version = packageJson.version as string;
	console.log(`   Version: ${version}`);

	const isccPath = await findIscc();
	console.log(`   ISCC: ${isccPath}`);

	const isccProc = Bun.spawn(
		[isccPath, `/DProjectRoot=${ROOT}`, `/DAppVersion=${version}`, ISS_FILE],
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

main();
