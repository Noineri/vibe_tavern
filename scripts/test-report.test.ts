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

	test("reports elapsed time alongside suite time when suites overlapped", () => {
		// Given: suites summing to 60ms that a pool finished in 40ms of wall clock.
		// Reporting only the sum would claim a parallel run took longer than it did.
		const expectedFinalLine = "Suites: 2 passed, 1 failed | Time: 40ms (60ms of suite time)";

		// When
		const report = formatTestReport(results, 40);

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
});
