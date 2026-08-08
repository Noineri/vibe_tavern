import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createTestSuites,
	runTestCli,
	runTestSuites,
	type TestSuite,
} from "./test.js";

const cwd = import.meta.dir;
const root = resolve(import.meta.dir, "..");

async function runTestScript(args: readonly string[]) {
	const child = Bun.spawn(["bun", "scripts/test.ts", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("test suite orchestration", () => {
	test("gives child suites one disposable temp root and removes it after the run", async () => {
		const tempBase = await mkdtemp(join(tmpdir(), "vibe-tavern-orchestrator-test-"));
		try {
			const suites = [{
				name: "temp-probe",
				cwd,
				command: [
					process.execPath,
					"-e",
					'import { tmpdir } from "node:os"; await Bun.write(`${tmpdir()}/probe.txt`, "ok"); console.log(tmpdir())',
				],
			}] as const satisfies readonly TestSuite[];

			const [result] = await runTestSuites(suites, undefined, { tempBase });
			const childTemp = result?.stdout.trim();

			expect(result?.exitCode).toBe(0);
			expect(childTemp?.startsWith(tempBase)).toBe(true);
			expect(await Bun.file(join(childTemp ?? "", "probe.txt")).exists()).toBe(false);
		} finally {
			await rm(tempBase, { recursive: true, force: true });
		}
	});

	test("gives every bun:test suite more headroom on Windows only", () => {
		// Windows runners are slow enough that bun's default 5s per-test timeout
		// trips on any suite that touches SQLite and the filesystem — `db` was
		// only the first one to hit it, `api` (avatar adapter) was the second.
		const windows = createTestSuites("win32").filter((suite) => suite.command[1] === "test");
		expect(windows.map((suite) => suite.name)).toEqual([
			"scripts",
			"domain",
			"api-contracts",
			"prompt-pipeline",
			"import-export",
			"db",
			"api",
		]);
		for (const suite of windows) {
			expect(suite.command).toContain("--timeout");
			expect(suite.command).toContain("15000");
		}

		for (const suite of createTestSuites("linux")) {
			expect(suite.command).not.toContain("--timeout");
		}
	});

	test("keeps bun test flags ahead of the positional filter", () => {
		const scripts = createTestSuites("win32").find((suite) => suite.name === "scripts");
		expect(scripts?.command.at(-1)).toBe("scripts");
	});

	test("continues after a failed suite and captures every result", async () => {
		// Given
		const suites = [
			{
				name: "passing-before",
				cwd,
				command: ["bun", "-e", 'console.log("passing noise")'],
			},
			{
				name: "failing",
				cwd,
				command: [
					"bun",
					"-e",
					'console.log("failure stdout"); console.error("failure stderr"); process.exit(3)',
				],
			},
			{
				name: "passing-after",
				cwd,
				command: ["bun", "-e", 'console.log("ran after failure")'],
			},
		] as const satisfies readonly TestSuite[];

		// When
		const results = await runTestSuites(suites);

		// Then
		expect(results.map(({ name, exitCode }) => ({ name, exitCode }))).toEqual([
			{ name: "passing-before", exitCode: 0 },
			{ name: "failing", exitCode: 3 },
			{ name: "passing-after", exitCode: 0 },
		]);
		expect(results[1]?.stdout).toContain("failure stdout");
		expect(results[1]?.stderr).toContain("failure stderr");
		expect(results[2]?.stdout).toContain("ran after failure");
	});

	test("returns a failed exit code after running every selected suite", async () => {
		// Given
		const suites = [
			{
				name: "failing",
				cwd,
				command: [process.execPath, "-e", "process.exit(4)"],
			},
			{
				name: "still-runs",
				cwd,
				command: [process.execPath, "-e", 'console.log("completed")'],
			},
		] as const satisfies readonly TestSuite[];
		const output: string[] = [];

		// When
		const exitCode = await runTestCli(suites, [], (message) => output.push(message));

		// Then
		expect(exitCode).toBe(1);
		expect(output.join("\n")).toContain("Suites: 1 passed, 1 failed");
	});

	test("runs only suites named on the command line", async () => {
		// Given
		const suites = [
			{
				name: "unselected-failure",
				cwd,
				command: [process.execPath, "-e", "process.exit(5)"],
			},
			{
				name: "selected-pass",
				cwd,
				command: [process.execPath, "-e", "process.exit(0)"],
			},
		] as const satisfies readonly TestSuite[];
		const output: string[] = [];

		// When
		const exitCode = await runTestCli(suites, ["selected-pass"], (message) => output.push(message));

		// Then
		expect(exitCode).toBe(0);
		expect(output.join("\n")).toContain("[1/1] selected-pass");
		expect(output.join("\n")).not.toContain("unselected-failure");
	});

	test("selects every suite in declaration order when invoked without positionals", async () => {
		// Given
		const suites = [
			{ name: "first", cwd, command: [process.execPath, "-e", 'console.log("first")'] },
			{ name: "second", cwd, command: [process.execPath, "-e", 'console.log("second")'] },
		] as const satisfies readonly TestSuite[];
		const output: string[] = [];

		// When
		const exitCode = await runTestCli(suites, [], (message) => output.push(message));

		// Then
		expect(exitCode).toBe(0);
		expect(output).toContain("Running 2 isolated test suites...");
		expect(output).toContain("[1/2] first");
		expect(output).toContain("[2/2] second");
	});

	test("treats unrecognised option-looking arguments as invalid suite positionals", async () => {
		// Given
		const suites = [{ name: "scripts", cwd, command: [process.execPath, "-e", "process.exit(0)"] }] as const satisfies readonly TestSuite[];
		const output: string[] = [];

		// When
		const exitCode = await runTestCli(suites, ["--only-failures"], (message) => output.push(message));

		// Then
		expect(exitCode).toBe(1);
		expect(output.join("\n")).toContain("Unknown test suite: --only-failures");
		expect(output.join("\n")).not.toContain("[1/1] scripts");
	});

	test("forwards values after Bun's separator as suite positionals instead of bun test flags", async () => {
		// Given: no valid suite is selected, so this cannot recurse into the scripts suite.

		// When
		const result = await runTestScript(["--", "not-a-suite"]);

		// Then: Bun consumes `--`; the script receives only the following positional.
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Unknown test suite: not-a-suite");
		expect(result.stdout).not.toContain("Unknown test suite: --");
		expect(result.stderr).toBe("");
	});

});
