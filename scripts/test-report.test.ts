import { describe, expect, test } from "bun:test";
import { formatTestReport, type TestSuiteResult } from "./test-report.js";

describe("final test report", () => {
	const results = [
		{
			name: "passing-before",
			exitCode: 0,
			durationMs: 10,
			stdout: "passing noise\n",
			stderr: "",
		},
		{
			name: "failing",
			exitCode: 1,
			durationMs: 20,
			stdout: "failure stdout\n",
			stderr: "failure stderr\n",
		},
		{
			name: "passing-after",
			exitCode: 0,
			durationMs: 30,
			stdout: "later passing noise\n",
			stderr: "",
		},
	] as const satisfies readonly TestSuiteResult[];

	test("shows failed output without successful runner noise", () => {
		// Given
		const successfulNoise = ["passing noise", "later passing noise"];

		// When
		const report = formatTestReport(results);

		// Then
		expect(report).toContain("failure stdout");
		expect(report).toContain("failure stderr");
		for (const noise of successfulNoise) {
			expect(report).not.toContain(noise);
		}
	});

	test("places the aggregate result at the bottom", () => {
		// Given
		const expectedFinalLine = "Suites: 2 passed, 1 failed | Time: 60ms";

		// When
		const report = formatTestReport(results);

		// Then
		expect(report.trimEnd().endsWith(expectedFinalLine)).toBe(true);
	});

	test("extracts Bun assertion output without unrelated test warnings", () => {
		// Given
		const noisyFailure = [{
			name: "bun-suite",
			exitCode: 1,
			durationMs: 20,
			stdout: "bun test v1\n",
			stderr: [
				"test/noisy.test.ts:",
				"repeated setup warning",
				"repeated setup warning",
				"",
				"test/example.test.ts:",
				"10 | expect(actual).toBe(expected);",
				"error: expect(received).toBe(expected)",
				"Expected: 1",
				"Received: 2",
				"(fail) example > reports the assertion",
				"",
				" 1 pass",
				" 1 fail",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(noisyFailure);

		// Then
		expect(report).toContain("Expected: 1");
		expect(report).toContain("Received: 2");
		expect(report).not.toContain("repeated setup warning");
	});

	test("keeps Vitest failure names while bounding detailed stacks", () => {
		// Given
		const noisyFailure = [{
			name: "web",
			exitCode: 1,
			durationMs: 20,
			stdout: [
				"RUN v4",
				" ❯ src/example.test.ts (4 tests | 4 failed)",
				"     × first failure",
				"     × second failure",
				"     × third failure",
				"     × fourth failure",
				" Test Files 1 failed",
				" Tests 4 failed",
			].join("\n"),
			stderr: [
				"ExperimentalWarning: unrelated runner noise",
				"⎯ Failed Tests 4 ⎯",
				" FAIL src/example.test.ts > first failure",
				"AssertionError: first detail",
				" FAIL src/example.test.ts > second failure",
				"AssertionError: second detail",
				" FAIL src/example.test.ts > third failure",
				"AssertionError: third detail",
				" FAIL src/example.test.ts > fourth failure",
				"AssertionError: fourth detail",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(noisyFailure);

		// Then
		expect(report).toContain("× fourth failure");
		expect(report).toContain("AssertionError: third detail");
		expect(report).not.toContain("AssertionError: fourth detail");
		expect(report).not.toContain("ExperimentalWarning");
	});
});
