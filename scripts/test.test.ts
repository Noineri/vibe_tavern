import { describe, expect, test } from "bun:test";
import {
	runTestCli,
	runTestSuites,
	type TestSuite,
} from "./test.js";

const cwd = import.meta.dir;

describe("test suite orchestration", () => {
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

});
