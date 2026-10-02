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

	test("surfaces the web runner's failing-file list even when stdout already has actionable diagnostics", () => {
		// Given: the shape of the PR #39 incident — bun's stdout carries (fail)
		// diagnostics (so the old composer never looked at stderr), while the
		// per-file runner printed its truncation-proof summary to stderr. The
		// list must lead the failure section, not be dropped.
		const webFailure = [{
			name: "web",
			exitCode: 1,
			durationMs: 56_400,
			stdout: [
				"apps/web/src/components/chat/narration-playlist-panel.test.tsx:",
				"(fail) RD-1b — playlist scroll > container-scoped",
				"error: expect(received).toBe(expected)",
				"",
				" 3644 pass",
				"    1 fail",
			].join("\n"),
			stderr: [
				"Web test files with failures (1):",
				"FAIL apps/web/src/components/chat/narration-playlist-panel.test.tsx (1 failed)",
				"  · continuous advance auto-scroll (RD-7) — error: expect(received).toBe(true) Expected: true Received: false",
				"",
				"Web tests: FAIL (335 files)",
		].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(webFailure);

		// Then
		expect(report).toContain("FAIL apps/web/src/components/chat/narration-playlist-panel.test.tsx (1 failed)");
		// The per-testcase `· name — message` lines must survive the lift too
		// (run 34665657469: the orchestrator dropped them — the pattern list
		// predates the lines — so the CI log showed a bare FAIL with no names).
		expect(report).toContain("  · continuous advance auto-scroll (RD-7) — error: expect");
		expect(report.indexOf("FAIL apps/web")).toBeLessThan(report.indexOf("(fail) RD-1b"));
		expect(report).toContain("Web tests: FAIL (335 files)");
	});

	test("failing sections survive passing-file diagnostic noise in the excerpt window", () => {
		// Given: ten passing files whose tests log error-shaped output (an
		// intentional route-throw, a library TypeError) plus ONE file with a real
		// (fail) — the failing section arrives LAST, past the 8-section cap.
		const noisy: string[] = [];
		for (let i = 0; i < 10; i++) {
			noisy.push(
				`src/file${i}.test.ts:`,
				"(pass) something > noise",
				`error: intentional-noise-${i}`,
				"    at <anonymous> (src/file" + i + ".test.ts:1:1)",
			);
		}
		noisy.push(
			"src/real.test.ts:",
			"(fail) real > the one that matters",
			"error: expect(received).toBe(expected)",
		);
		const noisyFailure = [{
			name: "web",
			exitCode: 1,
			durationMs: 60_000,
			stdout: noisy.join("\n"),
			stderr: "",
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(noisyFailure);

		// Then: the (fail) section is inside the window, ahead of the noise
		// (noise-8/9 fall past the cap — their ABSENCE is asserted via the
		// omission line, not indexOf, which returns -1 for excluded strings).
		expect(report).toContain("(fail) real > the one that matters");
		expect(report.indexOf("(fail) real")).toBeLessThan(report.indexOf("intentional-noise-0"));
		expect(report).toContain("... 3 additional diagnostic sections omitted");
	});

	test("bounds unrecognized fallback output", () => {
		// Given: a failed suite that produces one oversized line in each output stream.
		const oversizedFallback = [{
			name: "fallback",
			exitCode: 1,
			durationMs: 20,
			stdout: "stdout ".concat("x".repeat(200_000)),
			stderr: "stderr ".concat("y".repeat(200_000)),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(oversizedFallback);

		// Then: both streams retain their labels without making the report unbounded.
		expect(report).toContain("[stdout]");
		expect(report).toContain("[stderr]");
		expect(report).toContain("... output truncated after 2000 characters");
		expect(report.length).toBeLessThan(4_500);
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

	/**
	 * Real CI failure: `services/api` exited 1 on `0 fail` with 8 uncaught
	 * throws. Anchored on `(fail)` alone there was nothing to extract, so the
	 * report fell back to the last 120 lines of a 142-file run — the throws had
	 * printed hundreds of lines earlier and the log carried no trace of them.
	 */
	test("extracts throws Bun could not attribute to a test", () => {
		// Given: a suite that failed on uncaught errors, not on a failed assertion.
		const uncaughtFailure = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "[db] Migrations folder: /repo/packages/db/drizzle\n",
			stderr: [
				"test/early.test.ts:",
				"5 | setTimeout(() => { throw new Error(\"late boom\"); }, 20);",
				"error: late boom",
				"      at <anonymous> (/repo/services/api/test/early.test.ts:5:24)",
				"",
				"test/quiet.test.ts:",
				"[quota] poll failed for profile prov_0001 (network)",
				"",
				"test/late.test.ts:",
				"TypeError: undefined is not a function",
				"      at <anonymous> (/repo/services/api/test/late.test.ts:9:3)",
				"",
				" 1861 pass",
				" 9 skip",
				" 0 fail",
				" 8 errors",
				" 4948 expect() calls",
				"Ran 1870 tests across 142 files. [67.96s]",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(uncaughtFailure);

		// Then: both throws survive, with the file that raised each one.
		expect(report).toContain("test/early.test.ts:");
		expect(report).toContain("error: late boom");
		expect(report).toContain("test/late.test.ts:");
		expect(report).toContain("TypeError: undefined is not a function");
		// And the tally that explains the non-zero exit.
		expect(report).toContain("8 errors");
		// And a file that merely logged something error-shaped stays out.
		expect(report).not.toContain("test/quiet.test.ts:");
		expect(report).not.toContain("[quota] poll failed");
	});

	test("bounds an unhandled diagnostic excerpt", () => {
		// Given: a throwable diagnostic followed by enough noise to make a full
		// section unsuitable for an actionable terminal report.
		const oversizedDiagnostic = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/oversized.test.ts:",
				"error: late boom",
				"      at <anonymous> (/repo/services/api/test/oversized.test.ts:5:24)",
				...Array.from({ length: 121 }, (_, index) => `unrelated output ${index}`),
				" 1 pass",
				" 0 fail",
				" 1 error",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(oversizedDiagnostic);

		// Then: the error remains actionable but the unbounded tail is omitted.
		expect(report).toContain("error: late boom");
		expect(report).toContain("... diagnostic output truncated after");
		expect(report).not.toContain("unrelated output 60");
	});

	test("keeps a failed assertion at the end of an oversized test section", () => {
		// Given: a test section with more preamble than the diagnostic line budget.
		const buriedAssertion = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/buried.test.ts:",
				...Array.from({ length: 121 }, (_, index) => `setup output ${index}`),
				"error: buried boom",
				"(fail) buried > fails",
				" 0 pass",
				" 1 fail",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(buriedAssertion);

		// Then: the actionable failure remains visible after bounded compaction.
		expect(report).toContain("error: buried boom");
		expect(report).toContain("(fail) buried > fails");
	});

	test("extracts uncaught diagnostics written to stdout", () => {
		// Given: Bun's console reporter sends the diagnostic to stdout.
		const stdoutFailure = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: [
				"test/stdout.test.ts:",
				"error: stdout boom",
				"      at <anonymous> (/repo/services/api/test/stdout.test.ts:5:24)",
				" 1 pass",
				" 0 fail",
				" 1 error",
			].join("\n"),
			stderr: "",
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(stdoutFailure);

		// Then: the console diagnostic is preserved without a fallback wrapper.
		expect(report).toContain("test/stdout.test.ts:");
		expect(report).toContain("error: stdout boom");
		expect(report).not.toContain("[stdout]");
	});

	test("keeps actionable diagnostics from both output streams", () => {
		// Given: separate unhandled errors written to stdout and stderr.
		const mixedStreamFailure = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: [
				"test/stdout.test.ts:",
				"error: stdout boom",
				"      at <anonymous> (/repo/services/api/test/stdout.test.ts:5:24)",
			].join("\n"),
			stderr: [
				"test/stderr.test.ts:",
				"error: stderr boom",
				"      at <anonymous> (/repo/services/api/test/stderr.test.ts:9:24)",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(mixedStreamFailure);

		// Then: neither diagnostic is discarded because another stream was actionable.
		expect(report).toContain("error: stdout boom");
		expect(report).toContain("error: stderr boom");
	});

	test("keeps an error tally from the other output stream", () => {
		// Given: stdout has the error detail while stderr has Bun's final tally.
		const splitSummaryFailure = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: [
				"test/stdout.test.ts:",
				"error: stdout boom",
				"      at <anonymous> (/repo/services/api/test/stdout.test.ts:5:24)",
			].join("\n"),
			stderr: [" 1 pass", " 0 fail", " 1 error"].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(splitSummaryFailure);

		// Then: the tally still explains the non-zero exit.
		expect(report).toContain("1 pass");
		expect(report).toContain("0 fail");
		expect(report).toContain("1 error");
	});

	test("bounds a single oversized diagnostic line", () => {
		// Given: one diagnostic line substantially exceeds the report's character budget.
		const oversizedLine = "x".repeat(200_000);
		const oversizedDiagnostic = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/oversized-line.test.ts:",
				"error: late boom",
				"      at <anonymous> (/repo/services/api/test/oversized-line.test.ts:5:24)",
				oversizedLine,
				" 1 pass",
				" 0 fail",
				" 1 error",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(oversizedDiagnostic);

		// Then: the report remains bounded while retaining the diagnostic context and tally.
		expect(report).toContain("error: late boom");
		expect(report).toContain("... diagnostic output truncated after 2000 characters");
		expect(report).toContain("1 error");
		expect(report.length).toBeLessThan(3_000);
	});

	test("keeps a later unhandled error after an oversized diagnostic", () => {
		// Given: early diagnostic noise that would otherwise consume the whole report.
		const multipleDiagnostics = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/early.test.ts:",
				"error: early boom",
				"      at <anonymous> (/repo/services/api/test/early.test.ts:5:24)",
				...Array.from({ length: 121 }, (_, index) => `early noise ${index}`),
				"test/late.test.ts:",
				"TypeError: late boom",
				"      at <anonymous> (/repo/services/api/test/late.test.ts:9:3)",
				" 1 pass",
				" 0 fail",
				" 2 errors",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(multipleDiagnostics);

		// Then: the later throw remains visible despite the oversized early section.
		expect(report).toContain("error: early boom");
		expect(report).toContain("TypeError: late boom");
		expect(report).toContain("2 errors");
	});

	test("drops unterminated terminal strings", () => {
		// Given: repeated unclosed OSC introducers after an otherwise valid diagnostic.
		const unterminatedControls = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/terminal.test.ts:",
				"error: late boom",
				"      at <anonymous> (/repo/services/api/test/terminal.test.ts:5:24)",
				"\u001B]unclosed".repeat(10_000),
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(unterminatedControls);

		// Then: the report keeps the real diagnostic without terminal-string payload.
		expect(report).toContain("error: late boom");
		expect(report).not.toContain("unclosed");
	});

	test("removes terminal controls from an unhandled diagnostic", () => {
		// Given: diagnostic text containing OSC and DCS strings plus a carriage return.
		const terminalControls = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/terminal.test.ts:",
				"error: late boom\u001B]8;;https://untrusted.example\u0007\u001BPuntrusted DCS\u001B\\",
				"      at <anonymous> (/repo/services/api/test/terminal.test.ts:5:24)\rrewritten",
				" 1 pass",
				" 0 fail",
				" 1 error",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(terminalControls);

		// Then: the useful error and stack survive without terminal instructions.
		expect(report).toContain("error: late boom");
		expect(report).toContain("rewritten");
		expect(report).not.toContain("https://untrusted.example");
		expect(report).not.toContain("untrusted DCS");
		expect(report).not.toContain("\u001B");
		expect(report).not.toContain("\r");
	});

	test("ends a terminal string at C1 ST without swallowing the next error", () => {
		// Given: an OSC sequence closed by U+009C before another unhandled error.
		const c1TerminatedControl = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/first.test.ts:",
				"error: before boom\u001B]8;;https://untrusted.example\u009C",
				"      at <anonymous> (/repo/services/api/test/first.test.ts:5:24)",
				"test/second.test.ts:",
				"error: after boom",
				"      at <anonymous> (/repo/services/api/test/second.test.ts:9:24)",
				" 2 errors",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(c1TerminatedControl);

		// Then: the control payload is removed while the later diagnostic and tally remain.
		expect(report).toContain("error: after boom");
		expect(report).toContain("2 errors");
		expect(report).not.toContain("https://untrusted.example");
	});

	test("removes C1 terminal strings", () => {
		// Given: terminal strings introduced and terminated by C1 control bytes.
		const c1IntroducedOsc = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/terminal.test.ts:",
				"error: late boom\u0090untrusted DCS\u009C\u0098untrusted SOS\u009C\u009Dhttps://untrusted.example\u0007\u009Euntrusted PM\u009C\u009Funtrusted APC\u009C",
				"      at <anonymous> (/repo/services/api/test/terminal.test.ts:5:24)",
				" 1 error",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(c1IntroducedOsc);

		// Then: every control payload is removed without losing the diagnostic or tally.
		expect(report).toContain("error: late boom");
		expect(report).toContain("1 error");
		expect(report).not.toContain("untrusted DCS");
		expect(report).not.toContain("untrusted SOS");
		expect(report).not.toContain("https://untrusted.example");
		expect(report).not.toContain("untrusted PM");
		expect(report).not.toContain("untrusted APC");
	});

	test("ends a DCS string at C1 ST without swallowing the next error", () => {
		// Given: a DCS sequence closed by U+009C before another unhandled error.
		const c1TerminatedDcs = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/first.test.ts:",
				"error: before boom\u001BPuntrusted DCS\u009C",
				"      at <anonymous> (/repo/services/api/test/first.test.ts:5:24)",
				"test/second.test.ts:",
				"error: after boom",
				"      at <anonymous> (/repo/services/api/test/second.test.ts:9:24)",
				" 2 errors",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(c1TerminatedDcs);

		// Then: the later diagnostic and tally survive the control sequence.
		expect(report).toContain("error: after boom");
		expect(report).toContain("2 errors");
		expect(report).not.toContain("untrusted DCS");
	});
	test("lets no control byte through, whatever the sequence is doing", () => {
		// Given: a corpus of every terminal-string form the report may face —
		// well-formed, unterminated, C1-introduced, C1-terminated and nested.
		// The exact printable text each shape swallows is a property of whichever
		// scanner runs; what must NEVER vary is that no C0/C1 byte reaches the
		// report, because an OSC 8 hyperlink or a title-set command is inert once
		// its control bytes are gone.
		const control = (code: number): string => String.fromCharCode(code);
		const escape = control(0x1B);
		const bell = control(0x07);
		const stringTerminator = control(0x9C);
		const corpus = [
			`${escape}]8;;https://untrusted.example${bell}`,
			`${escape}]8;;https://untrusted.example${escape}\\`,
			`${escape}]8;;https://untrusted.example${stringTerminator}`,
			`${escape}]8;;unterminated`,
			`${escape}P untrusted DCS ${stringTerminator}`,
			`${escape}X untrusted SOS ${stringTerminator}`,
			`${escape}^ untrusted PM ${stringTerminator}`,
			`${escape}_ untrusted APC ${stringTerminator}`,
			`${control(0x90)}untrusted DCS${stringTerminator}`,
			`${control(0x98)}untrusted SOS${stringTerminator}`,
			`${control(0x9D)}https://untrusted.example${bell}`,
			`${control(0x9E)}untrusted PM${stringTerminator}`,
			`${control(0x9F)}untrusted APC${stringTerminator}`,
			`${control(0x9B)}31mbare C1 CSI`,
			`${escape}[31mSGR${escape}[39m`,
			`${escape}[?25lcursor${escape}[?25h`,
			`${escape}${escape}]8;;https://untrusted.example${bell}`,
			`line${control(0x0D)}rewritten`,
			`bell${bell}backspace${control(0x08)}delete${control(0x7F)}`,
		].join(" ");
		const controlLaden = [{
			name: "api",
			exitCode: 1,
			durationMs: 20,
			stdout: "",
			stderr: [
				"test/corpus.test.ts:",
				`error: boom ${corpus}`,
				"      at <anonymous> (/repo/services/api/test/corpus.test.ts:5:24)",
				" 1 error",
			].join("\n"),
		}] satisfies readonly TestSuiteResult[];

		// When
		const report = formatTestReport(controlLaden);

		// Then: the diagnostic survives and the report is control-free apart from
		// the tab and newline that structure it.
		expect(report).toContain("error: boom");
		expect(report).toContain("1 error");
		const surviving = [...report].filter((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x08 || (code >= 0x0B && code <= 0x1F) || (code >= 0x7F && code <= 0x9F);
		});
		expect(surviving).toEqual([]);
	});
});
