/**
 * Type-safety baseline gate.
 *
 * WHY THIS GATE EXISTS (owner ruling 2026-11-08 — binding):
 *   ALL code in this project is written by AI agents. A human's type cast
 *   usually carries, in its author's head, the knowledge of WHY it exists —
 *   but an agent's cast is limited by its context window, and once that
 *   context is gone NOBODY will ever know why the cast is there. A cast is an
 *   unexplained decision made under partial information, preserved forever —
 *   and the erasure shapes below (`as unknown as`, `as any`, `as never`) do
 *   not merely silence a compilation error, they erase it. This gate exists to
 *   make that class of decision impossible to add silently.
 *
 * A lightweight AST scanner inside `bun run typecheck` (package.json). It
 * complements `tsc --noEmit`: the compiler permits `as any` / `: any` /
 * `as unknown as X` by design (they are legal casts), so a separate gate is
 * needed to enforce the project's hard rules. Any violation NOT present in
 * the baseline (scripts/type-gate-baseline.json) aborts the run, so an agent
 * cannot merge a new erasure without either fixing the type or explicitly
 * re-baselining — a deliberate, reviewable act, never silent.
 *
 * Baseline semantics — the ratchet:
 *   The baseline freezes current debt as a literal checklist (that JSON
 *   file). The INITIAL snapshot is the gate's designed first record of
 *   pre-existing debt — the 2026-11-08 expansion grew it on purpose (test
 *   files joined the scan; the displaced `as unknown as` class and the
 *   production `as never` class became visible). That snapshot is NOT a
 *   budget raise. After it the ratchet only ever moves one way:
 *     - any NEW violation aborts the build (the actual goal — stop the bleed),
 *     - existing debt shrinks one fix at a time (remove a violation, run
 *       `--update-baseline`, the line drops from the checklist),
 *     - no eslint/biome dependency — a Bun script using the TypeScript
 *       compiler API (via `typescript/async`), matching the i18n-check gate
 *       pattern and the project's "no linter" stance.
 *
 * Parsing uses the TypeScript 7 programmatic API (`typescript/async`). TS 7's
 * main entry exports only `version`; the compiler/AST API lives on subpaths.
 * This script creates an `API` instance (which spawns the native `tsgo`
 * worker), parses every scanned file standalone via `createSourceFileFromFile`
 * (no tsconfig/project discovery — the scan is purely syntactic), then walks
 * each `SourceFile` AST for violations.
 *
 * Usage:
 *   bun scripts/type-gate.ts                # enforce (exit 1 on new violations)
 *   bun scripts/type-gate.ts --update-baseline   # rewrite baseline to current
 *   bun scripts/type-gate.ts --quiet        # summary only, no per-file detail
 *
 * Exit codes: 0 = clean / baseline updated; 1 = new violations found; 2 = usage.
 *
 * Detected categories:
 *   as-any        `x as any` / `x as any[]` / `x as Foo<any>` — AnyKeyword
 *                 anywhere inside an AsExpression's type operand.
 *   angle-any     `<any>x` type assertion (TS-only syntax; .tsx uses `as`).
 *   type-any      AnyKeyword in any other type position: `: any`, `any[]`,
 *                 `Record<string, any>`, `Promise<any>`, `<T extends any>`.
 *                 (AnyKeyword nested inside an `as`/`<>` cast is attributed to
 *                 as-any/angle-any instead, not double-counted as type-any.)
 *   unknown-cast  the double-cast erasure `x as unknown as X` — casting AWAY
 *                 from unknown into a concrete type — in every shape-based
 *                 form: plain, parenthesized between hops
 *                 (`(x as unknown) as X`), or multi-hop
 *                 (`x as unknown as A as B`; flagged ONCE, at the outermost
 *                 cast). A bare single `x as unknown` — narrowing INTO
 *                 unknown — is a legitimate step and is not flagged. This
 *                 class is the displaced neighbor of `as any`: once as-any
 *                 was blocked, writers reached for the unblocked shape, which
 *                 erases just as much.
 *   as-never      `x as never` in PRODUCTION files only (a test file is one
 *                 ending in .test.ts/.test.tsx). Test files budget these
 *                 under scripts/test-hygiene.ts instead — the gate skips them
 *                 here so the two counters never double-count the same cast.
 *   empty-catch   `catch {}` / `catch (e) {}` with no statements AND no
 *                 comment inside the block. A `catch` with an inline comment
 *                 is allowed — the rule is "handle or justify", and an inline
 *                 comment is the justification.
 *   ts-directive  `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`
 *                 (comment-scanned; `@ts-nocheck` is the nuclear file-wide
 *                 suppression). These are flagged unconditionally; legitimate
 *                 uses (e.g. a missing library type with an explanatory
 *                 comment) live in the baseline and must be re-justified when
 *                 re-baselined.
 *
 * Scope: every .ts/.tsx under packages/, services/, apps/web/src except
 * .d.ts. TEST FILES ARE SCANNED since 2026-11-08 — they were previously
 * excluded wholesale, which let the test suite accumulate hundreds of
 * erasure casts the gate never saw. The only category that still skips test
 * files is as-never (budgeted by test-hygiene instead).
 *
 * Baseline format: scripts/type-gate-baseline.json — a sorted array of keys of
 * the form "<relpath>:<line>:<col>:<category>". Line/col are 1-based, relative
 * to the repo root. When a file is refactored and line numbers shift, run
 * `--update-baseline` (the diff will show only the legit shift — review it).
 */
import { API } from "typescript/async";
import {
	SyntaxKind,
	isAsExpression,
	isCatchClause,
	isParenthesizedExpression,
	isParenthesizedTypeNode,
	isTypeAssertion,
} from "typescript/ast";
import type { Node, SourceFile, Block } from "typescript/ast";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

// ─── Config ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.resolve(import.meta.dir, "type-gate-baseline.json");

// Source roots scanned. Mirrors the per-workspace `typecheck` coverage so the
// gate sees exactly what the compiler sees.
const SCAN_ROOTS = ["packages", "services", "apps/web/src"];

// Test files ARE scanned since 2026-11-08 (they were the gate's second blind
// spot); only declaration shells stay out. The suffix list survives because
// the as-never category uses it to defer to test-hygiene's budget.
const EXCLUDE_SUFFIXES = [".d.ts"];
const TEST_FILE_SUFFIXES = [".test.ts", ".test.tsx"];

/** True for .test.ts/.test.tsx files (repo-relative or suffixed paths). */
export function isTestPath(filePath: string): boolean {
	return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

// Generated/vendored/irrelevant trees that would drown the signal.
//   services/api/scripts/ — local throwaway probes (e.g. probe-nanogpt-tools);
//   gitignored; their own headers declare them "out of the typecheck gate".
const EXCLUDE_DIR_PARTS = ["node_modules", "/dist/", "/out/", "/.cache/", "/services/api/scripts/"];

export type Category =
	| "as-any"
	| "angle-any"
	| "type-any"
	| "unknown-cast"
	| "as-never"
	| "empty-catch"
	| "ts-directive";

export interface Violation {
	/** Repo-relative path with forward slashes. */
	file: string;
	line: number;
	col: number;
	category: Category;
	/** Short code snippet for the report (truncated). */
	snippet: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join("/");

function snippetOf(sf: SourceFile, node: Node, max = 60): string {
	const text = sf.text.slice(node.getStart(sf), node.getEnd()).replace(/\s+/g, " ").trim();
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function locOf(sf: SourceFile, node: Node): { line: number; col: number } {
	const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
	return { line: line + 1, col: character + 1 };
}

/** True if `typeNode`'s subtree contains an AnyKeyword (covers `any`, `any[]`,
 *  `Foo<any>`, `Promise<any>`, etc.). */
function typeContainsAny(typeNode: Node): boolean {
	let found = false;
	const visit = (n: Node) => {
		if (found) return;
		if (n.kind === SyntaxKind.AnyKeyword) {
			found = true;
			return;
		}
		n.forEachChild(visit);
	};
	visit(typeNode);
	return found;
}

/** Record every AnyKeyword under `typeNode` as already-reported. */
function markAnyNodes(typeNode: Node, set: Set<Node>): void {
	const visit = (n: Node) => {
		if (n.kind === SyntaxKind.AnyKeyword) set.add(n);
		n.forEachChild(visit);
	};
	visit(typeNode);
}

const isCast = (node: Node): boolean => isAsExpression(node) || isTypeAssertion(node);

/** Strip ParenthesizedExpression / ParenthesizedType wrappers. */
function unwrapParens(node: Node): Node {
	let current = node;
	while (true) {
		if (isParenthesizedExpression(current)) {
			current = current.expression;
			continue;
		}
		if (isParenthesizedTypeNode(current)) {
			current = current.type;
			continue;
		}
		return current;
	}
}

/** The type operand of an as-cast / angle-assertion, parens unwrapped. */
function castType(node: Node): Node | undefined {
	if (isAsExpression(node)) return unwrapParens(node.type);
	if (isTypeAssertion(node)) return unwrapParens(node.type);
	return undefined;
}

/** The expression operand of an as-cast / angle-assertion. */
function castOperand(node: Node): Node | undefined {
	if (isAsExpression(node)) return node.expression;
	if (isTypeAssertion(node)) return node.expression;
	return undefined;
}

/** Cast nodes an erasure chain resolves through, outermost first, excluding
 *  `start` itself. Paren-tolerant (wrappers between hops are skipped) and
 *  multi-hop tolerant (`x as unknown as A as B` yields both inner casts). */
function castChainBelow(start: Node): Node[] {
	const hops: Node[] = [];
	let current = castOperand(start);
	while (current !== undefined) {
		current = unwrapParens(current);
		if (!isCast(current)) break;
		hops.push(current);
		current = castOperand(current);
	}
	return hops;
}

const isUnknownType = (type: Node | undefined): boolean =>
	type !== undefined && type.kind === SyntaxKind.UnknownKeyword;
const isNeverType = (type: Node | undefined): boolean =>
	type !== undefined && type.kind === SyntaxKind.NeverKeyword;

// ─── Scanning ──────────────────────────────────────────────────────────────

/**
 * Walk the parsed `SourceFile` AST for violations. Pure synchronous function —
 * all parsing (IPC with the tsgo worker) is done by the caller; this only
 * traverses the in-memory AST tree.
 */
export function scanAst(sf: SourceFile, absPath: string): Violation[] {
	const text = sf.text;
	const file = rel(absPath);
	const out: Violation[] = [];
	// Test files budget `as never` under scripts/test-hygiene.ts — never flag
	// the category for them, or the two counters would double-count.
	const skipAsNever = isTestPath(file);

	const add = (node: Node, category: Category) => {
		const { line, col } = locOf(sf, node);
		out.push({ file, line, col, category, snippet: snippetOf(sf, node) });
	};

	// Track AnyKeyword nodes already attributed to an `as`/`<>` cast, so they
	// aren't double-reported as type-any.
	const consumedAny = new Set<Node>();
	// Cast nodes already carrying a violation — at most one category per node.
	const flagged = new Set<Node>();
	// Inner hops of an already-flagged unknown-cast chain — the erasure is
	// reported once, at the outermost cast, not once per hop.
	const consumedErasure = new Set<Node>();

	const visit = (node: Node) => {
		// `x as any` / `x as any[]` / `x as Foo<any>`
		if (isAsExpression(node) && typeContainsAny(node.type)) {
			add(node, "as-any");
			markAnyNodes(node.type, consumedAny);
			flagged.add(node);
		}
		// `<any>x` type assertion
		if (isTypeAssertion(node) && typeContainsAny(node.type)) {
			add(node, "angle-any");
			markAnyNodes(node.type, consumedAny);
			flagged.add(node);
		}
		// AnyKeyword elsewhere in type position (`: any`, `Record<string, any>`, …)
		if (node.kind === SyntaxKind.AnyKeyword && !consumedAny.has(node)) {
			add(node, "type-any");
		}
		// Empty catch block without an inline justification comment.
		if (isCatchClause(node) && node.block.statements.length === 0) {
			if (!blockHasComment(sf, node.block)) add(node, "empty-catch");
		}
		// Double-cast erasure (`x as unknown as X`) and production `as never`.
		if (isCast(node) && !flagged.has(node) && !consumedErasure.has(node)) {
			const type = castType(node);
			if (isNeverType(type)) {
				if (!skipAsNever) add(node, "as-never");
			} else if (!isUnknownType(type)) {
				// Casting INTO unknown is a legitimate narrowing step; only
				// chains that later cast AWAY from unknown are the erasure.
				const hops = castChainBelow(node);
				if (hops.some((hop) => isUnknownType(castType(hop)))) {
					add(node, "unknown-cast");
					for (const hop of hops) consumedErasure.add(hop);
				}
			}
		}
		node.forEachChild(visit);
	};
	visit(sf);

	// Comment-scanned: @ts-ignore / @ts-expect-error / @ts-nocheck (the AST
	// does not expose these).
	out.push(...scanTsDirectives(file, text, sf));

	return out;
}

/** A catch block is "justified" if it contains a `//` or `/*` comment between
 *  its braces — that's where the required rationale lives. Pure `{}` or
 *  `{ (void)e; }` has no comment and is flagged. */
function blockHasComment(sf: SourceFile, block: Block): boolean {
	// TS 7's Node interface no longer exposes `getChildAt`; compute the open-brace
	// end arithmetically. A Block always starts with `{` (one character), so
	// start+1 is the position of the first byte inside the block.
	const open = block.getStart(sf) + 1; // just past the `{`
	const close = block.getEnd(); // includes the closing `}`
	const inner = sf.text.slice(open, close);
	return inner.includes("//") || inner.includes("/*");
}

function scanTsDirectives(file: string, text: string, sf: SourceFile): Violation[] {
	const out: Violation[] = [];
	const re = /@(ts-ignore|ts-expect-error|ts-nocheck)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const idx = m.index;
		const { line, character } = sf.getLineAndCharacterOfPosition(idx);
		out.push({ file, line: line + 1, col: character + 1, category: "ts-directive", snippet: m[0] });
	}
	return out;
}

function isExcluded(absPath: string): boolean {
	if (EXCLUDE_SUFFIXES.some((s) => absPath.endsWith(s))) return true;
	const norm = absPath.split(path.sep).join("/");
	return EXCLUDE_DIR_PARTS.some((p) => norm.includes(p));
}

/** Collect all .ts/.tsx file paths to scan (synchronous glob). */
function collectFiles(): string[] {
	const files: string[] = [];
	for (const root of SCAN_ROOTS) {
		const cwd = path.resolve(ROOT, root);
		if (!fs.existsSync(cwd)) continue;
		for (const p of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd, absolute: true })) {
			if (isExcluded(p)) continue;
			files.push(p);
		}
	}
	return files;
}

/**
 * Parse every collected file via the TS 7 `async` API and scan each parsed AST
 * for violations. One `tsgo` worker; files are parsed standalone, so a file
 * outside every tsconfig is still scanned.
 */
async function scanFiles(files: readonly string[]): Promise<Violation[]> {
	await using api = new API();
	const parsed = await Promise.all(files.map((absPath) => api.createSourceFileFromFile(absPath)));
	return parsed.flatMap(({ sourceFile }, i) => scanAst(sourceFile, files[i]!));
}

// ─── Baseline ──────────────────────────────────────────────────────────────

export const toKey = (v: Violation): string => `${v.file}:${v.line}:${v.col}:${v.category}`;

async function loadBaseline(baselinePath: string): Promise<Set<string>> {
	if (!fs.existsSync(baselinePath)) return new Set();
	try {
		const data = JSON.parse(await Bun.file(baselinePath).text());
		if (!Array.isArray(data)) throw new Error("baseline root is not an array");
		return new Set(data as string[]);
	} catch (err) {
		console.error(`type-gate: baseline at ${path.relative(ROOT, baselinePath)} is corrupt: ${(err as Error).message}`);
		console.error(`  run \`bun scripts/type-gate.ts --update-baseline\` to regenerate.`);
		process.exit(1);
	}
}

async function writeBaseline(baselinePath: string, keys: string[]): Promise<void> {
	const sorted = Array.from(new Set(keys)).sort();
	await Bun.write(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
}

// ─── Reporting ─────────────────────────────────────────────────────────────

/**
 * The WHY behind every category in this gate (owner ruling 2026-11-08). It
 * travels with every failure report so an agent that has never read this
 * file's header still meets the rule before its context ends.
 */
const CAST_IS_FOREVER_EXPLANATION = [
	"Every line of this codebase is written by an AI agent. A human's cast usually",
	"carries, in its author's head, the knowledge of WHY it exists — but an agent's",
	"cast is limited by its context window, and once that context is gone nobody",
	"will ever know why the cast is there. A cast is an unexplained decision made",
	"under partial information, preserved forever; `as unknown as` / `as any` /",
	"`as never` do not merely silence a compilation error — they erase it.",
	"",
	"Fix the type instead (prefer `unknown` plus a narrowing guard, or a named",
	"interface). If erasure is genuinely unavoidable, the ONLY sanctioned escape",
	"is a deliberate, reviewable re-baseline — never silent:",
	"    bun scripts/type-gate.ts --update-baseline   # review the diff before committing",
].join("\n");

export function formatNewViolations(fresh: readonly Violation[]): string {
	const grouped = new Map<string, Violation[]>();
	for (const v of fresh) {
		const list = grouped.get(v.file) ?? [];
		list.push(v);
		grouped.set(v.file, list);
	}
	const lines: string[] = [];
	for (const [file, list] of [...grouped.entries()].sort()) {
		lines.push(`  ${file}`);
		for (const v of list.sort((a, b) => a.line - b.line)) {
			lines.push(`    ${String(v.line).padStart(5)}:${String(v.col).padStart(3)}  [${v.category}]  ${v.snippet}`);
		}
	}
	lines.push("");
	lines.push(CAST_IS_FOREVER_EXPLANATION);
	return lines.join("\n");
}

function countByCategory(vs: Violation[]): Record<string, number> {
	const m: Record<string, number> = {};
	for (const v of vs) m[v.category] = (m[v.category] ?? 0) + 1;
	return m;
}

// ─── Gate ──────────────────────────────────────────────────────────────────

export interface GateOptions {
	update: boolean;
	quiet: boolean;
	/** Defaults to the repo baseline; tests point this at a temp file. */
	baselinePath?: string;
	/** Output sinks (default console); tests capture instead of patching globals. */
	log?: (message: string) => void;
	error?: (message: string) => void;
}

export interface GateOutcome {
	code: 0 | 1;
	total: number;
	fresh: Violation[];
	removed: string[];
}

/** Scan `files`, diff against the baseline, report. Returns the exit code
 *  `main` should process.exit with; printing goes through the sinks. */
export async function runGate(files: readonly string[], options: GateOptions): Promise<GateOutcome> {
	const log = options.log ?? ((message: string) => console.log(message));
	const error = options.error ?? ((message: string) => console.error(message));
	const baselinePath = options.baselinePath ?? BASELINE_PATH;

	const violations = await scanFiles(files);
	const currentKeys = new Set(violations.map(toKey));

	if (options.update) {
		await writeBaseline(baselinePath, violations.map(toKey));
		const byCat = countByCategory(violations);
		log(`type-gate: baseline rewritten → ${violations.length} violation(s) across ${Object.keys(byCat).length} category(ies).`);
		for (const [cat, n] of Object.entries(byCat)) log(`  ${cat.padEnd(14)} ${n}`);
		log(`  Review the diff of ${path.relative(ROOT, baselinePath)} before committing.`);
		return { code: 0, total: violations.length, fresh: [], removed: [] };
	}

	if (!fs.existsSync(baselinePath)) {
		error(`type-gate: no baseline found at ${path.relative(ROOT, baselinePath)}.`);
		error(`  This is expected on first run. Generate it with:`);
		error(`    bun scripts/type-gate.ts --update-baseline`);
		error(`  then commit the generated file.`);
		return { code: 1, total: violations.length, fresh: [], removed: [] };
	}

	const baseline = await loadBaseline(baselinePath);

	// New = present now, absent from baseline.
	const fresh = violations.filter((v) => !baseline.has(toKey(v)));
	// Removed = in baseline, gone now (improvement — advisory only).
	const removed = [...baseline].filter((k) => !currentKeys.has(k));

	if (fresh.length === 0) {
		if (!options.quiet) {
			log(`type-gate: clean — ${violations.length} violation(s) all within baseline.`);
			if (removed.length > 0) {
				log(`type-gate: ${removed.length} baseline violation(s) no longer present — nice.`);
				log(`  Shrink the debt by running: bun scripts/type-gate.ts --update-baseline`);
			}
		}
		return { code: 0, total: violations.length, fresh, removed };
	}

	error(`type-gate: ${fresh.length} NEW type-safety violation(s) detected — build aborted.\n`);
	error(formatNewViolations(fresh));
	return { code: 1, total: violations.length, fresh, removed };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const options = {
		"update-baseline": { type: "boolean" },
		quiet: { type: "boolean" },
	} as const;
	let update = false;
	let quiet = false;
	try {
		const parsed = parseArgs({
			args,
			options,
			strict: true,
			allowPositionals: false,
		});
		update = parsed.values["update-baseline"] === true;
		quiet = parsed.values.quiet === true;
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		const { tokens } = parseArgs({
			args,
			options,
			strict: false,
			allowPositionals: true,
			tokens: true,
		});
		const invalidIndexes = tokens.flatMap((token) => {
			if (token.kind === "option-terminator") return [];
			if (
				token.kind === "option"
				&& token.value === undefined
				&& (token.name === "update-baseline" || token.name === "quiet")
			) {
				return [];
			}
			return [token.index];
		});
		const invalidArgs = [...new Set(invalidIndexes)].flatMap((index) => {
			const arg = args[index];
			return arg === undefined ? [] : [arg];
		});
		console.error(`type-gate: unknown argument(s): ${invalidArgs.join(" ")}`);
		console.error("usage: bun scripts/type-gate.ts [--update-baseline] [--quiet]");
		process.exit(2);
	}

	const outcome = await runGate(collectFiles(), { update, quiet, baselinePath: BASELINE_PATH });
	process.exit(outcome.code);
}

if (import.meta.main) {
	void main().catch((err) => {
		console.error("type-gate: unexpected error:", err);
		process.exit(1);
	});
}
