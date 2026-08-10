export interface TestSuiteResult {
	readonly name: string;
	readonly exitCode: number | null;
	readonly durationMs: number;
	readonly stdout: string;
	readonly stderr: string;
}

const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const BUN_FAILURE_PATTERN = /^\(fail\)/;
const BUN_TEST_FILE_PATTERN = /^\S.*\.test\.[cm]?[jt]sx?:$/;
const MAX_FALLBACK_LINES = 120;

function formatDuration(durationMs: number): string {
	return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function lastLines(value: string): string {
	return value.split("\n").slice(-MAX_FALLBACK_LINES).join("\n").trim();
}

function extractBunFailure(stderr: string): string | null {
	const lines = stderr.split("\n");
	const failureIndexes = lines.flatMap((line, index) => BUN_FAILURE_PATTERN.test(line) ? [index] : []);
	if (failureIndexes.length === 0) return null;

	const sections: string[] = [];
	let previousFailureIndex = -1;
	for (const failureIndex of failureIndexes) {
		let start = previousFailureIndex + 1;
		if (previousFailureIndex === -1) {
			for (let index = failureIndex; index >= 0; index--) {
				if (BUN_TEST_FILE_PATTERN.test(lines[index] ?? "")) {
					start = index;
					break;
				}
			}
		}
		sections.push(lines.slice(start, failureIndex + 1).join("\n").trim());
		previousFailureIndex = failureIndex;
	}

	const summaryStart = lines.findIndex((line, index) => (
		index > previousFailureIndex && /^\s*\d+\s+(?:pass|fail|skip)/.test(line)
	));
	if (summaryStart !== -1) sections.push(lines.slice(summaryStart).join("\n").trim());
	return sections.filter((section) => section !== "").join("\n\n");
}

function formatFailure(result: TestSuiteResult): string {
	const stdout = stripAnsi(result.stdout);
	const stderr = stripAnsi(result.stderr);
	const actionable = extractBunFailure(stderr);
	if (actionable !== null) return `--- ${result.name} ---\n\n${actionable}`;

	const output = [
		stdout.trim() === "" ? "" : `[stdout]\n${lastLines(stdout)}`,
		stderr.trim() === "" ? "" : `[stderr]\n${lastLines(stderr)}`,
	].filter((part) => part !== "");
	return [`--- ${result.name} ---`, ...output].join("\n\n");
}

/**
 * `wallClockMs` is the elapsed time of the whole run. Suites run several at a
 * time, so the sum of their durations overstates it — pass the measured elapsed
 * time and the summary reports both. Omitted, the sum is the only number there is.
 */
export function formatTestReport(results: readonly TestSuiteResult[], wallClockMs?: number): string {
	const failures = results.filter((result) => result.exitCode !== 0);
	const passed = results.length - failures.length;
	const nameWidth = Math.max(0, ...results.map((result) => result.name.length));
	const suiteDurationMs = results.reduce((total, result) => total + result.durationMs, 0);
	const time = wallClockMs === undefined
		? formatDuration(suiteDurationMs)
		: `${formatDuration(wallClockMs)} (${formatDuration(suiteDurationMs)} of suite time)`;
	const lines: string[] = [];

	if (failures.length > 0) {
		lines.push("Failure details", "", ...failures.map(formatFailure), "");
	}

	lines.push("Test summary", "");
	for (const result of results) {
		const status = result.exitCode === 0 ? "PASS" : "FAIL";
		lines.push(`${status}  ${result.name.padEnd(nameWidth)}  ${formatDuration(result.durationMs)}`);
	}
	lines.push("", `Suites: ${passed} passed, ${failures.length} failed | Time: ${time}`);
	return lines.join("\n");
}
