import { describe, expect, test } from "bun:test";
import { classifySuiteRun, readQuarantineList, type QuarantineEntry } from "./test-quarantine.js";

/**
 * Classifier matrix for the quarantine verdict (TH-8 fix step 10.2). Every
 * fixture below is the REAL shape Bun 1.4.2 emits, observed by running
 * fixtures through `bun run test:file -- <fixture> --reporter=junit
 * --reporter-outfile …` and copying the produced XML (2026-10-06, probe dir in
 * the system TEMP — nothing here is guessed):
 *
 * - a plain assertion failure: `<failure type="AssertionError">` inside a
 *   named testcase, stack frame `at fail.test.ts:2:41`;
 * - a nested describe path: testcase `name` is the LEAF only, the describe
 *   path sits in `classname` joined INNERMOST-first (`C ctx > B ctx > A ctx`);
 * - an `afterAll` throw: a testcase literally named `(unnamed)`, no `line`
 *   attribute, `assertions="0"` — that is bun's file-level marker;
 * - an unhandled rejection at module load: NO report file at all (the run dies
 *   before the reporter runs) — the missing-report fail-closed fixture.
 */

const PLAIN_FAILURE_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="1" skipped="0" time="0.0083146">
  <testsuite name="fail.test.ts" file="fail.test.ts" tests="1" assertions="1" failures="1" skipped="0" time="0.0006176" hostname="">
    <testcase name="plain failure" classname="" time="0.000164" file="fail.test.ts" line="2" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;&#10;      at fail.test.ts:2:41&#10;</failure>
    </testcase>
  </testsuite>
</testsuites>`;

const DEEP_DESCRIBE_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="1" skipped="0" time="0.0082128">
  <testsuite name="deep3.test.ts" file="deep3.test.ts" tests="1" assertions="1" failures="1" skipped="0" time="0.0006609" hostname="">
    <testcase name="leaf" classname="C ctx &gt; B ctx &gt; A ctx" time="0.000152" file="deep3.test.ts" line="2" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;&#10;      at deep3.test.ts:2:100&#10;</failure>
    </testcase>
  </testsuite>
</testsuites>`;

/** Real afterAll-crash shape plus a named failure in the same file, so the
 *  file-level and test-level paths can be exercised on one report. */
const AFTERALL_PLUS_NAMED_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="2" failures="2" skipped="0" time="0.0084505">
  <testsuite name="afterall.test.ts" file="afterall.test.ts" tests="3" assertions="2" failures="2" skipped="0" time="0.0006577" hostname="">
    <testcase name="passing test" classname="" time="0.000027" file="afterall.test.ts" line="2" assertions="1" />
    <testcase name="known flaky" classname="" time="0.000164" file="afterall.test.ts" line="4" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;&#10;      at afterall.test.ts:4:41&#10;</failure>
    </testcase>
    <testcase name="(unnamed)" classname="" time="0.000136" file="afterall.test.ts" assertions="0">
      <failure type="Error" message="afterAll boom">Error: afterAll boom&#10;      at afterall.test.ts:6:49&#10;</failure>
    </testcase>
  </testsuite>
</testsuites>`;

const GREEN_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.0082203">
  <testsuite name="timer.test.ts" file="timer.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.0006917" hostname="">
    <testcase name="ok test" classname="" time="0.000039" file="timer.test.ts" line="2" assertions="1" />
  </testsuite>
</testsuites>`;

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
	return {
		suite: "api",
		file: "services/api/test/fail.test.ts",
		test: "plain failure",
		reason: "known flake — TEST_SUITE_HYGIENE_REPORT fix step 10",
		since: "2026-10-06",
		...overrides,
	};
}

describe("quarantine verdict", () => {
	test("a quarantined failure leaves the suite green and is listed", () => {
		// The owner ruling (2026-10-03): a quarantine list instead of retries —
		// the test still RAN and still failed; only the verdict moves.
		const verdict = classifySuiteRun({
			exitCode: 1,
			report: PLAIN_FAILURE_REPORT,
			suite: "api",
			quarantine: [entry()],
		});
		expect(verdict.blocking).toEqual([]);
		expect(verdict.fileLevel).toEqual([]);
		expect(verdict.quarantined).toEqual([entry()]);
	});

	test("a failure without a matching entry blocks the suite", () => {
		const verdict = classifySuiteRun({
			exitCode: 1,
			report: PLAIN_FAILURE_REPORT,
			suite: "api",
			quarantine: [entry({ test: "some other test" })],
		});
		expect(verdict.quarantined).toEqual([]);
		expect(verdict.fileLevel).toEqual([]);
		expect(verdict.blocking).toHaveLength(1);
		expect(verdict.blocking[0]?.name).toBe("plain failure");
		expect(verdict.blocking[0]?.file).toBe("fail.test.ts");
	});

	test("a file-level error blocks even when the file also has quarantined tests", () => {
		// afterAll crash = testcase named "(unnamed)" — there is no test name to
		// match an entry against, and the file itself is unhealthy.
		const verdict = classifySuiteRun({
			exitCode: 1,
			report: AFTERALL_PLUS_NAMED_REPORT,
			suite: "api",
			quarantine: [entry({ test: "known flaky", file: "services/api/test/afterall.test.ts" })],
		});
		expect(verdict.quarantined).toEqual([entry({ test: "known flaky", file: "services/api/test/afterall.test.ts" })]);
		// The moved parser's real cleaned shape: numeric `&#10;` entities survive
		// (only `&lt; &gt; &quot; &#39; &amp;` and \uXXXX are decoded), whitespace
		// collapses — the frame stays regex-reachable for cross-attribution.
		expect(verdict.fileLevel).toEqual([
			{ file: "afterall.test.ts", message: "Error: afterAll boom&#10; at afterall.test.ts:6:49&#10;" },
		]);
		expect(verdict.blocking).toEqual([]);
	});

	test("a cross-attributed report never quarantines the test it names", () => {
		// The documented --parallel misfiling (PR #39): the testcase name+file
		// come from one worker while the failure message's stack frame points
		// into a different test file. «Trust the stack» — the entry does not
		// apply, the failure blocks.
		const crossAttributed = PLAIN_FAILURE_REPORT
			.replace(/file="fail\.test\.ts"/g, 'file="apps/web/src/api/gallery-api.test.ts"')
			.replace("at fail.test.ts:2:41", "at apps/web/src/components/settings/provider/tts/TtsProfileEditor.test.tsx:364:34");
		const verdict = classifySuiteRun({
			exitCode: 1,
			report: crossAttributed,
			suite: "web",
			quarantine: [entry({ suite: "web", test: "plain failure", file: "apps/web/src/api/gallery-api.test.ts" })],
		});
		expect(verdict.quarantined).toEqual([]);
		expect(verdict.blocking).toHaveLength(1);
	});

	test("an empty quarantine list is exactly today's behaviour", () => {
		// Every failure blocks; a green report stays green.
		const red = classifySuiteRun({ exitCode: 1, report: PLAIN_FAILURE_REPORT, suite: "api", quarantine: [] });
		expect(red.blocking).toHaveLength(1);
		expect(red.quarantined).toEqual([]);
		expect(red.fileLevel).toEqual([]);
		const green = classifySuiteRun({ exitCode: 0, report: GREEN_REPORT, suite: "api", quarantine: [] });
		expect(green.blocking).toEqual([]);
		expect(green.quarantined).toEqual([]);
		expect(green.fileLevel).toEqual([]);
	});

	test("a non-zero exit with a missing report blocks everything", () => {
		// Observed: an unhandled rejection at module load exits 1 without the
		// reporter writing a file. Fail closed — nothing may be quarantined on
		// a report nobody can read.
		const verdict = classifySuiteRun({ exitCode: 1, report: "", suite: "api", quarantine: [entry()] });
		expect(verdict.quarantined).toEqual([]);
		expect(verdict.fileLevel).toEqual([]);
		expect(verdict.blocking).toHaveLength(1);
		expect(verdict.blocking[0]?.message).toContain("missing or unparsable JUnit report");
	});

	test("a non-zero exit with a report that is not JUnit blocks everything", () => {
		const verdict = classifySuiteRun({
			exitCode: 1,
			report: "error: late rejection\n 1 error\n",
			suite: "api",
			quarantine: [entry()],
		});
		expect(verdict.quarantined).toEqual([]);
		expect(verdict.blocking).toHaveLength(1);
	});

	test("a zero exit is green but still lists quarantined failures", () => {
		// The web handoff shape: the web runner applies the verdict itself and
		// exits 0 while its JUnit report still carries the quarantined
		// failures — the orchestrator must keep them listed, not lose them.
		const verdict = classifySuiteRun({
			exitCode: 0,
			report: PLAIN_FAILURE_REPORT,
			suite: "web",
			quarantine: [entry({ suite: "web", file: "apps/web/src/fail.test.ts" })],
		});
		expect(verdict.blocking).toEqual([]);
		expect(verdict.fileLevel).toEqual([]);
		expect(verdict.quarantined).toEqual([entry({ suite: "web", file: "apps/web/src/fail.test.ts" })]);
	});

	test("matches the full test name with the describe path outermost first", () => {
		// `name` is the leaf only; `classname` is innermost-first ("C ctx > B
		// ctx > A ctx"). The quarantine list keys the console spelling —
		// "A ctx > B ctx > C ctx > leaf" — so a leaf-only entry must NOT match.
		const full = classifySuiteRun({
			exitCode: 1,
			report: DEEP_DESCRIBE_REPORT,
			suite: "api",
			quarantine: [entry({ test: "A ctx > B ctx > C ctx > leaf" })],
		});
		expect(full.quarantined).toEqual([entry({ test: "A ctx > B ctx > C ctx > leaf" })]);
		expect(full.blocking).toEqual([]);
		const leafOnly = classifySuiteRun({
			exitCode: 1,
			report: DEEP_DESCRIBE_REPORT,
			suite: "api",
			quarantine: [entry({ test: "leaf" })],
		});
		expect(leafOnly.quarantined).toEqual([]);
		expect(leafOnly.blocking[0]?.name).toBe("A ctx > B ctx > C ctx > leaf");
	});

	test("an entry from a different suite never matches", () => {
		const verdict = classifySuiteRun({
			exitCode: 1,
			report: PLAIN_FAILURE_REPORT,
			suite: "api",
			quarantine: [entry({ suite: "web" })],
		});
		expect(verdict.quarantined).toEqual([]);
		expect(verdict.blocking).toHaveLength(1);
	});

	test("a failure outside any testcase is file-level and blocks", () => {
		// No observed Bun shape — defensive: a `<failure>`/`<error>` element
		// that belongs to no testcase can never be quarantined.
		const report = `<testsuites name="bun test" tests="0" failures="1">
  <testsuite name="weird.test.ts" file="weird.test.ts" tests="0" failures="1" hostname="">
    <error message="worker-level throw">Error: worker-level throw</error>
  </testsuite>
</testsuites>`;
		const verdict = classifySuiteRun({ exitCode: 1, report, suite: "api", quarantine: [] });
		expect(verdict.quarantined).toEqual([]);
		expect(verdict.blocking).toEqual([]);
		expect(verdict.fileLevel).toHaveLength(1);
	});

	test("platform separators in the report file attribute normalize", () => {
		const windowsReport = PLAIN_FAILURE_REPORT.replaceAll("fail.test.ts", "services\\api\\test\\fail.test.ts");
		const verdict = classifySuiteRun({
			exitCode: 1,
			report: windowsReport,
			suite: "api",
			quarantine: [entry()],
		});
		// The stack frame agrees with the (re-slashed) file attribute, so the
		// entry applies and the reported file is forward-slashed.
		expect(verdict.quarantined).toEqual([entry()]);
		expect(verdict.blocking).toEqual([]);
	});

	test("reads the committed quarantine list as an array", async () => {
		// The list starts as [] (TH-8 fix step 10.2); entries arrive with the
		// flakes they name. Only the shape is pinned here — content validation
		// is the hygiene guard's job (fix step 10.3).
		const list = await readQuarantineList();
		expect(Array.isArray(list)).toBe(true);
	});
});
