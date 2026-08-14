export interface TestSuiteResult {
	readonly name: string;
	readonly exitCode: number | null;
	readonly durationMs: number;
	readonly stdout: string;
	readonly stderr: string;
}

const BUN_FAILURE_PATTERN = /^\(fail\)/;
const BUN_TEST_FILE_PATTERN = /^\S.*\.test\.[cm]?[jt]sx?:$/;
/**
 * Header of a thrown value Bun printed: `error: boom` for an `Error` or a bare
 * throw, `TypeError: …` / `WeirdError: …` for anything carrying its own `name`.
 * Only trusted when the stack frame Bun prints underneath follows it — on its
 * own the shape is common enough in ordinary log noise (`[update] … failed:
 * disk I/O error`) to flag half a green run.
 */
const BUN_ERROR_HEADER_PATTERN = /^(?:error|[A-Za-z_$][\w$]*Error):\s/;
const BUN_STACK_FRAME_PATTERN = /^\s+at\s/;
/** Bun's own banner for a throw that landed while no test was running. */
const BUN_UNATTRIBUTED_BANNER = "# Unhandled error between tests";
/** A summary tally line: ` 1861 pass`, ` 0 fail`, ` 8 errors`. */
const BUN_SUMMARY_PATTERN = /^\s*\d+\s+(?:pass|fail|skip|error)/;
const MAX_FALLBACK_LINES = 120;
const MAX_FALLBACK_CHARACTERS = 2_000;
const MAX_SUMMARY_LINES = 20;
const MAX_DIAGNOSTIC_SECTIONS = 8;
const MAX_DIAGNOSTIC_CHARACTERS = 2_000;
const MAX_SUMMARY_CHARACTERS = 4_000;

function formatDuration(durationMs: number): string {
	return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function stripTerminalControls(value: string): string {
	const output: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		const next = value[index + 1] ?? "";
		const escapeString = code === 0x1B && (next === "]" || next === "P" || next === "X" || next === "^" || next === "_");
		const c1String = code === 0x90 || code === 0x98 || code === 0x9D || code === 0x9E || code === 0x9F;
		if (escapeString || c1String) {
			const osc = next === "]" || code === 0x9D;
			for (index += escapeString ? 2 : 1; index < value.length; index++) {
					const sequenceCode = value.charCodeAt(index);
					if (sequenceCode === 0x9C || (osc && sequenceCode === 0x07)) break;
					if (sequenceCode === 0x1B && value[index + 1] === "\\") {
						index++;
						break;
					}
				}
				continue;
		}
		if (code === 0x1B) {
			if (next === "[") {
				for (index += 2; index < value.length; index++) {
					const sequenceCode = value.charCodeAt(index);
					if (sequenceCode >= 0x40 && sequenceCode <= 0x7E) break;
				}
				continue;
			}
			if (next !== "") index++;
			continue;
		}
		if (code <= 0x08 || (code >= 0x0B && code <= 0x1F) || (code >= 0x7F && code <= 0x9F)) continue;
		output.push(value[index] ?? "");
	}
	return output.join("");
}

function lastLines(value: string): string {
	return limitCharacters(value.split("\n").slice(-MAX_FALLBACK_LINES).join("\n").trim(), MAX_FALLBACK_CHARACTERS, "output");
}

function limitLines(lines: readonly string[], maximum: number, label: string): string {
	if (lines.length <= maximum) return lines.join("\n").trim();
	const leadingLines = Math.ceil(maximum / 2);
	const trailingLines = maximum - leadingLines;
	return [
		...lines.slice(0, leadingLines),
		`... ${label} truncated after ${maximum} lines`,
		...lines.slice(-trailingLines),
	].join("\n").trim();
}

function limitCharacters(value: string, maximum: number, label: string): string {
	if (value.length <= maximum) return value;
	const leadingCharacters = Math.ceil(maximum / 2);
	const trailingCharacters = maximum - leadingCharacters;
	return [
		value.slice(0, leadingCharacters),
		`... ${label} truncated after ${maximum} characters`,
		value.slice(-trailingCharacters),
	].join("\n");
}

/**
 * Index of the first line of the trailing tally block, or -1. Found from the
 * end: a tally line's shape (`<n> <word>`) is loose enough that scanning
 * forwards can hit ordinary log output and cut the report off at it.
 */
function findSummaryStart(lines: readonly string[]): number {
	let start = -1;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (!BUN_SUMMARY_PATTERN.test(lines[index] ?? "")) {
			if (start !== -1) break;
			continue;
		}
		start = index;
	}
	return start;
}

/** Split Bun's output at its `path/to/file.test.ts:` headers, preamble first. */
function splitTestFileSections(lines: readonly string[]): readonly (readonly string[])[] {
	const sections: string[][] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (BUN_TEST_FILE_PATTERN.test(line) && current.length > 0) {
			sections.push(current);
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) sections.push(current);
	return sections;
}

/**
 * A section is worth reporting when it holds a failed test or a thrown value
 * Bun could not attribute to one. The second case is why this is section-based
 * rather than anchored on `(fail)`: a suite can exit non-zero on `0 fail` alone
 * (`8 errors` — a timer or floating promise that threw between tests), and
 * those blocks print where they happen, far from the tail.
 */
function isDiagnosticSection(lines: readonly string[]): boolean {
	return lines.some((line, index) => (
		BUN_FAILURE_PATTERN.test(line)
		|| line.startsWith(BUN_UNATTRIBUTED_BANNER)
		|| (BUN_ERROR_HEADER_PATTERN.test(line) && BUN_STACK_FRAME_PATTERN.test(lines[index + 1] ?? ""))
	));
}

function formatBunSummary(lines: readonly string[], summaryStart: number): string {
	return limitCharacters(
		limitLines(lines.slice(summaryStart), MAX_SUMMARY_LINES, "summary output"),
		MAX_SUMMARY_CHARACTERS,
		"summary output",
	);
}

function extractBunSummary(output: string): string | null {
	const lines = output.split("\n");
	const summaryStart = findSummaryStart(lines);
	return summaryStart === -1 ? null : formatBunSummary(lines, summaryStart);
}

function extractBunFailure(stderr: string): string | null {
	const lines = stderr.split("\n");
	const summaryStart = findSummaryStart(lines);
	const body = summaryStart === -1 ? lines : lines.slice(0, summaryStart);

	const diagnosticSections = splitTestFileSections(body)
		.filter(isDiagnosticSection)
		.filter((section) => section.some((line) => line.trim() !== ""));
	if (diagnosticSections.length === 0) return null;

	const sections = diagnosticSections.slice(0, MAX_DIAGNOSTIC_SECTIONS).map((section) => limitCharacters(
		limitLines(section, MAX_FALLBACK_LINES, "diagnostic output"),
		MAX_DIAGNOSTIC_CHARACTERS,
		"diagnostic output",
	));
	if (diagnosticSections.length > MAX_DIAGNOSTIC_SECTIONS) {
		sections.push(`... ${diagnosticSections.length - MAX_DIAGNOSTIC_SECTIONS} additional diagnostic sections omitted`);
	}
	if (summaryStart !== -1) sections.push(formatBunSummary(lines, summaryStart));
	return sections.filter((section) => section !== "").join("\n\n");
}

function formatFailure(result: TestSuiteResult): string {
	const stdout = stripTerminalControls(result.stdout);
	const stderr = stripTerminalControls(result.stderr);
	const stdoutActionable = extractBunFailure(stdout);
	const stderrActionable = extractBunFailure(stderr);
	const actionable = [
		stdoutActionable,
		stderrActionable,
		stdoutActionable === null ? extractBunSummary(stdout) : null,
		stderrActionable === null ? extractBunSummary(stderr) : null,
	]
		.filter((output): output is string => output !== null)
		.join("\n\n");
	if (actionable !== "") return `--- ${result.name} ---\n\n${actionable}`;

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
