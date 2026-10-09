/**
 * Mechanical test-suite hygiene guard — the L2 layer of the testing discipline
 * (design: TEST_SUITE_HYGIENE_REPORT.md, fix step 7 / TH-4c).
 *
 * WHY A SCRIPT: every rule below was already prose in the testing skill or in
 * AGENTS.md at the time some incident violated it (registry poisoning,
 * N:/-path fixtures breaking linux CI, innerHTML surgery, unbounded waits).
 * Prose is read once and enforced never; this guard fails `bun run check`
 * deterministically, with zero LLM judgment, including on test files written
 * by workers that never opened the skill.
 *
 * TWO RULE KINDS:
 * - HARD bans (fail on any occurrence): out-of-repo path literals; a registry
 *   reset call with no matching snapshot/restore in the same file. The current
 *   tree is clean on both — keep it that way.
 * - RATCHET budgets (fail only on GROWTH): `as never`, global `screen.`,
 *   `innerHTML = ""`, literal sleeps > 200ms. The legacy suite is over budget
 *   by design here; rewriting it wholesale is wontfix (TH-4 verdict). Cleanup
 *   work lowers the number; a cleanup edit updates the budget DOWN, never up.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createTestSuites } from "./test.js";

const repoRoot = join(import.meta.dir, "..");

/**
 * The quarantine list the runner reads (scripts/test-quarantine.ts,
 * TH-8 fix step 10.2). The runner fails CLOSED on a malformed list — it
 * silently degrades to an empty list rather than weakening the verdict — so a
 * malformed list is a HARD failure HERE, not a runner concern.
 */
const QUARANTINE_LIST_PATH = join(repoRoot, "scripts", "test-quarantine.json");

/**
 * The quarantine entry `suite` field keys the orchestrator's suite names
 * (scripts/test.ts `createTestSuites()`). Derived, not hand-copied — one data
 * source, and a suite rename here is the SAME rename the runner already uses.
 */
export const KNOWN_SUITES: readonly string[] = [...new Set(createTestSuites().map((suite) => suite.name))];

const KNOWN_SUITE_SET: ReadonlySet<string> = new Set(KNOWN_SUITES);

/** Quarantine entries older than this many days print a reminder — never a failure. */
const QUARANTINE_REMINDER_DAYS = 30;

/**
 * RATCHET BUDGETS — snapshot of the tree on 2026-09-12.
 * Lower these after cleanups; never raise them. If a new test legitimately
 * needs to grow one of these, that is a conversation (the guard's whole point
 * is that growth is a visible, deliberate act, not drift).
 */
export const BUDGETS = {
	/** `as never` casts in test files (TS-7b class; blanket rewrite wontfix). */
	// 1243 (2026-10-04): ratcheted to the merged tree's count after PR #51.
	asNever: 1243,
	/** Global `screen.` usage in apps/web test files (binds at import time). */
	// 196 (2026-10-04): ratcheted to the merged tree's count after PR #51
	// (provider-lists unification removed the forked pickers' screen usage;
	// 2026-10-09 regex remediation removed the rest — locked at 156).
	screen: 156,
	/** `innerHTML = ""` surgeries (TtsProfileEditor legacy block). */
	innerHTMLEmpty: 30,
	/** Literal `await sleep/delay/wait(N)` with N > 200 in test files. */
	longSleeps: 2,
} as const;

const EXCLUDED_DIRS = new Set([".git", "node_modules", "out", "data", "dist", ".cache"]);

/** A test file is any `*.test.ts` / `*.test.tsx` reachable from the repo root. */
export function isTestFilePath(repoRelativePath: string): boolean {
	const name = repoRelativePath.split(/[\\/]/).pop() ?? "";
	return name.endsWith(".test.ts") || name.endsWith(".test.tsx");
}

export function collectTestFiles(root: string = repoRoot): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (EXCLUDED_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			const st = statSync(full);
			if (st.isDirectory()) {
				// Nested repositories and worktrees own their own test budgets.
				if (!existsSync(join(full, ".git"))) walk(full);
			}
			else {
				const rel = relative(root, full).replaceAll("\\", "/");
				if (isTestFilePath(rel)) found.push(rel);
			}
		}
	};
	walk(root);
	found.sort();
	return found;
}

export interface Violation {
	readonly rule: string;
	readonly file: string;
	readonly line: number;
	readonly text: string;
	readonly hint: string;
}

export interface FileMetrics {
	asNever: number;
	screen: number;
	innerHTMLEmpty: number;
	longSleeps: number;
}

/**
 * File-level opt-out for the path rule ONLY: hostile-input tests quote
 * absolute paths as ATTACK DATA (zip-slip `"C:\\Windows\\evil.dll"`, kdialog
 * stdout, execPath classification) — nothing is ever loaded from those paths,
 * so the CI-breaking incident class does not apply. The marker must carry a
 * reason comment on the same line; a marker without a reason is honored but
 * obvious in review, and the registry rule still applies regardless.
 */
const ALLOW_ABS_PATH_INPUTS = /hygiene:allow-abs-path-inputs\b/;

/** The guard's own test file quotes every banned pattern deliberately — exempt it entirely. */
const GUARD_SELF_TEST = /(?:^|\/)test-hygiene\.test\.ts$/;

const DRIVE_OR_POSIX_ABSOLUTE = /["'`][A-Za-z]:[\\/]|["'`]\/(?:tmp|home|root|Users|var|mnt)\//;
const REGISTRY_RESET_CALL = /__(?:reset)\w*Registry\w*ForTests\s*\(/;
const REGISTRY_SNAPSHOT_OR_RESTORE = /__(?:snapshot|restore)\w*ForTests/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const INNER_HTML_EMPTY = /innerHTML\s*=\s*(?:""|'')/g;
const AS_NEVER = /\bas\s+never\b/g;
const SCREEN_DOT = /\bscreen\./g;
const LONG_SLEEP = /await\s+(?:Bun\.)?(?:sleep|delay|wait)\(\s*(\d+)\s*\)/g;
const STATIC_RTL_IMPORT = /^\s*import(?:\s+type)?\s+(?:[\s\S]*?\s+from\s+)?["']@testing-library\/react["']\s*;/gm;

/** Blank/comment lines never count as calls — incident reports are quoted in comments. */
function isCommentLine(line: string): boolean {
	return COMMENT_LINE.test(line);
}

function countMatches(content: string, pattern: RegExp): number {
	return [...content.matchAll(pattern)].length;
}

export function scanFile(content: string, file: string): { violations: Violation[]; metrics: FileMetrics } {
	const lines = content.split(/\r?\n/);
	const violations: Violation[] = [];
	const metrics: FileMetrics = { asNever: 0, screen: 0, innerHTMLEmpty: 0, longSleeps: 0 };
	if (GUARD_SELF_TEST.test(file)) return { violations, metrics };
	const pathsAllowed = ALLOW_ABS_PATH_INPUTS.test(content);
	STATIC_RTL_IMPORT.lastIndex = 0;
	const staticRtlImport = file.startsWith("apps/web/src/") ? STATIC_RTL_IMPORT.exec(content) : null;
	if (staticRtlImport) {
		const offset = staticRtlImport.index;
		violations.push({
			rule: "rtl-import-needs-dom-env",
			file,
			line: content.slice(0, offset).split(/\r?\n/).length,
			text: staticRtlImport[0].trim(),
			hint: "Call useDomEnv(), then use top-level `await import(\"@testing-library/react\")` below it; static RTL imports bind screen before happy-dom registers.",
		});
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isCommentLine(line)) continue;

		if (!pathsAllowed && DRIVE_OR_POSIX_ABSOLUTE.test(line)) {
			violations.push({
				rule: "no-out-of-repo-paths",
				file,
				line: i + 1,
				text: line.trim(),
				hint: "Absolute/out-of-repo paths break on other machines (linux CI saw N:/ fixtures). Anchor via ${import.meta.dir} or repo-relative paths.",
			});
		}

		if (REGISTRY_RESET_CALL.test(line) && !REGISTRY_SNAPSHOT_OR_RESTORE.test(content)) {
			violations.push({
				rule: "registry-reset-needs-restore",
				file,
				line: i + 1,
				text: line.trim(),
				hint: "A registry reset poisons the shared bun test process for every later file. Snapshot in beforeAll, restore in afterAll (see tts-routes.test.ts).",
			});
		}
	}

	metrics.asNever += countMatches(content, AS_NEVER);
	metrics.screen += countMatches(content, SCREEN_DOT);
	metrics.innerHTMLEmpty += countMatches(content, INNER_HTML_EMPTY);
	for (const m of content.matchAll(LONG_SLEEP)) {
		if (Number.parseInt(m[1] ?? "0", 10) > 200) metrics.longSleeps++;
	}

	return { violations, metrics };
}

export interface GuardReport {
	readonly files: number;
	readonly violations: readonly Violation[];
	readonly totals: FileMetrics;
	readonly budgetBreaches: readonly string[];
}

export function runGuard(files: readonly string[], read: (file: string) => string): GuardReport {
	const violations: Violation[] = [];
	const totals: FileMetrics = { asNever: 0, screen: 0, innerHTMLEmpty: 0, longSleeps: 0 };
	for (const file of files) {
		const { violations: v, metrics } = scanFile(read(file), file);
		violations.push(...v);
		totals.asNever += metrics.asNever;
		totals.screen += metrics.screen;
		totals.innerHTMLEmpty += metrics.innerHTMLEmpty;
		totals.longSleeps += metrics.longSleeps;
	}
	const budgetBreaches: string[] = [];
	const check = (label: string, actual: number, budget: number): void => {
		if (actual > budget) {
			budgetBreaches.push(`${label}: ${actual} > budget ${budget} (ratchet — lower the budget after cleanups, never raise; new growth needs a deliberate decision)`);
		}
	};
	check("as-never", totals.asNever, BUDGETS.asNever);
	check("screen", totals.screen, BUDGETS.screen);
	check("innerHTML-empty", totals.innerHTMLEmpty, BUDGETS.innerHTMLEmpty);
	check("long-sleeps", totals.longSleeps, BUDGETS.longSleeps);
	return { files: files.length, violations, totals, budgetBreaches };
}

export interface QuarantineViolation {
	/** Rule id, e.g. `quarantine-unknown-suite`. */
	readonly rule: string;
	/** Human locator: `scripts/test-quarantine.json entry #2`, or just the file for whole-list problems. */
	readonly location: string;
	/** The offending value, JSON-serialized (`<missing>` for an absent field). */
	readonly text: string;
	readonly hint: string;
}

export interface QuarantineReport {
	readonly violations: readonly QuarantineViolation[];
	readonly reminders: readonly string[];
}

/** `today` as a UTC calendar date (YYYY-MM-DD). Date math below compares
 *  CALENDAR dates derived from the strings, never `Date.now()` milliseconds:
 *  a run just before/after local midnight must classify the same day. */
function utcToday(): string {
	return new Date().toISOString().slice(0, 10);
}

const MS_PER_DAY = 86_400_000;

/** Parses a YYYY-MM-DD calendar date to a UTC-midnight epoch, or null when the
 *  string is not a real calendar date (the Date.UTC round-trip rejects
 *  impossible dates like 2026-13-40). */
function parseCalendarDate(value: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const epoch = Date.UTC(year, month - 1, day);
	const check = new Date(epoch);
	if (
		check.getUTCFullYear() !== year
		|| check.getUTCMonth() !== month - 1
		|| check.getUTCDate() !== day
	) return null;
	return epoch;
}

/** Whole calendar days from `since` to `today` (both UTC-midnight epochs). */
function daysBetween(since: number, today: number): number {
	return Math.round((today - since) / MS_PER_DAY);
}

/** Serializes a value for a violation message, spelling an absent field. */
function textOf(value: unknown): string {
	if (value === undefined) return "<missing>";
	return JSON.stringify(value) ?? String(value);
}

/**
 * The quarantine-file guard (TH-8 fix step 10.3). Reads the RAW JSON — NOT
 * `readQuarantineList()`, which filters bad entries to keep the runner safe —
 * and hard-fails on anything the runner would silently drop or misclassify:
 *
 * - the file must parse as a JSON array;
 * - every entry: known `suite`, existing repo-relative `file`, non-empty
 *   `test`, non-empty `reason`, and a real `since` date (YYYY-MM-DD, not in
 *   the future);
 * - entries older than `QUARANTINE_REMINDER_DAYS` produce a reminder line —
 *   never a violation.
 */
export function validateQuarantineList(raw: string, root: string, today: string): QuarantineReport {
	const location = (label: string): string =>
		label === "" ? "scripts/test-quarantine.json" : `scripts/test-quarantine.json ${label}`;
	const violation = (rule: string, entryLabel: string, text: string, hint: string): QuarantineViolation => ({
		rule,
		location: location(entryLabel),
		text,
		hint,
	});

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error: unknown) {
		return {
			violations: [violation(
				"quarantine-json-unparsable",
				"",
				error instanceof Error ? error.message : String(error),
				"scripts/test-quarantine.json must be a JSON array of quarantine entries; a malformed list must never silently weaken the runner.",
			)],
			reminders: [],
		};
	}

	if (!Array.isArray(parsed)) {
		return {
			violations: [violation(
				"quarantine-not-array",
				"",
				`expected an array, got ${typeof parsed}`,
				"scripts/test-quarantine.json must be a JSON array of quarantine entries.",
			)],
			reminders: [],
		};
	}

	const todayMs = parseCalendarDate(today);
	const violations: QuarantineViolation[] = [];
	const reminders: string[] = [];

	parsed.forEach((value: unknown, index: number) => {
		const entryLabel = `entry #${index + 1}`;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			violations.push(violation(
				"quarantine-entry-not-object",
				entryLabel,
				textOf(value),
				"Every quarantine entry must be an object with suite/file/test/reason/since string fields.",
			));
			return;
		}
		const entry = value as Record<string, unknown>;

		const suite = typeof entry.suite === "string" ? entry.suite : "";
		const file = typeof entry.file === "string" ? entry.file : "";
		const testName = typeof entry.test === "string" ? entry.test : "";
		const reason = typeof entry.reason === "string" ? entry.reason : "";
		const since = typeof entry.since === "string" ? entry.since : "";

		if (typeof entry.suite !== "string" || !KNOWN_SUITE_SET.has(suite)) {
			violations.push(violation(
				"quarantine-unknown-suite",
				entryLabel,
				textOf(entry.suite),
				`Known suites: ${KNOWN_SUITES.join(", ")}`,
			));
		}

		if (typeof entry.file !== "string" || file.trim() === "" || !existsSync(join(root, file))) {
			violations.push(violation(
				"quarantine-missing-file",
				entryLabel,
				textOf(entry.file),
				"file must be a repo-relative path to an existing test file.",
			));
		}

		if (typeof entry.test !== "string" || testName.trim() === "") {
			violations.push(violation(
				"quarantine-empty-test",
				entryLabel,
				textOf(entry.test),
				"test must be the full console `(fail)` name — describe path outermost-first, leaf last.",
			));
		}

		if (typeof entry.reason !== "string" || reason.trim() === "") {
			violations.push(violation(
				"quarantine-empty-reason",
				entryLabel,
				textOf(entry.reason),
				"reason must link the tracking report step that owns the debt.",
			));
		}

		const sinceMs = parseCalendarDate(since);
		if (sinceMs === null) {
			violations.push(violation(
				"quarantine-bad-since",
				entryLabel,
				textOf(entry.since),
				"since must be a valid YYYY-MM-DD calendar date.",
			));
		} else if (todayMs === null) {
			// `today` is malformed (never in production) — cannot judge age/future.
		} else if (sinceMs > todayMs) {
			violations.push(violation(
				"quarantine-future-since",
				entryLabel,
				textOf(entry.since),
				"since must not be in the future.",
			));
		} else if (
			typeof entry.suite === "string"
			&& KNOWN_SUITE_SET.has(suite)
			&& typeof entry.test === "string"
			&& testName.trim() !== ""
		) {
			const days = daysBetween(sinceMs, todayMs);
			if (days > QUARANTINE_REMINDER_DAYS) {
				reminders.push(`quarantined since ${since} (${days} days): ${suite} ${testName}`);
			}
		}
	});

	return { violations, reminders };
}

/**
 * Appends reminder lines to the CI job summary when `GITHUB_STEP_SUMMARY`
 * points at it. Best-effort: the summary is visibility, not the verdict, so a
 * write failure is logged and never fails the guard.
 */
export function writeReminderLines(reminders: readonly string[], stepSummaryPath: string | undefined): void {
	if (stepSummaryPath === undefined || stepSummaryPath.trim() === "" || reminders.length === 0) return;
	try {
		appendFileSync(stepSummaryPath, `${reminders.join("\n")}\n`);
	} catch (error: unknown) {
		console.warn(`test:hygiene: could not append quarantine reminders to GITHUB_STEP_SUMMARY (${stepSummaryPath}): ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function formatReport(report: GuardReport, quarantine: QuarantineReport = { violations: [], reminders: [] }): string {
	const lines: string[] = [];
	const allViolations = [...report.violations, ...quarantine.violations];
	if (allViolations.length > 0 || report.budgetBreaches.length > 0) {
		lines.push(`Hygiene: FAIL (${report.files} test files scanned)`);
		for (const v of report.violations) {
			lines.push(`  [${v.rule}] ${v.file}:${v.line}`);
			lines.push(`    ${v.text}`);
			lines.push(`    → ${v.hint}`);
		}
		for (const q of quarantine.violations) {
			lines.push(`  [${q.rule}] ${q.location}`);
			lines.push(`    ${q.text}`);
			lines.push(`    → ${q.hint}`);
		}
		for (const b of report.budgetBreaches) lines.push(`  [budget] ${b}`);
	} else {
		lines.push(`Hygiene: OK (${report.files} test files, all rules green)`);
	}
	lines.push(
		`  budgets: as-never ${report.totals.asNever}/${BUDGETS.asNever}, screen ${report.totals.screen}/${BUDGETS.screen}, innerHTML ${report.totals.innerHTMLEmpty}/${BUDGETS.innerHTMLEmpty}, sleeps>200ms ${report.totals.longSleeps}/${BUDGETS.longSleeps}`,
	);
	for (const reminder of quarantine.reminders) {
		lines.push(`  ${reminder}`);
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const report = runGuard(collectTestFiles(), (file) => readFileSync(join(repoRoot, file), "utf8"));
	const quarantine = validateQuarantineList(
		readFileSync(QUARANTINE_LIST_PATH, "utf8"),
		repoRoot,
		utcToday(),
	);
	console.log(formatReport(report, quarantine));
	writeReminderLines(quarantine.reminders, process.env.GITHUB_STEP_SUMMARY);
	if (
		report.violations.length > 0
		|| report.budgetBreaches.length > 0
		|| quarantine.violations.length > 0
	) process.exit(1);
}
