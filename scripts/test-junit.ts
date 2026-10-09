/**
 * Shared JUnit report parsing for the test runners.
 *
 * Everything between the module banner and `failedTestCases` moved VERBATIM
 * from `scripts/test-web.ts` (TH-8 fix step 10.2): once the orchestrator
 * (`scripts/test.ts`) started collecting JUnit reports for every suite, the
 * web runner and the orchestrator had to read reports through ONE parser —
 * the quarantine verdict (`scripts/test-quarantine.ts`) is only trustworthy
 * if both runners see the same testcase shapes. The web runner re-exports
 * these so its existing tests keep their boundary; do not fork them back.
 */

/**
 * Files the JUnit report saw at least one test case for, keyed the way the rest
 * of this script keys files: repository-relative with forward slashes. The paths
 * are repository-relative already because the child runs with `cwd: root`, but
 * the reporter writes them with the PLATFORM separator — `apps\web\test\a.test.ts`
 * on Windows — so they are re-slashed before the caller can compare them against
 * a normalized file list. Skipping that turns every file on Windows into an
 * apparent zero-test file.
 *
 * `bun test` exits 0 for a file that registers no tests at all, so this set is
 * the only thing standing between a silently emptied test file and a green suite.
 *
 * `>` is XML-escaped inside attribute values, so `[^>]*` cannot run past the
 * element it started in.
 */
export function filesWithTests(report: string): ReadonlySet<string> {
	return new Set(
		[...report.matchAll(/<testcase\b[^>]*\bfile="([^"]+)"/g)].flatMap((match) =>
			match[1] === undefined ? [] : [match[1].replaceAll("\\", "/")],
		),
	);
}

/**
 * Per-file failure info from the same JUnit report: test cases carrying a
 * `<failure>` or `<error>` child, keyed like `filesWithTests` keys them.
 *
 * Why this exists when bun already prints failures on screen: CI log systems
 * (GitHub Actions) truncate long step output with "... N additional diagnostic
 * sections omitted" — with 8 parallel workers and a failing suite, the failing
 * test names are routinely INSIDE the truncated part, and not even a debug
 * rerun recovers them (verified twice on PR #39, runs 34643719177/34644574473).
 * The runner itself must name the failing files; the JUnit report it already
 * collects is the only input that survives truncation.
 *
 * Names and messages are kept because bun's on-screen tally counts TEST
 * failures only — a file-level error (afterAll crash, worker-level throw)
 * lands in the JUnit report as an error-carrying test case bun never names
 * (PR #39 run 34664917488: gallery-api.test.ts carried a JUnit failure while
 * bun's "N tests failed" listed a different file). The message attribute is
 * the only surviving trace of such errors.
 *
 * Self-closing testcases (`<testcase ... />`) are passes by construction — a
 * failure always has body content (the assertion diff / message).
 */
export interface FailingFile {
	readonly file: string;
	readonly count: number;
	readonly entries: readonly { readonly name: string; readonly message: string }[];
}

function parseFailingEntry(block: string): { name: string; message: string } | null {
	if (!/<(?:failure|error)\b/.test(block)) return null;
	const file = block.match(/\bfile="([^"]+)"/)?.[1];
	if (file === undefined) return null;
	const name = block.match(/\bname="([^"]*)"/)?.[1] ?? "(unnamed)";
	const rawMessage = block.match(/<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/)?.[1] ?? "";
	// XML-unescape the essentials; escaped stack frames render as &lt;at ...&gt;
	// blobs — collapse them, keep the readable first line of the message.
	const message = rawMessage
		.replace(/&lt;[\s\S]*?&gt;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
	return { name: name === "" ? "(unnamed)" : name, message };
}

export function failingFiles(report: string): ReadonlyMap<string, FailingFile> {
	const byFile = new Map<string, FailingFile>();
	const blocks = report.match(/<testcase\b[^>]*>[\s\S]*?<\/testcase>|<testcase\b[^>]*\/>/g) ?? [];
	for (const block of blocks) {
		const entry = parseFailingEntry(block);
		if (entry === null) continue;
		const key = (block.match(/\bfile="([^"]+)"/)?.[1] ?? "").replaceAll("\\", "/");
		if (key === "") continue;
		const existing = byFile.get(key);
		if (existing === undefined) {
			byFile.set(key, { file: key, count: 1, entries: [entry] });
		} else {
			const entries = [...existing.entries, entry].slice(0, 5);
			byFile.set(key, { file: key, count: existing.count + 1, entries });
		}
	}
	return byFile;
}

/**
 * `bun test --parallel=N` + `--reporter=junit` can CROSS-ATTRIBUTE a JUnit
 * entry: the testcase NAME comes from one worker's file while the failure
 * MESSAGE (and its stack frame) comes from another. Observed on Bun 1.4.0 (PR
 * #39, runs 34664917488 / 34665657469 / 34668434046: gallery-api.test.ts
 * entries whose messages point into TtsProfileEditor/experience-sdk-diag — a
 * chase that cost four CI cycles before the pattern was named). The pin has
 * since moved to 1.4.2 and it has not recurred, but nothing in the 1.4.1/1.4.2
 * changelogs claims a fix and the failure is intermittent, so this stays: it is
 * a diagnostic, not a workaround, and it costs nothing when the report is sane.
 * bun's on-screen tally is correct; the JUnit file path is not. When the failing
 * message's
 * first stack frame names a DIFFERENT test file than the JUnit `file=`
 * attribute, say so in the summary line — the stack is the thing to trust.
 */
export function junitCrossAttribution(file: string, message: string): string | null {
	const frame = message.match(/\bat +(\S+\.test\.tsx?):\d+:\d+/)?.[1];
	if (frame === undefined) return null;
	const frameFile = frame.replaceAll("\\", "/").replace(/^\(/, "");
	if (frameFile === file || !frameFile.endsWith(".test.ts") && !frameFile.endsWith(".test.tsx")) return null;
	return `junit filed under ${file}, stack points to ${frameFile} — parallel junit cross-attribution, trust the stack`;
}

/**
 * Every FAILED test case in the report, uncapped and in document order, with
 * the file it was billed to, its leaf name, its describe path (`classname`,
 * which bun joins INNERMOST-first — see `fullNameOf` in
 * `scripts/test-quarantine.ts`), and its cleaned message.
 *
 * `failingFiles` above caps its per-file entries at five for the on-screen
 * summary; the quarantine verdict must see EVERY failure (a file with six
 * failures, five quarantined and one not, would otherwise look green), so this
 * iterator exists separately. Its block pattern also differs from
 * `failingFiles`' in one deliberate way: a body testcase must not end in `/`
 * before its `>`, so a SELF-CLOSING testcase can never merge with the next
 * body testcase — under the plain pattern, `<testcase … />` has no closing
 * tag of its own and swallows the following testcase whole, misfiling that
 * test's name. For `failingFiles` the merge is invisible (same file
 * attribute, per-file aggregation); for per-case matching it would be fatal.
 * Name and classname are XML-unescaped here (bun writes `&gt;` inside the
 * classname path) so they carry the console spelling of the test id.
 *
 * Shapes below are the ones Bun 1.4.2 actually emits (observed via
 * `bun run test:file -- <fixture> --reporter=junit --reporter-outfile …`):
 * a normal assertion failure, a thrown error inside a named test, a late
 * rejection billed to the running test, and a hook crash landing as a testcase
 * literally named `(unnamed)` with `assertions="0"` and no `line` attribute.
 */
export interface JUnitTestCaseFailure {
	readonly file: string;
	readonly name: string;
	readonly classname: string;
	readonly message: string;
}

/** XML-unescape an attribute value (bun escapes `&<>"'` inside attributes). */
function unescapeAttribute(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

export function failedTestCases(report: string): readonly JUnitTestCaseFailure[] {
	const blocks = report.match(/<testcase\b(?:[^>]*[^/])?>[\s\S]*?<\/testcase>|<testcase\b[^>]*\/>/g) ?? [];
	const failures: JUnitTestCaseFailure[] = [];
	for (const block of blocks) {
		const entry = parseFailingEntry(block);
		if (entry === null) continue;
		const file = (block.match(/\bfile="([^"]+)"/)?.[1] ?? "").replaceAll("\\", "/");
		if (file === "") continue;
		const classname = unescapeAttribute(block.match(/\bclassname="([^"]*)"/)?.[1] ?? "");
		failures.push({ file, name: unescapeAttribute(entry.name), classname, message: entry.message });
	}
	return failures;
}
