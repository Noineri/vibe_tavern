import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createTestSuites,
	runTestCli,
	runTestSuites,
	suiteConcurrency,
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

	test("gives every bun:test suite the same timeout headroom on every platform", () => {
		// A loaded runner blows through bun's default 5s per-test timeout on any
		// suite that touches SQLite and the filesystem — `db` was the first to hit
		// it, `api` (avatar adapter) the second. Windows is the worst case, but the
		// pool in runTestSuites puts several suites on the box at once, so the same
		// contention reaches Linux; the headroom is unconditional.
		const bunTestSuites = createTestSuites().filter((suite) => suite.command[1] === "test");
		expect(bunTestSuites.map((suite) => suite.name)).toEqual([
			"api",
			"db",
			"scripts",
			"prompt-pipeline",
			"api-contracts",
			"import-export",
			"domain",
		]);
		for (const suite of bunTestSuites) {
			expect(suite.command).toContain("--timeout");
			expect(suite.command).toContain("15000");
		}
	});

	test("declares the long suites first so the pool never trails a late starter", () => {
		// `web` fans out to its own 8-way subprocess pool and is the longest suite
		// on Linux; declared last it would start last and run alone at the tail.
		expect(createTestSuites().map((suite) => suite.name).slice(0, 3)).toEqual(["web", "api", "db"]);
	});

	test("keeps bun test flags ahead of the positional filter", () => {
		const scripts = createTestSuites().find((suite) => suite.name === "scripts");
		expect(scripts?.command.at(-1)).toBe("scripts");
	});

	test("drops the platform-agnostic web suite from a bare run on Windows only", () => {
		// 160 of web's 162 files are React components and stores; two touch the
		// filesystem. On a runner where every syscall costs 2–4× Linux that is ~83s
		// for no platform coverage. Naming the suite still runs it there.
		const suites = createTestSuites();
		expect(suites.find((suite) => suite.name === "web")?.skipOnWindows).toBe(true);
		for (const suite of suites) {
			if (suite.name !== "web") expect(suite.skipOnWindows).toBeUndefined();
		}
	});

	test("skips a windows-only suite on win32 but still runs it when named", async () => {
		// Given
		const probe = { name: "probe", cwd, command: [process.execPath, "-e", "process.exit(0)"], skipOnWindows: true } as const;
		const keep = { name: "keep", cwd, command: [process.execPath, "-e", "process.exit(0)"] } as const;
		const suites = [probe, keep] as const satisfies readonly TestSuite[];

		// When
		const bare: string[] = [];
		const named: string[] = [];
		const linux: string[] = [];
		await runTestCli(suites, [], (message) => bare.push(message), "win32");
		await runTestCli(suites, ["probe"], (message) => named.push(message), "win32");
		await runTestCli(suites, [], (message) => linux.push(message), "linux");

		// Then
		expect(bare.join("\n")).toContain("Skipping on win32: probe");
		expect(bare.join("\n")).toContain("Running 1 isolated test suites");
		expect(named.join("\n")).toContain("[1/1] probe");
		expect(named.join("\n")).not.toContain("Skipping on win32");
		expect(linux.join("\n")).toContain("Running 2 isolated test suites");
		expect(linux.join("\n")).not.toContain("Skipping");
	});

	test("runs suites concurrently instead of one at a time", async () => {
		// Given: two suites that each sleep, so a sequential runner takes twice as
		// long as a parallel one. Pinned on overlap, not wall clock — a loaded CI
		// box can stretch either number, but only a sequential runner serialises them.
		const sleeper = (name: string) => ({
			name,
			cwd,
			command: [
				process.execPath,
				"-e",
				`console.log(Date.now()); await Bun.sleep(400); console.log(Date.now())`,
			],
		});
		const suites = [sleeper("first"), sleeper("second")] as const satisfies readonly TestSuite[];

		// When
		const results = await runTestSuites(suites, undefined, { concurrency: 2 });

		// Then: the two windows overlap.
		const spans = results.map((result) => result.stdout.trim().split("\n").map(Number));
		const [firstStart, firstEnd] = [spans[0]?.[0] ?? 0, spans[0]?.[1] ?? 0];
		const [secondStart, secondEnd] = [spans[1]?.[0] ?? 0, spans[1]?.[1] ?? 0];
		expect(firstStart).toBeLessThan(secondEnd);
		expect(secondStart).toBeLessThan(firstEnd);
	});

	test("keeps results in declaration order when suites finish out of order", async () => {
		// Given: the first suite outlives the second, so a pool completes them backwards.
		const suites = [
			{ name: "slow", cwd, command: [process.execPath, "-e", 'await Bun.sleep(300); console.log("slow")'] },
			{ name: "fast", cwd, command: [process.execPath, "-e", 'console.log("fast")'] },
		] as const satisfies readonly TestSuite[];

		// When
		const results = await runTestSuites(suites, undefined, { concurrency: 2 });

		// Then
		expect(results.map((result) => result.name)).toEqual(["slow", "fast"]);
		expect(results[0]?.stdout).toContain("slow");
		expect(results[1]?.stdout).toContain("fast");
	});

	test("caps the pool at half the cores, between 2 and 4", () => {
		expect(suiteConcurrency(1)).toBe(2);
		expect(suiteConcurrency(4)).toBe(2);
		expect(suiteConcurrency(6)).toBe(3);
		expect(suiteConcurrency(16)).toBe(4);
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
		expect(output.join("\n")).toContain("Running 2 isolated test suites");
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
