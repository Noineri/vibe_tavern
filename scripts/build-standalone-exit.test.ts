import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST_PATH, STUB_CONTENT } from "./generate-embedded-web-manifest.js";

const repoRoot = resolve(import.meta.dir, "..");
const temporaryRoots: string[] = [];

function replaceRequired(source: string, needle: string, replacement: string): string {
	if (!source.includes(needle)) {
		throw new Error(`Standalone build test harness could not find ${needle}.`);
	}
	return source.replace(needle, replacement);
}

async function createFailureHarness(): Promise<{ readonly markerPath: string; readonly scriptPath: string }> {
	const harnessRoot = await mkdtemp(join(tmpdir(), "vibe-tavern-standalone-exit-"));
	temporaryRoots.push(harnessRoot);
	const markerPath = join(harnessRoot, "generated-marker");
	const scriptPath = join(harnessRoot, "scripts", "build-standalone.ts");
	const generatorPath = join(harnessRoot, "scripts", "generate-embedded-web-manifest.ts");
	await mkdir(dirname(generatorPath), { recursive: true });
	await mkdir(join(harnessRoot, "out", "apps", "web"), { recursive: true });
	await Bun.write(join(harnessRoot, "out", "apps", "web", "fixture.txt"), "exit recovery fixture");
	const generatorSource = await Bun.file(join(repoRoot, "scripts", "generate-embedded-web-manifest.ts")).text();
	await Bun.write(
		generatorPath,
		replaceRequired(
			generatorSource,
			"export const MANIFEST_PATH = join(ROOT, \"services\", \"api\", \"src\", \"server\", \"embedded-web-manifest.ts\");",
			`export const MANIFEST_PATH = ${JSON.stringify(MANIFEST_PATH)};`,
		),
	);
	const source = await Bun.file(join(repoRoot, "scripts", "build-standalone.ts")).text();
	const rewrittenImports = [
		["from \"./_fs.js\";", `from ${JSON.stringify(pathToFileURL(join(repoRoot, "scripts", "_fs.ts")).href)};`],
		["from \"./_version.js\";", `from ${JSON.stringify(pathToFileURL(join(repoRoot, "scripts", "_version.ts")).href)};`],
	] as const;
	const imported = rewrittenImports.reduce(
		(current, [needle, replacement]) => replaceRequired(current, needle, replacement),
		source,
	);
	const setupStart = imported.indexOf("\t// ── Step 1:");
	const manifestStart = imported.indexOf("\t// ── Step 4:");
	const compileStart = imported.indexOf("\t// ── Step 5:");
	if (setupStart === -1 || manifestStart === -1 || compileStart === -1) {
		throw new Error("Standalone build test harness could not locate the build phases.");
	}
	const withoutSetup = `${imported.slice(0, setupStart)}${imported.slice(manifestStart)}`;
	const forcedExitAt = withoutSetup.indexOf("\t// ── Step 5:");
	if (forcedExitAt === -1) {
		throw new Error("Standalone build test harness could not locate the compile phase.");
	}
	const forcedFailure = `\tawait Bun.write(${JSON.stringify(markerPath)}, "generated");\n\tprocess.exit(1);\n\n`;
	await Bun.write(
		scriptPath,
		`${withoutSetup.slice(0, forcedExitAt)}${forcedFailure}${withoutSetup.slice(forcedExitAt)}`,
	);
	return { markerPath, scriptPath };
}

afterEach(async () => {
	await Bun.write(MANIFEST_PATH, STUB_CONTENT);
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("build-standalone exit recovery", () => {
	test("restores the embedded manifest when a post-generation step exits", async () => {
		const { markerPath, scriptPath } = await createFailureHarness();

		const build = Bun.spawn(["bun", scriptPath], {
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await build.exited).toBe(1);
		expect(await Bun.file(markerPath).text()).toBe("generated");
		expect(await Bun.file(MANIFEST_PATH).text()).toBe(STUB_CONTENT);

		const status = Bun.spawn(["git", "status", "--short", "--", relative(repoRoot, MANIFEST_PATH)], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, GIT_MASTER: "1" },
		});
		expect(await status.exited).toBe(0);
		expect(await new Response(status.stdout).text()).toBe("");
	});
});
