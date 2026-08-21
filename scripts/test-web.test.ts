import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWebTestCommand, discoverWebTestFiles, filesWithTests, runWebTestCli } from "./test-web.js";

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

function command(files: readonly string[], randomize = false, seed: string | undefined = undefined): readonly string[] {
	return createWebTestCommand(files, "report.xml", { randomize, seed });
}

test("gives the suite the same timeout headroom on every platform", () => {
	// Same hazard as the packages/services suites: a loaded runner blows through
	// bun's default 5s per-test timeout. Windows is the worst case, but suites now
	// run several at a time, so contention reaches Linux too. See scripts/test.ts.
	expect(command(["a.test.tsx"])).toContain("--timeout");
	expect(command(["a.test.tsx"])).toContain("45000");
});

test("runs every file under a bounded pool of isolated workers", () => {
	// This assertion is the structural successor to "one subprocess per file":
	// `--parallel=N` implies `--isolate`, which is what buys the property the web
	// suite cannot lose — a fresh global AND module registry per file, so the
	// happy-dom window dom-env.ts registers (and deliberately never unregisters)
	// cannot survive into a DOM-averse file such as avatar.test.ts.
	//
	// Pinned structurally rather than behaviourally on purpose: a leak only
	// surfaces when two specific files share a worker, so a fixture-based probe
	// would pass or fail on scheduling. The real suite was verified instead —
	// all 217 files forced through a single worker (`--parallel=1`): 2304 pass,
	// 0 fail. Dropping `--parallel` here reverts to a shared registry, which is
	// exactly what this catches.
	//
	// The cap also keeps the suite from oversubscribing the box while
	// scripts/test.ts runs the other seven alongside it.
	expect(command(["a.test.tsx", "b.test.tsx"])).toContain("--parallel=8");
});

test("passes randomized ordering and its seed through to bun", () => {
	// The reproducible successor to the old --reverse flag: --reverse could only
	// ever try one alternative order, and per-file isolation made in-process order
	// dependence structurally impossible anyway. A seed makes a shuffled failure
	// replayable.
	expect(command(["a.test.tsx"], false)).not.toContain("--randomize");
	expect(command(["a.test.tsx"], true)).toContain("--randomize");
	const seeded = command(["a.test.tsx"], true, "1234");
	expect(seeded).toContain("--seed");
	expect(seeded[seeded.indexOf("--seed") + 1]).toBe("1234");
});

test("reads covered files out of a JUnit report", () => {
	// The zero-test guard's only input. `bun test` exits 0 for a file that
	// registers nothing, so an empty file is invisible without this.
	const report = `<testsuites>
  <testsuite name="a" file="apps/web/test/a.test.ts" tests="1">
    <testcase name="one" classname="" time="0.1" file="apps/web/test/a.test.ts" assertions="1" />
  </testsuite>
</testsuites>`;
	expect([...filesWithTests(report)]).toEqual(["apps/web/test/a.test.ts"]);
	expect(filesWithTests("<testsuites></testsuites>").size).toBe(0);
});

test("re-slashes the platform separators the JUnit reporter writes", () => {
	// Pins the Windows shape from every platform. The reporter emits the native
	// separator, while every file key in this script is forward-slashed; without
	// the conversion the guard matches nothing on Windows and reports all 226
	// files as declaring zero tests.
	const windowsReport = String.raw`<testsuites>
  <testsuite name="a" file="apps\web\test\a.test.ts" tests="1">
    <testcase name="one" classname="" time="0.1" file="apps\web\test\a.test.ts" assertions="1" />
  </testsuite>
</testsuites>`;
	expect([...filesWithTests(windowsReport)]).toEqual(["apps/web/test/a.test.ts"]);
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

test("propagates a failing fixture as a nonzero result", async () => {
	// Given
	const root = await makeRoot();
	await writeFixture(root, "apps/web/test/failing.test.ts", "expect(1).toBe(2);");
	await writeFixture(root, "apps/web/test/passing.test.ts");

	// When
	const result = await runCli(root, [
		"apps/web/test/failing.test.ts",
		"apps/web/test/passing.test.ts",
	]);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("Web tests: FAIL");
	// bun's own reporter names the failing file and assertion; the orchestrator
	// forwards that verbatim rather than re-deriving a second summary from the
	// JUnit report. Match the basename only — that forwarded text carries the
	// platform separator, so a slashed path would not match on Windows.
	expect(result.output).toContain("(fail)");
	expect(result.output).toContain("failing.test.ts");
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
	// bun test is happy to run a file that registers nothing and exit 0, so a
	// test file gutted down to `export {}` would otherwise pass forever.
	const root = await makeRoot();
	const path = join(root, "apps/web/test/empty.test.ts");
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, "export {};\n");

	// When
	const result = await runCli(root, ["apps/web/test/empty.test.ts"]);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.errors).toContain("Web test files declaring zero tests (1)");
	expect(result.errors).toContain("apps/web/test/empty.test.ts");
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

test("rejects a path outside the repository root", async () => {
	// Given
	const root = await makeRoot();

	// When
	const result = await runCli(root, ["../escape.test.ts"]);

	// Then
	expect(result.exitCode).toBe(1);
	expect(result.output).toContain("Web test file must be inside the repository root");
});

test("rejects unknown flags with a distinct exit code", async () => {
	// Given
	const root = await makeRoot();

	// When
	const result = await runCli(root, ["--nope"]);

	// Then
	expect(result.exitCode).toBe(2);
	expect(result.output).toContain("Invalid web test arguments");
});
