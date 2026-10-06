import { join } from "node:path";
import { failedTestCases, junitCrossAttribution, type JUnitTestCaseFailure } from "./test-junit.js";

/**
 * The committed quarantine list (TH-8 fix step 10.2; owner ruling 2026-10-03:
 * a quarantine list instead of retries — quarantined tests still RUN, no
 * skips, no retries anywhere). One entry names ONE known-failing test:
 *
 *   { "suite": "<orchestrator suite name>", "file": "<repo-relative test
 *   file>", "test": "<full test name, describe path included, outermost
 *   first — the console `(fail)` spelling>", "reason": "<why + link to the
 *   tracking report step>", "since": "YYYY-MM-DD" }
 *
 * An entry NEVER silences a run on its own: it only lets `classifySuiteRun`
 * move that one test's failure out of the blocking set, and the «Quarantined
 * failures» block keeps the debt visible in every report. File-level failures
 * (hook crashes, unhandled rejections) are not quarantinable at all.
 */
export interface QuarantineEntry {
	readonly suite: string;
	readonly file: string;
	readonly test: string;
	readonly reason: string;
	readonly since: string;
}

const QUARANTINE_LIST_PATH = join(import.meta.dir, "test-quarantine.json");

function isQuarantineEntry(value: unknown): value is QuarantineEntry {
	if (typeof value !== "object" || value === null) return false;
	const fields = new Map(Object.entries(value));
	return (
		typeof fields.get("suite") === "string"
		&& typeof fields.get("file") === "string"
		&& typeof fields.get("test") === "string"
		&& typeof fields.get("reason") === "string"
		&& typeof fields.get("since") === "string"
	);
}

/**
 * The committed list, or `[]` when it cannot be read or parsed. Failing OPEN
 * here would silently swallow quarantines, but failing CLOSED — an empty list
 * — is exactly today's behaviour (every failure blocks), which is the safe
 * direction for a runner. Making a malformed list a hard failure is the
 * hygiene guard's job (fix step 10.3), not the runner's.
 */
export async function readQuarantineList(): Promise<readonly QuarantineEntry[]> {
	try {
		const parsed: unknown = JSON.parse(await Bun.file(QUARANTINE_LIST_PATH).text());
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isQuarantineEntry);
	} catch {
		return [];
	}
}

/** A failed test case that is NOT quarantined — it blocks the suite. */
export interface BlockingFailure {
	readonly file: string;
	readonly name: string;
	readonly message: string;
}

/**
 * A failure that belongs to no test case: bun's JUnit marker for hook crashes
 * is a testcase literally named `(unnamed)` (observed on Bun 1.4.2: an
 * `afterAll` throw lands as `<testcase name="(unnamed)" … assertions="0">`
 * with no `line` attribute), and an unhandled rejection at module load kills
 * the run before the reporter writes anything at all. Never quarantinable —
 * there is no test name to match an entry against, and the file itself is
 * unhealthy.
 */
export interface FileLevelFailure {
	readonly file: string;
	readonly message: string;
}

export interface SuiteVerdict {
	readonly blocking: readonly BlockingFailure[];
	readonly quarantined: readonly QuarantineEntry[];
	readonly fileLevel: readonly FileLevelFailure[];
}

/** Bun's JUnit name for failures that are not a test (see `FileLevelFailure`). */
const UNNAMED_TESTCASE = "(unnamed)";

/** A parsable JUnit report starts with a `<testsuites>`/`<testsuite>` element. */
const JUNIT_SHAPE = /<testsuites?\b/;

const TESTCASE_BLOCK_PATTERN = /<testcase\b[^>]*>[\s\S]*?<\/testcase>|<testcase\b[^>]*\/>/g;

/**
 * The full test name, describe path included, in the spelling bun uses
 * everywhere else (the console `(fail)` line, `--reporter=junit` aside):
 * OUTERMOST describe first, leaf test last.
 *
 * Bun's JUnit splits a test's identity in two: the `name` attribute carries
 * only the leaf title, while the describe path sits in `classname` joined
 * INNERMOST-first — `describe("A") > describe("B") > describe("C") >
 * test("leaf")` reports `name="leaf"` and `classname="C ctx > B ctx > A ctx"`
 * (observed on Bun 1.4.2; pinned in test-quarantine.test.ts). The quarantine
 * list keys the console spelling, so the classname segments are reversed back
 * here. A top-level test has `classname=""` and is its own full name.
 */
function fullNameOf(failure: JUnitTestCaseFailure): string {
	const path = failure.classname.trim();
	if (path === "") return failure.name;
	return `${path.split(" > ").reverse().join(" > ")} > ${failure.name}`;
}

/**
 * One suite's verdict from its exit code, its JUnit report, and the committed
 * quarantine list:
 *
 * - a FAILED test case matches an entry by `suite` + full test name; the entry
 *   `file`'s trustworthiness is checked with `junitCrossAttribution` («trust
 *   the stack»: under `--parallel` bun can bill a failure to the wrong
 *   testcase, so a report whose failing stack frame names a different test
 *   file never quarantines the test it claims);
 * - file-level failures always block and always land in `fileLevel`;
 * - FAIL CLOSED: a non-zero exit whose report is missing or not JUnit blocks
 *   everything (observed: an unhandled rejection at module load exits 1
 *   without the reporter writing a file);
 * - a zero exit is green, but the report is still walked so quarantined
 *   failures stay listed — the web runner applies this verdict itself and
 *   exits 0 while its JUnit report still carries the quarantined failures.
 *
 * The suite PASSES when `blocking` and `fileLevel` are both empty, even if bun
 * exited non-zero; any failed test case without a matching entry blocks.
 */
export function classifySuiteRun(input: {
	readonly exitCode: number | null;
	readonly report: string;
	readonly suite: string;
	readonly quarantine: readonly QuarantineEntry[];
}): SuiteVerdict {
	if (input.exitCode !== 0 && !JUNIT_SHAPE.test(input.report)) {
		return {
			blocking: [{
				file: "",
				name: "",
				message: "non-zero exit with a missing or unparsable JUnit report (crash or unhandled error before the reporter ran)",
			}],
			quarantined: [],
			fileLevel: [],
		};
	}

	const blocking: BlockingFailure[] = [];
	const matched: QuarantineEntry[] = [];
	const fileLevel: FileLevelFailure[] = [];
	for (const failure of failedTestCases(input.report)) {
		if (failure.name === UNNAMED_TESTCASE) {
			fileLevel.push({ file: failure.file, message: failure.message });
			continue;
		}
		const name = fullNameOf(failure);
		const entry = input.quarantine.find(
			(candidate) => candidate.suite === input.suite && candidate.test === name,
		);
		if (entry !== undefined && junitCrossAttribution(failure.file, failure.message) === null) {
			matched.push(entry);
			continue;
		}
		blocking.push({ file: failure.file, name, message: failure.message });
	}

	// A failure/error element outside any testcase (no observed Bun shape —
	// defensive and fail-closed): it belongs to no test, so it can never be
	// quarantined. Attribute values like failures="2" never match: the regex
	// requires the `<` to sit immediately before the element name.
	const withoutTestcases = input.report.replace(TESTCASE_BLOCK_PATTERN, "");
	if (/<(?:failure|error)\b/.test(withoutTestcases)) {
		fileLevel.push({ file: "", message: "JUnit failure outside any testcase" });
	}

	return { blocking, quarantined: [...new Set(matched)], fileLevel };
}
