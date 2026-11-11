/**
 * The quarantine-file guard, extracted from test-hygiene.ts (2026-11-11,
 * supervisor maintenance): the hygiene script sat at 799 lines under the
 * arch gate's 800-line cap while its budget changelog keeps growing; this
 * block is self-contained (TH-8 fix steps 10.2/10.3). ZERO behavior
 * change - the code below moved byte-identically; test-hygiene.ts
 * re-exports the public names so existing importers are untouched.
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTestSuites } from "./test.js";

const repoRoot = join(import.meta.dir, "..");

/**
 * The quarantine list the runner reads (scripts/test-quarantine.ts,
 * TH-8 fix step 10.2). The runner fails CLOSED on a malformed list — it
 * silently degrades to an empty list rather than weakening the verdict — so a
 * malformed list is a HARD failure HERE, not a runner concern.
 */
export const QUARANTINE_LIST_PATH = join(repoRoot, "scripts", "test-quarantine.json");

/**
 * The quarantine entry `suite` field keys the orchestrator's suite names
 * (scripts/test.ts `createTestSuites()`). Derived, not hand-copied — one data
 * source, and a suite rename here is the SAME rename the runner already uses.
 */
export const KNOWN_SUITES: readonly string[] = [...new Set(createTestSuites().map((suite) => suite.name))];

const KNOWN_SUITE_SET: ReadonlySet<string> = new Set(KNOWN_SUITES);

/** Quarantine entries older than this many days print a reminder — never a failure. */
const QUARANTINE_REMINDER_DAYS = 30;

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
export function utcToday(): string {
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

