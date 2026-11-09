/**
 * Test-file typecheck ratchet gate.
 *
 * WHY THIS GATE EXISTS (step 17 of TYPE_SAFETY_CAST_DEBT_REPORT.md, owner
 * approved 2026-11-09): NO repo gate typechecked the test files. Every
 * workspace tsconfig included only `src/**`, and `bun test` transpiles
 * without checking — so a test file could carry any type error at all and
 * still run, land, and rot (the 6a FACT). The sweep's step-6 batches fixed
 * their own sites with ad-hoc %TEMP% tsconfigs; this gate is that check,
 * mechanized and permanent, so the later waves (7-9, C, D) inherit the
 * enforcement mechanically instead of re-deriving it per batch.
 *
 * Mechanics: runs `tsc --noEmit` once per workspace over a dedicated
 * `<workspace>/tsconfig.test.json` (each extends the workspace's OWN config,
 * so the lib pins — apps/web keeps DOM, services/api and packages/* keep the
 * no-DOM ESNext pin — and the path aliases stay exactly what production
 * compiles against). Diagnostics are diffed against
 * scripts/test-type-baseline.json (a sorted array of keys):
 *   - any NEW key fails `bun run typecheck` naming every new error,
 *   - existing debt shrinks one fix at a time (fix, then
 *     `bun scripts/test-type-gate.ts --update-baseline`; the diff must only
 *     ever shrink, or pair 1:1 as a genuine type change — review it),
 *   - the initial snapshot holds the pre-existing corpus (services/api alone
 *     carried ~2047; they are tracked debt, killed by the later waves).
 *
 * KEY FORMAT — `"<file>:<TSxxxx>:<message first line>"` — and why it is NOT
 * line-addressed: scripts/type-gate.ts keys on `file:line:col:category`, and
 * its 6d/6e/6f logs show the cost — when an import line moved, every error
 * below it shifted, and the supervisor had to hand-pair 5 pure line-shifts
 * among 63 baseline removals to prove the diff was churn, not debt. At
 * ~2.6k entries that pairing is unreviewable. A path+code+message key never
 * moves when lines shift, so a `--update-baseline` diff contains only real
 * type changes. The trade-off is deliberate: two identical errors in one
 * file collapse to one key (an undercount that still gates — the key fails
 * while either twin exists), and a message rewords exactly when the
 * underlying types change, which is precisely when a re-review is due.
 *
 * COVERAGE — the hole cannot silently reopen: every `*.test.ts(x)` under
 * packages/, services/, apps/ and scripts/ must match the `include` of one
 * of the configs below (the six test configs, plus the main configs that
 * already cover their test files: packages/api-contracts — src and test,
 * apps/web — src-collocated tests, scripts — top-level `*.ts`). The includes
 * are read live from those tsconfig files (JSONC comments stripped), so the
 * tsconfigs stay the single source of truth; an unregistered test file is a
 * hard failure telling you which config to add or extend.
 *
 * Already covered elsewhere (deliberately NOT duplicated by a test config):
 *   - packages/api-contracts: its MAIN tsconfig includes `test/**` — its
 *     tests are checked by the workspace's own `typecheck`.
 *   - apps/web: the ~600 `*.test.tsx` collocated in src/ are inside the main
 *     config's include — same story.
 *   - scripts/: scripts/tsconfig.json includes top-level `*.ts`, and
 *     `bunx tsc -p scripts/tsconfig.json` already runs in the typecheck
 *     chain — its 25 test files were never invisible.
 *
 * Usage:
 *   bun scripts/test-type-gate.ts                   # enforce (exit 1 on new errors)
 *   bun scripts/test-type-gate.ts --update-baseline # rewrite baseline to current
 *
 * Exit codes: 0 = clean / baseline updated; 1 = new violations, a tsc
 * crash, or an uncovered test file; 2 = usage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

// ─── Config ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.resolve(import.meta.dir, "test-type-baseline.json");

/**
 * One tsc program per workspace. Register EVERY new workspace with test
 * files here (create `<workspace>/tsconfig.test.json` extending the
 * workspace's own config, include its test tree) — the coverage probe below
 * fails until you do.
 */
const TEST_TSCONFIGS = [
	"packages/domain/tsconfig.test.json",
	"packages/db/tsconfig.test.json",
	"packages/import-export/tsconfig.test.json",
	"packages/prompt-pipeline/tsconfig.test.json",
	"services/api/tsconfig.test.json",
	"apps/web/tsconfig.test.json",
];

/**
 * MAIN tsconfigs whose `include` already covers test files. Their patterns
 * join the coverage probe's allowed set so files they cover are not
 * demanded of this gate; read live, so an include change here is the same
 * change the coverage probe sees.
 */
const COVERING_MAIN_TSCONFIGS = [
	"packages/api-contracts/tsconfig.json",
	"apps/web/tsconfig.json",
	"scripts/tsconfig.json",
];

/** Trees scanned for stray test files (mirrors type-gate.ts's scope). */
const COVERAGE_SCAN_ROOTS = ["packages", "services", "apps", "scripts"];

const EXCLUDE_DIR_PARTS = ["node_modules", "/dist/", "/out/", "/services/api/scripts/"];

interface Diagnostic {
	/** Repo-relative path with forward slashes, exactly as tsc printed it. */
	file: string;
	code: string;
	/** First line of the tsc message (multi-line continuations are dropped). */
	message: string;
}

interface WorkspaceRun {
	config: string;
	workspace: string;
	diagnostics: Diagnostic[];
	/** Signal-killed, or exited nonzero with no parseable diagnostics. */
	crashed: boolean;
	rawTail: string;
	durationMs: number;
}

const toKey = (d: Diagnostic): string => `${d.file}:${d.code}:${d.message}`;

// ─── tsconfig include parsing (JSONC) ─────────────────────────────────────

/** Strip `//` and `/* * /` comments outside string literals. tsconfigs in
 *  this repo carry `//` comments; JSON.parse rejects them. */
function stripJsoncComments(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (inString) {
			out += ch;
			if (ch === "\\" && i + 1 < text.length) {
				i++;
				out += text.charAt(i);
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && text.charAt(i + 1) === "/") {
			while (i < text.length && text.charAt(i) !== "\n") i++;
			out += "\n";
			continue;
		}
		if (ch === "/" && text.charAt(i + 1) === "*") {
			i += 2;
			while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i++;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

interface TsconfigInclude {
	configDir: string;
	patterns: string[];
}

/** Read a tsconfig's `include` patterns, resolved relative to its own dir. */
function readIncludes(configRel: string): TsconfigInclude {
	const abs = path.resolve(ROOT, configRel);
	const parsed: { include?: string[] } = JSON.parse(stripJsoncComments(fs.readFileSync(abs, "utf8")));
	const patterns = parsed.include ?? [];
	return { configDir: path.dirname(abs), patterns };
}

// ─── Coverage probe ────────────────────────────────────────────────────────

/** Every committed `*.test.ts(x)` under the scan roots, repo-relative. */
function collectTestFiles(): string[] {
	const files: string[] = [];
	for (const root of COVERAGE_SCAN_ROOTS) {
		const cwd = path.resolve(ROOT, root);
		if (!fs.existsSync(cwd)) continue;
		const prefix = root.split(path.sep).join("/") + "/";
		for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
			for (const abs of new Bun.Glob(pattern).scanSync({ cwd, absolute: true })) {
				const norm = abs.split(path.sep).join("/");
				if (EXCLUDE_DIR_PARTS.some((part) => norm.includes(part))) continue;
				files.push(norm.slice(norm.indexOf(prefix)));
			}
		}
	}
	return files.sort();
}

/** All include-glob sources (test configs + covering main configs). */
function allIncludeSources(): TsconfigInclude[] {
	return [...TEST_TSCONFIGS, ...COVERING_MAIN_TSCONFIGS].map((config) => readIncludes(config));
}

/**
 * The mechanized 6a FACT: a test file that no known include covers is a hole
 * in the law — bun will happily run it unchecked forever. Returns the stray
 * files (empty = fully covered).
 */
function uncoveredTestFiles(sources: readonly TsconfigInclude[]): string[] {
	const strays: string[] = [];
	for (const file of collectTestFiles()) {
		const covered = sources.some((source) => {
			const relToConfig = path.relative(source.configDir, path.resolve(ROOT, file)).split(path.sep).join("/");
			if (relToConfig.startsWith("..")) return false;
			return source.patterns.some((pattern) => new Bun.Glob(pattern).match(relToConfig));
		});
		if (!covered) strays.push(file);
	}
	return strays;
}

// ─── Running tsc ───────────────────────────────────────────────────────────

// `apps/web/src/api/agent-run-api.ts(23,3): error TS2322: message...` — the
// file part cannot contain "(", so the lazy prefix is unambiguous. The
// line/col position is deliberately NOT captured: keys are shift-immune.
const DIAGNOSTIC_LINE = /^(.+)\(\d+,\d+\): error (TS\d+): (.*)$/;

function parseDiagnostics(output: string): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const line of output.split("\n")) {
		const m = DIAGNOSTIC_LINE.exec(line);
		if (m === null) continue;
		out.push({
			file: m[1]!.split(path.sep).join("/"),
			code: m[2]!,
			message: m[3]!.trimEnd(),
		});
	}
	return out;
}

function workspaceName(configRel: string): string {
	return path.dirname(configRel).split(path.sep).join("/");
}

function runWorkspace(configRel: string): WorkspaceRun {
	const started = Date.now();
	const proc = Bun.spawnSync([process.execPath, "x", "tsc", "--noEmit", "--pretty", "false", "-p", path.resolve(ROOT, configRel)], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const raw = proc.stdout.toString() + proc.stderr.toString();
	const diagnostics = parseDiagnostics(raw);
	// Exit-code VALUES are not trusted: measured on this tree, TS 7's tsgo
	// exits 2 when diagnostics were found and 0 when clean (classic tsc used
	// 1 for errors — a compiler major can change it again). A run counts as
	// crashed only when it was killed by a signal (exitCode null) or exited
	// nonzero with NOTHING parseable. A crash must never be read as "fewer
	// errors" — that would fake a ratchet shrink.
	const crashed = proc.exitCode === null || (proc.exitCode !== 0 && diagnostics.length === 0);
	return {
		config: configRel,
		workspace: workspaceName(configRel),
		diagnostics,
		crashed,
		rawTail: raw.split("\n").slice(-15).join("\n").trimEnd(),
		durationMs: Date.now() - started,
	};
}

// ─── Baseline ──────────────────────────────────────────────────────────────

async function loadBaseline(): Promise<Set<string>> {
	if (!fs.existsSync(BASELINE_PATH)) {
		console.error(`test-type-gate: no baseline found at ${path.relative(ROOT, BASELINE_PATH)}.`);
		console.error(`  This is expected on first run. Generate it with:`);
		console.error(`    bun scripts/test-type-gate.ts --update-baseline`);
		console.error(`  then commit the generated file.`);
		process.exit(1);
	}
	try {
		const data: unknown = JSON.parse(await Bun.file(BASELINE_PATH).text());
		if (!Array.isArray(data)) throw new Error("baseline root is not an array");
		return new Set(data.map(String));
	} catch (err) {
		console.error(`test-type-gate: baseline at ${path.relative(ROOT, BASELINE_PATH)} is corrupt: ${(err as Error).message}`);
		console.error(`  run \`bun scripts/test-type-gate.ts --update-baseline\` to regenerate.`);
		process.exit(1);
	}
}

async function writeBaseline(keys: readonly string[]): Promise<void> {
	const sorted = Array.from(new Set(keys)).sort();
	await Bun.write(BASELINE_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

// ─── Gate ──────────────────────────────────────────────────────────────────

function formatNewErrors(fresh: readonly Diagnostic[]): string {
	const grouped = new Map<string, Diagnostic[]>();
	for (const d of fresh) {
		const list = grouped.get(d.file) ?? [];
		list.push(d);
		grouped.set(d.file, list);
	}
	const lines: string[] = [];
	for (const [file, list] of [...grouped.entries()].sort()) {
		lines.push(`  ${file}`);
		for (const d of list) lines.push(`    ${d.code}: ${d.message}`);
	}
	lines.push("");
	lines.push("Fix the types (prefer narrowing over suppression); if the debt is genuinely");
	lines.push("pre-existing-style, the ONLY sanctioned escape is a deliberate, reviewable");
	lines.push("re-baseline — never silent:");
	lines.push("    bun scripts/test-type-gate.ts --update-baseline   # review the diff before committing");
	return lines.join("\n");
}

interface GateOutcome {
	code: 0 | 1;
	total: number;
}

async function runGate(update: boolean): Promise<GateOutcome> {
	// Coverage first: the gate's value dies quietly if a test file escapes
	// every program it is supposed to be checked in.
	const sources = allIncludeSources();
	const strays = uncoveredTestFiles(sources);
	if (strays.length > 0) {
		console.error(`test-type-gate: ${strays.length} test file(s) not covered by any known tsconfig include — build aborted.`);
		for (const file of strays) console.error(`  ${file}`);
		console.error("");
		console.error("  Add/extend a <workspace>/tsconfig.test.json (extend the workspace's own");
		console.error("  config, include its test tree) and register it in TEST_TSCONFIGS at the");
		console.error("  top of scripts/test-type-gate.ts — or extend the covering main config.");
		return { code: 1, total: 0 };
	}

	const runs = TEST_TSCONFIGS.map((config) => runWorkspace(config));
	const all: Diagnostic[] = [];
	let crashed = false;
	for (const run of runs) {
		const secs = (run.durationMs / 1000).toFixed(1);
		console.log(`  ${run.workspace.padEnd(24)} ${run.diagnostics.length} error(s)  (${secs}s)`);
		if (run.crashed) {
			crashed = true;
			console.error(`test-type-gate: tsc failed with no parseable diagnostics for ${run.config}:`);
			console.error(run.rawTail);
		}
		all.push(...run.diagnostics);
	}
	const totalMs = runs.reduce((sum, run) => sum + run.durationMs, 0);
	if (crashed) return { code: 1, total: all.length };

	const currentKeys = new Set(all.map(toKey));

	if (update) {
		await writeBaseline(all.map(toKey));
		console.log(`test-type-gate: baseline rewritten → ${currentKeys.size} key(s) across ${runs.length} workspace(s).`);
		console.log(`  Review the diff of ${path.relative(ROOT, BASELINE_PATH)} before committing.`);
		return { code: 0, total: all.length };
	}

	const baseline = await loadBaseline();
	// New = produced now, absent from baseline.
	const fresh = all.filter((d) => !baseline.has(toKey(d)));
	// Removed = in baseline, gone now (improvement — advisory only).
	const removed = [...baseline].filter((key) => !currentKeys.has(key));

	if (fresh.length === 0) {
		console.log(`test-type-gate: clean — ${all.length} error(s) across ${runs.length} workspace(s) all within baseline (${baseline.size} baseline key(s), identical twins deduped; ${(totalMs / 1000).toFixed(1)}s total tsc).`);
		if (removed.length > 0) {
			console.log(`test-type-gate: ${removed.length} baseline error(s) no longer present — nice.`);
			console.log(`  Shrink the debt by running: bun scripts/test-type-gate.ts --update-baseline`);
		}
		return { code: 0, total: all.length };
	}

	console.error(`test-type-gate: ${fresh.length} NEW test-file type error(s) detected — build aborted.\n`);
	console.error(formatNewErrors(fresh));
	return { code: 1, total: all.length };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	let update = false;
	try {
		const parsed = parseArgs({
			args: process.argv.slice(2),
			options: { "update-baseline": { type: "boolean" } },
			strict: true,
			allowPositionals: false,
		});
		update = parsed.values["update-baseline"] === true;
	} catch {
		console.error("usage: bun scripts/test-type-gate.ts [--update-baseline]");
		process.exit(2);
	}
	const outcome = await runGate(update);
	process.exit(outcome.code);
}

if (import.meta.main) {
	void main().catch((err) => {
		console.error("test-type-gate: unexpected error:", err);
		process.exit(1);
	});
}
