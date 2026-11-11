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
	// 1246 (2026-10-11, PM-7): +3 — the restored-as-was todo describe in
	// experience-copilot-tools.test.ts carries the same three `as never`
	// result casts PM-6 deleted with the mechanic (deliberate growth, not
	// drift — the restore mandate forbids rewriting the old tests).
	// 1243 (2026-10-12, PM-7 fixup, owner ruling): those 3 casts were
	// eliminated — the todo results are typed as the seam's exported
	// ExperienceCopilotTodoResult — and the ratchet lowered back; the
	// ratchet exists to go DOWN.
	// 1246 (2026-10-12, CPF-2b): +3 — continue-fallback integration tests
	// (live-chat-continue-fallback.test.ts): (a) the chatRuntime DI stub for
	// the LiveChatOrchestrator constructor (ChatRuntime is nominal — private
	// deps — the same cast the existing live-chat-continue.test.ts harness
	// uses), (b) the ChatRuntimeDeps object for the real-ChatRuntime
	// attribution tests (members are nominal store classes; one whole-object
	// cast instead of a dozen), (c) one shared `UNSET` for the two
	// required-but-unused ctor deps. Minimized from 22 raw harness casts
	// (real RpModeStrategy instead of a stub, real executor types for the DI
	// stub, `satisfies` for the trace literal). Lower when the nominal DI
	// boundaries become structural.
	// 1245 (2026-10-15, RO-5): unused casts removed; ratchet lowered to match.
	// 1244 (2026-10-21, SC-11): one insights scene-harness stub typed — SC-11
	// reached 1246 mid-unit, paid back to 1244 at commit (SC-10's HEAD was
	// green at exactly 1245/1245).
	// 1245 (2026-10-26, DR-3a): +1 — story-plan-sync.test.ts constructs
	// ObjectiveService twice (main pair + the observer-failure case) with two
	// unused ctor deps (SessionRuntime/ProviderProfileService — no path under
	// test touches them); minimized to ONE shared `unusedObjectiveDeps` cast
	// from 4 raw `null as never`s. Lower when the ctor deps become optional
	// or the DI boundary becomes structural.
	// 1243 (2026-11-07, DK-4a): the suites' ObjectiveService unused-deps casts
	// consolidated into ONE shared fixture (test/objective-service-fixture.ts —
	// the guard counts *.test.ts files only); ratchet lowered to match (owner
	// ruling: a unit that lowers a count locks the lower budget in the same
	// commit — the DR-3a minimization extended across suites).
	// 1240 (2026-11-09, TYPE-SAFETY sweep 6f): 3 `as never` sites died WITH
	// their erased constructs (regex-assist's fakeRouter activation pair,
	// st-directory-scanner's realAssemble narrowing) when the batch replaced
	// the erasures with typed doubles — re-adding dead casts to hold the
	// number contradicts the ratchet's direction. The worker's packet barred
	// budget edits, so the supervisor locks the lower budget in the immediate
	// follow-up commit.
	// 1238 (2026-11-09, TYPE-SAFETY sweep 7b): 2 `as never` sites died WITH
	// their erased seed-tracker literals (message-edit-coordination +
	// scene-zone — normalizeInsightsConfig accepts the literal cast-free);
	// same law, same supervisor follow-up commit.
	// 1235 (2026-11-10, TYPE-SAFETY sweep 7g): 3 `as never` sites died WITH
	// their erased constructs in TopBar.narrate.test.tsx (TooltipProvider /
	// Popover.Root probe arms + the erased fetch install — the batch replaced
	// the probes with direct typed package exports); same law, same
	// supervisor follow-up commit.
	// 1227 (2026-11-10, TYPE-SAFETY sweep 8a): 8 `as never` sites died WITH
	// their erased constructs — 3 in chat-selectors.test.ts makeTrace and 5 in
	// trace-history-store.test.ts makeTrace (both trace DTOs completed to the
	// real PromptTraceRecordDto with brandId'd ids, killing the member-level
	// never-spells); same law, same supervisor follow-up commit.
	// 1056 (2026-11-11, TYPE-SAFETY wave D step 14a): objective-service.test.ts
	// zeroed — all 171 sites died WITH their erased constructs: ctor null seams
	// → the shared unusedObjectiveDeps token; fake executes/resolvePrompts →
	// ConstructorParameters<typeof ObjectiveService> seam types + real
	// GenerationResult results; "chat_1" ids → brandId<ChatId>;
	// sessionRuntime/providerProfiles doubles → makeSessionRuntime /
	// strictTestDouble with complete makeProviderProfileRow records (the
	// insights-test-builders SessionRuntimeFixture input widened with the real
	// buildPipelineContext branchId member). One commit with the test edits.
	// 979 (2026-11-11, TYPE-SAFETY wave D step 14b): the coauthor cluster
	// zeroed — all 77 sites died WITH their erased constructs
	// (coauthor-tools 45, coauthor-prompt 28, skill-read-tool 2, lore-model 1,
	// chat-api 1): the tool-call context fakes (a nonexistent `abort` member,
	// `context` missing) → the REAL AI SDK ToolExecutionOptions via ONE
	// makeToolContext helper / typed literals; result-side never-spells → the
	// ToolSet execute return (the script-agent-tools precedent); message-row
	// literals → the standing makeMessageRow builder (prompt bytes pinned
	// unchanged by the file's own sha256 test); branded ids → brandId;
	// `rows.slice(-limit) as never[]` → typed rows; promptService {} →
	// strictTestDouble<PromptAssemblyService>; listCoauthorChats/prepareLiveTurn
	// ids → brandId<CharacterId>/<ChatId>. One commit with the test edits.
	// 928 (2026-11-11, TYPE-SAFETY wave D step 14c): the copilot cluster
	// zeroed — all 51 sites died WITH their erased constructs (compaction 30,
	// copilot-tools 19, agent-plan-tools 1, stream 1): the compaction ctor
	// pairs were pure deletions (makeProviderProfilesFixture already returns
	// the ctor's ProviderProfileService; makeExecutor's execute already matches
	// typeof nonstreamingProviderExecute — the cast-free SC-8a block proved
	// both), the dedupe gate now resolves a REAL GenerationResult (the old
	// `{ text }` was 14a's fiction class); copilot-tools' file-local ctx fake
	// (the 14b fiction: nonexistent `abort`, missing required `context`) →
	// makeToolContext + executeTool<O> with per-tool real output types — the
	// seam PROMOTED to provider-boundary-test-builders.ts (one derivation, 3+
	// consumers: coauthor-tools imports it now too, its 81 tests re-run
	// unchanged); agent-plan-tools ctx → makeToolContext (execute sites left —
	// their possibly-undefined keys are baselined debt, untouched); stream's
	// single site was noise (the request type allows the mode-less input the
	// AP-9 guard rejects at runtime). One commit with the test edits.
	// 861 (2026-11-11, TYPE-SAFETY wave D step 14d): the tracker/scene cluster
	// zeroed — all 67 sites died WITH their erased constructs
	// (scene-cache-lifecycle 23, tracker-service 17, tracker-backfill 14,
	// tracker-coordinator 13): the 23 rebuildCurrentSceneCache casts died by
	// typing the harness variables (chatId: ChatId / branchId: ChatBranchId)
	// with brandId at the DB→test read boundary; SceneTarget literals →
	// brandId<ChatId>/<ChatBranchId>/<MessageId>/<MessageVariantId>;
	// SceneTrackerService ctor null-pairs → the standing unusedObjectiveDeps
	// token; sessionRuntime fragments → the standing makeSessionRuntime (its
	// fixture gained the REAL throughMessageId input member — the 14a
	// branchId-extension precedent — so the SCN-14 freeze pins keep their
	// captures); providerProfiles fragments → strictTestDouble<ProviderProfileService>
	// over makeProviderProfileRow rows; `{ text }` fakes → the shared
	// execResult builder (promoted to insights-test-builders.ts, fork #1 of
	// objective-service.test.ts's 14a original). One commit with the test edits.
	// 776 (2026-11-11, TYPE-SAFETY wave D step 14e): the experience spread
	// zeroed — all 85 sites died WITH their erased constructs
	// (model-effect-service 23, context-service 17, timer-scheduler 16,
	// timer-effect-service 6, round-service 5, replay-service 4, service 4,
	// resource-service 3, routes 3, playground 2, chatter-service 1,
	// effect-retry 1): the Aria/Olya/Rules store-create fragments died as
	// PURE DELETIONS (the literals already satisfy CreateCharacterData /
	// CreatePersonaData / CreateScriptData — the 14c compaction lesson);
	// createChat fragments completed with the REAL required member
	// `promptPresetId: null` (column default, runtime-identical — this also
	// killed the 10 live TS2741 CreateChatInput baseline errors); the
	// capabilityGrants casts died by typing GRANTS/seed params as
	// ExperienceCapability[]; `"openai"`/`"off"` profile members → real
	// CoauthorTransport/ProviderProxyMode values ("chat_completions" /
	// "inherit" — the store defaults; neither is read on the exercised
	// paths); execute/executeStructured doubles typed via
	// typeof nonstreamingProviderExecute + ExperienceModelEffectServiceDeps
	// and returning the shared execResult shape (the `{ text }` fiction);
	// the per-model getProviderModelSettings fake completed to a REAL
	// ProviderModelSettingsRecord; resource-service's hostile
	// "not_a_real_capability" re-cast as ExperienceCapability pinning the
	// isValidCapability runtime guard (the 14a agent-kind-registry
	// precedent); playground's comment mention reworded so the content-level
	// scanner regex no longer counts it. One commit with the test edits.
	// 722 (2026-11-11, TYPE-SAFETY wave D step 14f): the imports + stt/tts
	// clusters zeroed — all 54 sites died WITH their erased constructs
	// (import-batch 8, import-lean 8, import-vtf-monolith 8,
	// import-chat-swipe-selection 3, stt-routes 9, the four stt-backend-*
	// files 3 each, tts-adapter-voices 2, tts-narration-library 2,
	// tts-routes 2): importer mocks typed against makeImportExportDeps' real
	// fixture types — create/writeEntity/seedImportedOpening returns were
	// already honest (pure deletions), update returns a real makeCharacterRow
	// row, getSnapshot → makeSessionSnapshot, createChat ids and the default
	// resolvers → brandId<ChatId>/<PersonaId>/<PromptPresetId>; stt-routes
	// providers.create dropped the dead isDefault member (CreateProviderData
	// never carried one — the store ignores it and auto-key matches on
	// endpoint+apiKey only) and its tts.create literals completed to
	// CreateTtsProfileData with the tts_profiles column defaults
	// (runtime-identical), while the "openai-compatible"/"gemini" backend
	// slugs and stt.create (sortOrder is store-generated) were pure
	// deletions; the four stt-backend-* makeBackend helpers and
	// registry-slug tests carry ONE documented `as SttProfileConfig` each at
	// the ST-5a injected-key bag seam (production makes the same cast at
	// stt-adapter.ts:419 — parseConfig reads apiKey off the loose bag), and
	// their `{ model: "m" }` hostile pins died as deletions (a partial
	// config is a valid union member — the missing-key ConfigError is the
	// runtime guard under test); narration-library's pins died as deletions
	// (parseNarrationLibraryKey takes unknown; NarrationLibraryKey ids are
	// plain strings); tts-routes' addLink literals are the real TtsTargetType
	// members; tts-adapter-voices rebuilt the fake row as a real TtsProfile
	// (brandId edge) and the deps partial as strictTestDouble. One commit
	// with the test edits.
	// 679 (2026-11-11, TYPE-SAFETY wave D step 14g): the live-chat / sp5 /
	// dice clusters zeroed — all 43 sites died WITH their erased constructs
	// (live-chat-continue 13, live-chat-forward-state 8, sp5-service-prompts
	// 11, live-chat-continue-fallback 3, dice-send-stream-nonstream 8):
	// chatRuntime mocks → strictTestDouble<ChatRuntime> with the REAL member
	// returns (appendMessageVariant / buildMessageResponse completed with the
	// required promptTrace: null; appendAssistantReply a real
	// AppendedAssistantReply with brandId<ChatBranchId>/<MessageId>; prepare
	// snapshot → makeSessionSnapshot; assemblePromptPreview / assemblePrompt
	// completed to the full AssemblePromptResponse / ChatModeAssembleResult);
	// ctor null-triples (chatRuntime/chatApp/providers, never dereferenced on
	// the paths under test) → strictTestDouble tokens typed as the dep
	// intersections (objective-service-fixture.ts's unusedObjectiveDeps
	// semantics, file-local per the packet scope); strategy literals typed
	// ChatModeStrategy (mode + a throwing assemble added — the erased stub
	// lacked both required members); unexercised executor seam members →
	// a file-local throwing unusedExecutor (the fallback/dice precedent);
	// the CPF-2b whole-deps cast → strictTestDouble<ChatRuntimeDeps> with
	// completed store fragments (makeChatRow / makeVariantRow rows — the old
	// variant fragment carried isSelected: 1 and missed seven required
	// members) and the guarded-optional members the erased literals answered
	// with undefined now provided inert (peekPendingPresetName → null,
	// persistCoauthorReview → no-op — observable-identical); sp5 loaders →
	// the standing makeChatRow / makeCharacterRow rows (the erased character
	// literal carried NONEXISTENT members hasFileOnDisk / avatarCrop —
	// nothing reads them; assembleCoauthorPrompt reads only
	// chat.coauthorModuleId/activeBranchId and character.id) and its
	// promptService → strictTestDouble (grep-proven unread), chatId →
	// brandId<ChatId>, the copilot explicitProfile typed CopilotProfile with
	// the REQUIRED agentKind the cast omitted; dice's response-builder stubs
	// typed from ChatRuntimeDeps (getSnapshot → makeSessionSnapshot,
	// BranchResponse.activeBranch through the mapChatBranch funnel, chatOrder
	// a complete IChatOrder literal). test-type-gate stayed clean at 852
	// byte-untouched keys with zero new keys (no shrink — these casts
	// suppressed diagnostics, they never produced baselined ones). One commit
	// with the test edits.
	// 635 (2026-11-11, step 14h): −44 — the regex + insights + settings +
	// chat-mode clusters (44 sites / 7 files: regex-hooks 9 — one of them a
	// comment mention the word-bounded scanner counts, regex-reasoning 8,
	// regex-assist 2, insights-adapter 10, insights-feature 3,
	// settings-adapter 6, chat-mode-strategy 6). Session seams in the two RX
	// harnesses typed from ChatRuntimeDeps (makeSessionSnapshot; response
	// builders completed to the real contracts — MessageResponse's
	// promptTrace, BranchResponse through the mapChatBranch funnel — and a
	// complete IChatOrder for chatOrder, the dice harness shapes); the unused
	// ProviderOrchestrator ctor dep → strictTestDouble UNSET tokens;
	// regex-assist's resolveModel → the agent-suite LanguageModel stub and
	// the feature-mount runtime literal typed AiAssistantRuntimeApi (pure
	// noise: the literal already satisfied it); tracker doubles return real
	// SceneTrackerRecord rows; the InsightsAdapter objective slot →
	// makeObjectiveService({}) strict doubles (the file's own precedent);
	// insights-feature activates with a real bare Hono router (activate
	// reads only events); settings hostile inputs ride updateUiSettings's own
	// Record<string, unknown> parameter — pure deletions; chat-mode inputs
	// brand their ids, the unread promptService → strictTestDouble, the
	// resolveProvider profile → makeProviderProfileRow, and both assemble
	// inputs share a complete makeAssembleLoaders() (which also kills the
	// baselined loaders-missing TS2741 that the brandId edit would have
	// reworded). test-type-gate: exactly 1 dead key (that TS2741), 0 new
	// keys, 852 byte-untouched. One commit with the test edits.
	asNever: 635,
	/** Global `screen.` usage in apps/web test files (binds at import time). */
	// 196 (2026-10-04): ratcheted to the merged tree's count after PR #51
	// (provider-lists unification removed the forked pickers' screen usage;
	// 2026-10-09 regex remediation removed the rest — locked at 156).
	// Ratcheted to the current tree's count.
	screen: 138,
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
