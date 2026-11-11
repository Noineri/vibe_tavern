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
import { QUARANTINE_LIST_PATH, utcToday, validateQuarantineList, writeReminderLines, type QuarantineReport } from "./test-hygiene-quarantine.js";
export { KNOWN_SUITES, validateQuarantineList, writeReminderLines, type QuarantineViolation, type QuarantineReport } from "./test-hygiene-quarantine.js";

const repoRoot = join(import.meta.dir, "..");

/**
 * RATCHET BUDGETS — snapshot of the tree on 2026-09-12.
 * Lower these after cleanups; never raise them. If a new test legitimately
 * needs to grow one of these, that is a conversation (the guard's whole point
 * is that growth is a visible, deliberate act, not drift).
 */
export const BUDGETS = {
	/** `as never` casts in test files (TS-7b class; blanket rewrite wontfix). */
	// Full historical trail (1243 -> 29, steps 6a-15f): moved
	// byte-identically to scripts/test-hygiene-budget-log.ts (extracted
	// 2026-11-11 per the file-size ratchet's extract-only law). The
	// LATEST entry stays directly below; new entries append above the
	// value line as always.
	// 0 (2026-11-11, step 16): −2 — the two packages survivors, wave D's
	// FINAL batch: **WAVE D CLOSES, the as-never category EXTINCT repo-wide —
	// ratchet 1243 → 0 (every earlier step in
	// scripts/test-hygiene-budget-log.ts; the closing re-query prints 0 over
	// all 1281 test files).** THE SHAPES: prompt-preset-schema.test.ts — the
	// hostile-depth pin's cast was PURE NOISE, deleted: the withDepth
	// literal goes straight into createPromptPresetSchema.safeParse whose
	// parameter is `data: unknown` (zod 4.6.7 classic/schemas.d.ts:27) and
	// the helper already took `depth: unknown`, so the cast erased nothing
	// the compiler could have flagged; the hostile VALUES stay hostile
	// (null / undefined / 5 / "5" flow unchanged) and the pin still
	// rejects "5"; the member stays `.number().nullable().optional()`
	// (prompt-preset-schema.ts:56). image-prompt-profile-store.test.ts —
	// the JSON.parse hostile blob narrows to the REAL member type (the
	// idiomatic specific-type cast from any): `as ImagePromptOverridesInput`
	// — the store's own boundary input (image-prompt-profile-store.ts:27,
	// the CreateImagePromptProfileData .overrides param at :15,
	// serializeOverrides re-validating at :58-67); the hostile blob is
	// byte-identical (unknown keys, a flat-string payload, qualityText 42)
	// and the pin (store sanitizes to {}) is unchanged. The stale "stays
	// budgeted" comment reworded with the pattern — the one non-code
	// site. The type rides the store module's EXISTING export (inline
	// `type` member on the import — no new builder file; the cluster's
	// character-store.test.ts idiom). packages key-level tsc deltas EMPTY
	// before and after (the 15e/15f method adapted; the honest BEFORE
	// captured at the clean base commit 0d9e1efd1): the api-contracts test
	// file rides its workspace's MAIN tsconfig, whose include carries
	// test/** — 0 diagnostics at the base commit and after; the db test
	// file rides packages/db/tsconfig.test.json — 193 diagnostics / 68
	// unique keys at the base commit and after, all pre-existing
	// branded-ID assert-seam debt, untouched; 852 keys byte-untouched. The
	// two per-file spot runs carry identical counts before and after (25/0
	// and 8/0, 0 fail). One commit with the budget.
	// 2 (2026-11-11, step 15g): −27 — the stores/lib batch, the LAST apps/web
	// batch, closes apps/web at zero: the eleven files 7/4/3/2/2/2/2/2/1/1/1
	// (gallery-store, chat-selectors, message-meta-registry,
	// chat-mode-registry, context-preview-store, experience-kernel-frame,
	// experience-sdk-diag, experience-sdk-loop, trace-history-store,
	// prompt-canvas-summary, tts/narration-cache). The repo remainder is
	// packages 2 (step 16). THE SHAPES: gallery-store — the makeAsset fixture
	// brands id/characterId through brandId<CharacterAssetId> /
	// brandId<CharacterId> (character-asset.ts:13) and its createdAt cast
	// dies (Timestamp is a plain string alias, entities.ts:80); the
	// upload/update default mocks resolve makeAsset("uploaded") /
	// makeAsset("updated") instead of an erased undefined — no test
	// exercises the upload/update SUCCESS resolve paths (updateCaption's
	// only test rejects the mock, and nothing calls upload), so nothing
	// reads the resolved rows and the file's own single fixture is the
	// honest default (the function declaration hoists above the
	// module-level mock block that now references it). chat-selectors — the
	// four snapshot slices complete through the EXISTING wireChat/wireBranch
	// builders (wire-fixtures.ts:508/494, consumed unmodified — no new
	// builder file; the store's activeChat/activeBranch slots and the
	// selection predicate read .id only). message-meta-registry — the ctx()
	// variant brands MessageVariantId/MessageId (MessageVariant is domain
	// entities.ts:2267) and its createdAt cast dies (same Timestamp fact).
	// chat-mode-registry — both casts PURE DELETIONS: "novel"/"group" ARE
	// ChatMode members (platform-constants.ts:123-128) and the parameter
	// already takes ChatMode | undefined | null (chat-mode-registry.ts:104).
	// Both chat-api mock fallbacks brand AT THE SEAM — brandId<ChatId> (+
	// brandId<ChatBranchId> for the preview) where the test's plain-string
	// FetchImpl hands off to the real fetchContextPreview/fetchTraceHistory
	// (chat-api.ts:774/757); trace-history already imported brandId,
	// context-preview gains the import. experience-sdk-diag/loop — the four
	// fakeWindow casts PURE DELETIONS: the literal feeds an untyped
	// new Function("window", …) eval and nothing constrains it.
	// prompt-canvas-summary — the dep mock returns the records array
	// directly (SummarySourceRecord IS the dep's element type, derived from
	// PromptCanvasSummaryLoadDeps["listChatSummaries"]). narration-cache —
	// the indexedDB restore drops its cast (unknown slot, unknown captured
	// value). experience-kernel-frame — the two negative pins swap the
	// double-erased payloads for type-valid RUNTIME-REJECTED values that
	// mirror the server suite's own fixtures: the invalid-viewer pin takes
	// { kind: "observer", participantId: "p1" } (the viewer schema's
	// superRefine rejects an observer carrying a participantId,
	// interactive-schema.ts:268-274; the server fixture at
	// experience-kernel.test.ts:313) and the illegal-action pin takes
	// { type: "", requestId: "r1", expectedRevision: 0 } (boundedId min 1
	// char fails safeParse while the ExperienceAction interface's bare
	// string accepts it — interactive-schema.ts:93/297; the counter
	// reducer's unknown-type fallthrough returns a VALID transition, so the
	// pinned illegal_action can only come from the schema boundary — the
	// same mechanism the erased literal hit). apps/web key-level tsc delta
	// EMPTY before and after on the MAIN workspace config (the 15e/15f
	// method): 0 diagnostics at the base commit and after; 852
	// byte-untouched. The eleven per-file spot runs carry identical counts
	// before and after (8/6/5/11/7/38/4/10/8/4/7, 0 fail). One commit with
	// the budget.
	// 29 (2026-11-11, step 15f): −39 — the build/experience/layout batch, the
	// nine files 18/8/3/3/2/2/1/1/1 (ObjectiveConfig, trace-payload-view,
	// TopBar.narrate, ScriptEditor, ExperienceAssignment, ExperienceSetupModal,
	// CharacterForm, SceneHistoryBackfill, SetupWizard.fields). The repo
	// remainder is apps/web 27 (a stores/lib cluster) + packages 2. THE SHAPES:
	// ObjectiveConfig — all 17 "chat_1" props take the file's own CHAT_ID
	// (brandId<ChatId>, already imported) and the switch-chats rerender brands
	// its "chat_2" inline; pure value substitution, zero shape change (the
	// prop is the branded ChatId, ObjectiveConfig.tsx:60 supervisor-verified).
	// trace-payload-view — all 8 casts PURE DELETIONS: the fixtures already
	// satisfy AssemblePromptResponse as written (the layer() helper returns a
	// complete PromptLayerDto; finalPayload is Record<string, unknown> so the
	// message rows carry no member constraint; domain api-types.ts:26).
	// TopBar.narrate — the two createElement(TopBar, { update: null }) casts
	// PURE DELETIONS (every TopBarProps member is optional, TopBar.tsx:27);
	// the profile row completes through the EXISTING wireTtsProfile builder
	// (wire-fixtures.ts:178, consumed unmodified — no new builder file) with
	// currentData retyped to the real VoiceMapData (voice-map-data.ts:5).
	// ScriptEditor — the three create/update/import default mocks resolve
	// Promise<ScriptRecord>(wireScript()) instead of an erased undefined
	// (wireScript already imported; beforeEach re-seeds all three before any
	// test, and production reads .id off every resolved record,
	// ScriptEditor.tsx:326/340/432, so the honest default is the safe one).
	// ExperienceAssignment + ExperienceSetupModal — the listPersonas mocks:
	// the two empty-array casts PURE DELETIONS (the untyped mock()'s
	// ResolveType accepts the array), the partial {id, name} rows completed
	// through wirePersona (wire-fixtures.ts:454) — both components read
	// id/name only (ExperienceSetupModal.tsx:313, ExperienceAssignment.tsx:188).
	// CharacterForm — the Harness useForm types BuildCharacterDraft and seeds
	// the canonical EMPTY_BUILD_DRAFT (character-draft.ts:52 — the file
	// header's own one-place seed law) spread with the alternateGreetings pin;
	// the old 6-field literal was missing 10 required draft members.
	// SceneHistoryBackfill — the tracker literal gains the REQUIRED
	// rulesPrompt: "" (entities.ts:2554) and drops its cast (schema {} fits
	// the Record SceneTrackerDsl). SetupWizard.fields — the bootstrap seed is
	// a real BootstrapData: the NONEXISTENT personas member dropped (the
	// 15d/15e fiction class — it lives on BootstrapState, set separately in
	// the same seed, and the wizard reads s.personas, never data.personas),
	// the REQUIRED agentKindSettings added, uiSettings spreads wireUiSettings
	// and keeps the githubStarred pin the wizard's first-run banner reads
	// (SetupWizard.tsx:43). apps/web key-level tsc delta EMPTY before and
	// after, measured on the MAIN workspace config (the 15e method: the
	// src/** include carries the collocated tests; tsconfig.test.json covers
	// apps/web/test/** only): 0 diagnostics at the base commit and after, 0
	// new keys; 852 byte-untouched. The nine per-file spot runs carry
	// identical counts before and after (23/13/2/36/29/68/7/14/6, 0 fail).
	// One commit with the test edits.
	asNever: 0,
	/** Global `screen.` usage in apps/web test files (binds at import time). */
	// 196 (2026-10-04): ratcheted to the merged tree's count after PR #51
	// (provider-lists unification removed the forked pickers' screen usage;
	// 2026-10-09 regex remediation removed the rest — locked at 156).
	// Ratcheted to the current tree's count.
	// 65 (2026-11-11): step 18a — the screen sweep opener. ALL 73 sites in
	// apps/web/src/components/chat/MessageAiEditorModal.test.tsx (the single
	// monster holder; live scanFile: 73 before, 0 after) now query through
	// each test's own render() return (the R7 dom-env contract): 34 bare
	// renderModal() call sites gained per-test destructures, the 10
	// already-destructured tests stay (two gained findByText for their
	// helper calls), the three query helpers take the caller's findByText
	// (generateWithPrompt / switchToAnnotate / generateAnnotate, typed
	// ModalView["findByText"]), mergeRow keeps its existing { getByText }
	// seam, and the `screen` binding is dropped from the dynamic RTL import.
	// Same boundary: the render-returned queries are bound to
	// baseElement = document.body (@testing-library/react pure.js:239) —
	// the element the modal portals to — so queries, asserts and behavior
	// are unchanged (expect() source count 165 → 165; per-file run 45 pass /
	// 0 fail / 169 expect() calls before and after; act warnings 44 both
	// sides; the one remaining bare renderModal() queries nothing — it
	// drives document.body.querySelectorAll directly). 138 → 65 = 138 − 73
	// exactly. 12 holder files remain (RegexPresetEditor 25, AiAssistantModal
	// 16, TtsProfileEditor 7, BoundResourcesField 5, StarPromptModal 4,
	// TtsBaseCard 2, and the six 1-site files).
	screen: 65,
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
const STATIC_RTL_IMPORT = /^[ \t]*import(?!\s+type\b)\s+(?:[^;]*?\s+from\s+)?["']@testing-library\/react["'][ \t]*;/gm;

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


