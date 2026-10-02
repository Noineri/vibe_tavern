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
/**
 * Lines a suite's OWN runner prints in its final summary — currently the web
 * per-file runner (`scripts/test-web.ts`): the truncation-proof failing-file
 * list, the zero-test guard, the file-level fallback, the verdict line. These
 * lines are the ONE thing a red run must never lose: bun's `(fail)` details are
 * routinely collapsed by MAX_DIAGNOSTIC_SECTIONS ("... N additional diagnostic
 * sections omitted", PR #39), and without this extraction the runner's list —
 * printed to the suite's stderr — is dropped whenever stdout already yielded
 * actionable bun diagnostics (formatFailure composes stdout-first and never
 * looked at stderr in that case).
 */
const RUNNER_SUMMARY_PATTERNS: readonly RegExp[] = [
	/^Web test files with failures \(\d+\):$/,
	/^FAIL \S+ \(\d+ failed\)$/,
	/^ {2}· /,
	/^Web test files declaring zero tests \(\d+\):$/,
	/^Web test failed, but no failing test case was found/,
	/^Web tests: (?:PASS|FAIL) /,
];
const MAX_FALLBACK_LINES = 120;
const MAX_FALLBACK_CHARACTERS = 2_000;
const MAX_SUMMARY_LINES = 20;
const MAX_DIAGNOSTIC_SECTIONS = 8;
const MAX_DIAGNOSTIC_CHARACTERS = 2_000;
const MAX_SUMMARY_CHARACTERS = 4_000;

function formatDuration(durationMs: number): string {
	return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Control characters Bun.stripANSI leaves behind: it removes escape SEQUENCES,
 * not lone control bytes. Everything outside tab and newline goes — a bare
 * carriage return alone is enough to rewrite a report line in a terminal.
 */
const LONE_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Strip terminal control sequences from untrusted suite output before it lands
 * in the report.
 *
 * This replaced a 35-line hand-rolled CSI/OSC/DCS/SOS/PM/APC/C1 scanner. The
 * two are NOT equivalent, and the difference was measured rather than assumed
 * (Bun 1.4.2, 500k randomised control-heavy inputs):
 *
 *  - The security-critical invariant is identical and holds by construction,
 *    not by parser correctness: the trailing regex removes every C0/C1 byte, so
 *    no escape, CSI, OSC or string terminator can survive whatever the scanner
 *    ahead of it did. Zero control bytes survived either implementation.
 *  - They differ on how much PRINTABLE text each swallows around a malformed or
 *    unterminated sequence. The old scanner consumed everything to end-of-input
 *    after an unterminated introducer; Bun resynchronises. Across the fuzz the
 *    old scanner leaked marker payload Bun dropped 18372 times, and Bun leaked
 *    payload the old scanner dropped 8092 times — neither is a strict parser,
 *    and Bun is the stricter of the two more often.
 *  - On a bare C1 CSI (U+009B) Bun is simply correct where the scanner was not:
 *    `a\u009B31mred` became `a31mred`, now `ared`.
 *
 * Leaked text is inert: an OSC 8 hyperlink or a title-set command cannot act on
 * a terminal once its control bytes are gone. That is the property the pins in
 * `test-report.test.ts` assert, including the corpus-wide invariant test.
 */
function stripTerminalControls(value: string): string {
	return Bun.stripANSI(value).replace(LONE_CONTROL_PATTERN, "");
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

	// Failed-test sections lead: error-shaped output from PASSING files (an
	// intentional route-throw test logging `error: boom`, a library TypeError
	// under happy-dom) is diagnostic too, but it must never crowd the actual
	// `(fail)` sections out of the capped window (observed on PR #39: the only
	// failing section was omitted behind 8 sections of passing-file noise).
	const rank = (section: readonly string[]): number =>
		section.some((line) => BUN_FAILURE_PATTERN.test(line)) ? 0 : 1;
	const ordered = [...diagnosticSections].sort((a, b) => rank(a) - rank(b));

	const sections = ordered.slice(0, MAX_DIAGNOSTIC_SECTIONS).map((section) => limitCharacters(
		limitLines(section, MAX_FALLBACK_LINES, "diagnostic output"),
		MAX_DIAGNOSTIC_CHARACTERS,
		"diagnostic output",
	));
	if (ordered.length > MAX_DIAGNOSTIC_SECTIONS) {
		sections.push(`... ${ordered.length - MAX_DIAGNOSTIC_SECTIONS} additional diagnostic sections omitted`);
	}
	if (summaryStart !== -1) sections.push(formatBunSummary(lines, summaryStart));
	return sections.filter((section) => section !== "").join("\n\n");
}

/**
 * The suite runner's own summary lines (see RUNNER_SUMMARY_PATTERNS), in output
 * order, deduplicated across stdout and stderr. Never length-capped — the whole
 * point is that these survive when everything else is excerpted away.
 */
function extractRunnerSummary(stdout: string, stderr: string): string | null {
	const seen = new Set<string>();
	const hits: string[] = [];
	for (const line of [...stdout.split("\n"), ...stderr.split("\n")]) {
		if (seen.has(line) || !RUNNER_SUMMARY_PATTERNS.some((pattern) => pattern.test(line))) continue;
		seen.add(line);
		hits.push(line);
	}
	return hits.length === 0 ? null : hits.join("\n");
}

function formatFailure(result: TestSuiteResult): string {
	const stdout = stripTerminalControls(result.stdout);
	const stderr = stripTerminalControls(result.stderr);
	const stdoutActionable = extractBunFailure(stdout);
	const stderrActionable = extractBunFailure(stderr);
	const runnerSummary = extractRunnerSummary(stdout, stderr);
	const actionable = [
		runnerSummary,
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
