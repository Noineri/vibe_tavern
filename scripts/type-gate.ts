/**
 * Type-safety baseline gate.
 *
 * A lightweight AST scanner that blocks NEW `any`-shaped type-erasure and empty
 * `catch {}` from entering the codebase. It complements `tsc --noEmit`: the
 * compiler permits `as any` / `: any` by design (they're legal casts), so a
 * separate gate is needed to enforce the project's hard rules — "No `as any`",
 * "No empty `catch {}`" — which an agent (or human) can otherwise slip past
 * `bun run typecheck` without any error.
 *
 * Runs as part of `bun run typecheck` (see package.json). Aborts the run on any
 * violation not present in the baseline, so an agent cannot merge `as any` /
 * `<any>` / `: any` / `@ts-ignore` / empty `catch {}` without either fixing the
 * type or explicitly re-baselining (a deliberate, reviewable act).
 *
 * Why a baseline instead of "zero violations":
 *   The codebase predates the gate and carries ~50 historical violations. A
 *   hard "zero" gate would fail today and block all work. The baseline freezes
 *   the current debt as a literal checklist (this file), so:
 *     - any NEW violation aborts the build (the actual goal — stop the bleed),
 *     - existing debt is visible and shrinks one fix at a time (remove a
 *       violation, run `--update-baseline`, the line drops from the checklist),
 *     - no eslint/biome dependency — this is a ~250-line Bun script using the
 *       TypeScript compiler API (via `typescript/unstable/async`), matching the
 *       i18n-check gate pattern and the project's "no linter" stance.
 *
 * Parsing uses the TypeScript 7 programmatic API (`typescript/unstable/async`).
 * TS 7 restructured the package: the main entry now exports only `version`, and
 * the compiler/AST API moved to `typescript/unstable/*` subpaths. This script
 * creates an `API` instance (which spawns the native `tsgo` worker), opens all
 * scanned files in one `updateSnapshot` call (auto-resolving their workspace
 * projects via tsconfig discovery), then walks each parsed `SourceFile` AST for
 * violations. Total wall time for ~450 files is ~500ms.
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
 *   empty-catch   `catch {}` / `catch (e) {}` with no statements AND no comment
 *                 inside the block. A `catch` with an inline comment is allowed — the
 *                 rule is "handle or justify", and an inline comment is the
 *                 justification.
 *   ts-directive  `@ts-ignore` or `@ts-expect-error` (comment-scanned). These
 *                 are flagged unconditionally; legitimate uses (e.g. a missing
 *                 library type with an explanatory comment) live in the baseline
 *                 and must be re-justified when re-baselined.
 *
 * Baseline format: scripts/type-gate-baseline.json — a sorted array of keys of
 * the form "<relpath>:<line>:<col>:<category>". Line/col are 1-based, relative
 * to the repo root. When a file is refactored and line numbers shift, run
 * `--update-baseline` (the diff will show only the legit shift — review it).
 */
import { API } from "typescript/unstable/async";
import {
  SyntaxKind,
  isAsExpression,
  isTypeAssertion,
  isCatchClause,
} from "typescript/unstable/ast";
import type { Node, SourceFile, Block } from "typescript/unstable/ast";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

// ─── Config ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.resolve(import.meta.dir, "type-gate-baseline.json");

// Source roots scanned. Mirrors the per-workspace `typecheck` coverage so the
// gate sees exactly what the compiler sees.
const SCAN_ROOTS = ["packages", "services", "apps/web/src"];

const EXCLUDE_SUFFIXES = [".test.ts", ".test.tsx", ".d.ts"];
// Generated/vendored/irrelevant trees that would drown the signal.
//   services/api/scripts/ — local throwaway probes (e.g. probe-nanogpt-tools);
//   gitignored; their own headers declare them "out of the typecheck gate".
const EXCLUDE_DIR_PARTS = ["node_modules", "/dist/", "/out/", "/.cache/", "/services/api/scripts/"];

type Category = "as-any" | "angle-any" | "type-any" | "empty-catch" | "ts-directive";

interface Violation {
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
    if (n.kind === SyntaxKind.AnyKeyword) { found = true; return; }
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

// ─── Scanning ──────────────────────────────────────────────────────────────

/**
 * Walk the parsed `SourceFile` AST for violations. Pure synchronous function —
 * all parsing (IPC with the tsgo worker) is done by the caller; this only
 * traverses the in-memory AST tree.
 */
function scanAst(sf: SourceFile, absPath: string): Violation[] {
  const text = sf.text;
  const file = rel(absPath);
  const out: Violation[] = [];

  const add = (node: Node, category: Category) => {
    const { line, col } = locOf(sf, node);
    out.push({ file, line, col, category, snippet: snippetOf(sf, node) });
  };

  // Track AnyKeyword nodes already attributed to an `as`/`<>` cast, so they
  // aren't double-reported as type-any.
  const consumedAny = new Set<Node>();

  const visit = (node: Node) => {
    // `x as any` / `x as any[]` / `x as Foo<any>`
    if (isAsExpression(node) && typeContainsAny(node.type)) {
      add(node, "as-any");
      markAnyNodes(node.type, consumedAny);
    }
    // `<any>x` type assertion
    if (isTypeAssertion(node) && typeContainsAny(node.type)) {
      add(node, "angle-any");
      markAnyNodes(node.type, consumedAny);
    }
    // AnyKeyword elsewhere in type position (`: any`, `Record<string, any>`, …)
    if (node.kind === SyntaxKind.AnyKeyword && !consumedAny.has(node)) {
      add(node, "type-any");
    }
    // Empty catch block without an inline justification comment.
    if (isCatchClause(node) && node.block.statements.length === 0) {
      if (!blockHasComment(sf, node.block)) add(node, "empty-catch");
    }
    node.forEachChild(visit);
  };
  visit(sf);

  // Comment-scanned: @ts-ignore / @ts-expect-error (AST does not expose these).
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
  const close = block.getEnd();         // includes the closing `}`
  const inner = sf.text.slice(open, close);
  return inner.includes("//") || inner.includes("/*");
}

function scanTsDirectives(file: string, text: string, sf: SourceFile): Violation[] {
  const out: Violation[] = [];
  const re = /@(ts-ignore|ts-expect-error)/g;
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
 * Parse every collected file via the TS 7 `unstable/async` API and scan each
 * parsed AST for violations. Creates a single `tsgo` worker, opens all files in
 * one `updateSnapshot` (auto-resolving workspace projects), then fetches each
 * parsed `SourceFile` sequentially.
 */
async function collectAllViolations(): Promise<Violation[]> {
  const files = collectFiles();
  const api = new API();
  try {
    const snap = await api.updateSnapshot({ openFiles: files });
    const all: Violation[] = [];
    for (const absPath of files) {
      const proj = await snap.getDefaultProjectForFile(absPath);
      if (!proj) {
        console.error(`type-gate: warning — ${rel(absPath)} not in any tsconfig project; skipping AST scan.`);
        continue;
      }
      const sf = await proj.program.getSourceFile(absPath);
      if (!sf) {
        console.error(`type-gate: warning — could not parse ${rel(absPath)}; skipping.`);
        continue;
      }
      all.push(...scanAst(sf, absPath));
    }
    return all;
  } finally {
    api.close();
  }
}

// ─── Baseline ──────────────────────────────────────────────────────────────

const toKey = (v: Violation): string => `${v.file}:${v.line}:${v.col}:${v.category}`;

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_PATH)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    if (!Array.isArray(data)) throw new Error("baseline root is not an array");
    return new Set(data as string[]);
  } catch (err) {
    console.error(`type-gate: baseline at ${path.relative(ROOT, BASELINE_PATH)} is corrupt: ${(err as Error).message}`);
    console.error(`  run \`bun scripts/type-gate.ts --update-baseline\` to regenerate.`);
    process.exit(1);
  }
}

function writeBaseline(keys: string[]): void {
  const sorted = Array.from(new Set(keys)).sort();
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");
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

  const violations = await collectAllViolations();
  const currentKeys = new Set(violations.map(toKey));

  if (update) {
    writeBaseline(violations.map(toKey));
    const byCat = countByCategory(violations);
    console.log(`type-gate: baseline rewritten → ${violations.length} violation(s) across ${Object.keys(byCat).length} category(ies).`);
    for (const [cat, n] of Object.entries(byCat)) console.log(`  ${cat.padEnd(14)} ${n}`);
    console.log(`  Review the diff of ${path.relative(ROOT, BASELINE_PATH)} before committing.`);
    process.exit(0);
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`type-gate: no baseline found at ${path.relative(ROOT, BASELINE_PATH)}.`);
    console.error(`  This is expected on first run. Generate it with:`);
    console.error(`    bun scripts/type-gate.ts --update-baseline`);
    console.error(`  then commit the generated file.`);
    process.exit(1);
  }

  const baseline = loadBaseline();

  // New = present now, absent from baseline.
  const fresh = violations.filter((v) => !baseline.has(toKey(v)));
  // Removed = in baseline, gone now (improvement — advisory only).
  const removed = [...baseline].filter((k) => !currentKeys.has(k));

  if (fresh.length === 0) {
    if (!quiet) {
      console.log(`type-gate: clean — ${violations.length} violation(s) all within baseline.`);
      if (removed.length > 0) {
        console.log(`type-gate: ${removed.length} baseline violation(s) no longer present — nice.`);
        console.log(`  Shrink the debt by running: bun scripts/type-gate.ts --update-baseline`);
      }
    }
    process.exit(0);
  }

  // ── Report new violations ──
  console.error(`type-gate: ${fresh.length} NEW type-safety violation(s) detected — build aborted.\n`);
  const grouped = new Map<string, Violation[]>();
  for (const v of fresh) {
    const list = grouped.get(v.file) ?? [];
    list.push(v);
    grouped.set(v.file, list);
  }
  for (const [file, list] of [...grouped.entries()].sort()) {
    console.error(`  ${file}`);
    for (const v of list.sort((a, b) => a.line - b.line)) {
      console.error(`    ${String(v.line).padStart(5)}:${String(v.col).padStart(3)}  [${v.category}]  ${v.snippet}`);
    }
  }
  console.error("");
  console.error("These rules exist to keep the compiler able to catch real bugs in the");
  console.error("co-author / tool-message / prompt-assembly hot paths. Fix the type");
  console.error("(prefer `unknown` + a narrowing guard, or a named interface) rather than");
  console.error("erasing it. If a suppression is genuinely unavoidable, justify it in a");
  console.error("comment and refresh the snapshot:");
  console.error("    bun scripts/type-gate.ts --update-baseline   # deliberate — review the diff");
  process.exit(1);
}

function countByCategory(vs: Violation[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const v of vs) m[v.category] = (m[v.category] ?? 0) + 1;
  return m;
}

main().catch((err) => {
  console.error("type-gate: unexpected error:", err);
  process.exit(1);
});
