import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWebTestFileCommand, discoverWebTestFiles, runWebTestCli } from "./test-web.js";

interface CliResult {
readonly exitCode: number;
	readonly output: string;
	readonly errors: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "vibe-tavern-test-web-"));
	temporaryDirectories.push(root);
	return root;
}

async function writeFixture(root: string, relativePath: string, body = "expect(true).toBe(true);"): Promise<void> {
	const path = join(root, relativePath);
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(
		path,
		`import { expect, test } from "bun:test";\ntest("fixture", async () => {\n${body}\n});\n`,
	);
}

async function runCli(root: string, args: readonly string[]): Promise<CliResult> {
	const output: string[] = [];
	const errors: string[] = [];
	const exitCode = await runWebTestCli(
		args,
		root,
		(message) => output.push(message),
		(message) => errors.push(message),
	);
	return { exitCode, output: output.join("\n"), errors: errors.join("\n") };
}

test("gives each web test file the same timeout headroom on every platform", () => {
	// Same hazard as the packages/services suites: a loaded runner blows through
	// bun's default 5s per-test timeout. Windows is the worst case, but suites now
	// run several at a time, so contention reaches Linux too. See scripts/test.ts.
	const command = createWebTestFileCommand("a.test.tsx", "report.xml");
	expect(command).toContain("--timeout");
	expect(command).toContain("15000");
});

test("discovers normalized source tests in lexical order and appends the harness canary", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/src/zeta.test.ts");
	await writeFixture(root, "apps/web/src/nested/alpha.test.tsx");
	await writeFixture(root, "apps/web/test/bun-plugin-data-component.test.ts");
	await writeFixture(root, "apps/web/test/harness.smoke.test.tsx");
	await Bun.write(join(root, "apps/web/src/nested/not-a-test.ts"), "export {};\n");
	await Bun.write(join(root, "apps/web/test/dom-env.ts"), "export {};\n");

	// When
	const files = await discoverWebTestFiles(root);

	// Then
	expect(files).toEqual([
		"apps/web/src/nested/alpha.test.tsx",
		"apps/web/src/zeta.test.ts",
		"apps/web/test/bun-plugin-data-component.test.ts",
		"apps/web/test/harness.smoke.test.tsx",
	]);
});

test("runs only selected positional files", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/test/selected.test.ts", 'console.log("SELECTED-MARKER");');
	await writeFixture(root, "apps/web/test/ignored.test.ts", 'console.log("IGNORED-MARKER");');

	// When
	const result = await runCli(root, ["apps/web/test/selected.test.ts"]);

	// Then
	expect(result.exitCode).toBe(0);
	expect(result.output).toContain("SELECTED-MARKER");
	expect(result.output).not.toContain("IGNORED-MARKER");
});

test("reverses the normalized selected-file order", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/test/alpha.test.ts", 'console.log("ALPHA-MARKER");');
	await writeFixture(root, "apps/web/test/zeta.test.ts", 'console.log("ZETA-MARKER");');

	// When
	const result = await runCli(root, [
		"apps/web/test/alpha.test.ts",
		"apps/web/test/zeta.test.ts",
		"--reverse",
	]);

	// Then
	expect(result.exitCode).toBe(0);
	expect(result.output.indexOf("ZETA-MARKER")).toBeLessThan(result.output.indexOf("ALPHA-MARKER"));
});

test("propagates a failing fixture as a nonzero result", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/test/failing.test.ts", "expect(1).toBe(2);");

	// When
	const result = await runCli(root, ["apps/web/test/failing.test.ts"]);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("FAIL apps/web/test/failing.test.ts");
	expect(result.errors).toContain("Failing web test files (1)");
	expect(result.errors).toContain("apps/web/test/failing.test.ts (exit 1)");
	expect(result.errors).toContain("(fail)");
});

test("aggregates subprocess output by sorted file order rather than completion order", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/test/alpha.test.ts", 'await Bun.sleep(100); console.log("SLOW-ALPHA");');
	await writeFixture(root, "apps/web/test/zeta.test.ts", 'console.log("FAST-ZETA");');

	// When
	const result = await runCli(root, ["apps/web/test/zeta.test.ts", "apps/web/test/alpha.test.ts"]);

	// Then
	expect(result.exitCode).toBe(0);
	expect(result.output.indexOf("SLOW-ALPHA")).toBeLessThan(result.output.indexOf("FAST-ZETA"));
});

test("rejects a default suite with zero discovered source tests", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/test/harness.smoke.test.tsx");

	// When
	const result = await runCli(root, []);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("No web source test files discovered");
});

test("rejects a selected file that declares zero tests", async () => {
	// Given
	const root = await makeRoot();
	const path = join(root, "apps/web/test/empty.test.ts");
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, "export {};\n");

	// When
	const result = await runCli(root, ["apps/web/test/empty.test.ts"]);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("zero tests");
});

test("rejects duplicate selected paths after normalization", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/test/duplicate.test.ts");

	// When
	const result = await runCli(root, [
		"apps/web/test/duplicate.test.ts",
		"./apps/web/test/duplicate.test.ts",
	]);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("Duplicate web test file: apps/web/test/duplicate.test.ts");
});

test("rejects a missing selected test file before spawning", async () => {
	// Given
	const root = await makeRoot();

	// When
	const result = await runCli(root, ["apps/web/test/missing.test.ts"]);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("Missing web test file: apps/web/test/missing.test.ts");
});

test("runs no more and no fewer than eight fixture processes concurrently", async () => {
	// Given
	const root = await makeRoot();
	const activeDir = join(root, "active");
	const samplesDir = join(root, "samples");
	await mkdir(samplesDir, { recursive: true });
	const files = Array.from({ length: 9 }, (_, index) => `apps/web/test/concurrency-${index}.test.ts`);
	for (const [index, file] of files.entries()) {
		await writeFixture(
			root,
			file,
			`const { mkdir, rm } = await import("node:fs/promises");
const { join } = await import("node:path");
const activeDir = ${JSON.stringify(activeDir)};
await mkdir(activeDir, { recursive: true });
const activeFile = join(activeDir, ${JSON.stringify(String(index))});
await Bun.write(activeFile, "active");
const glob = new Bun.Glob("*");
let highest = 0;
let stableSince = Date.now();
while (Date.now() - stableSince < 100) {
	const count = [...glob.scanSync({ cwd: activeDir })].length;
	if (count > highest) { highest = count; stableSince = Date.now(); }
	await Bun.sleep(5);
}
await Bun.write(${JSON.stringify(join(samplesDir, `${index}.txt`))}, String(highest));
await rm(activeFile);
expect(highest).toBeGreaterThan(0);`,
		);
	}

	// When
	const result = await runCli(root, files);

	// Then
	const samples = await readdir(samplesDir);
	const counts = await Promise.all(samples.map(async (file) => Number(await Bun.file(join(samplesDir, file)).text())));
	expect(result.exitCode).toBe(0);
	expect(samples).toHaveLength(9);
	expect(Math.max(...counts)).toBe(8);
});
