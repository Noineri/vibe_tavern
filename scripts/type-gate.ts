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
 *     - no eslint/biome dependency — this is a ~200-line Bun script using the
 *       already-installed `typescript` compiler API, matching the i18n-check
 *       gate pattern and the project's "no linter" stance.
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
import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Config ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.resolve(import.meta.dir, "type-gate-baseline.json");

// Source roots scanned. Mirrors the per-workspace `typecheck` coverage so the
// gate sees exactly what the compiler sees.
const SCAN_ROOTS = ["packages", "services", "apps/web/src"];

const EXCLUDE_SUFFIXES = [".test.ts", ".test.tsx", ".d.ts"];
// Generated/vendored/irrelevant trees that would drown the signal.
const EXCLUDE_DIR_PARTS = ["node_modules", "/dist/", "/out/", "/.cache/"];

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

function snippetOf(sf: ts.SourceFile, node: ts.Node, max = 60): string {
  const text = sf.text.slice(node.getStart(sf), node.getEnd()).replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function locOf(sf: ts.SourceFile, node: ts.Node): { line: number; col: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

/** True if `typeNode`'s subtree contains an AnyKeyword (covers `any`, `any[]`,
 *  `Foo<any>`, `Promise<any>`, etc.). */
function typeContainsAny(typeNode: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n.kind === ts.SyntaxKind.AnyKeyword) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(typeNode);
  return found;
}

// ─── Scanning ──────────────────────────────────────────────────────────────

function scanFile(absPath: string): Violation[] {
  const text = fs.readFileSync(absPath, "utf8");
  const scriptKind = absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const out: Violation[] = [];
  const file = rel(absPath);

  const add = (node: ts.Node, category: Category) => {
    const { line, col } = locOf(sf, node);
    out.push({ file, line, col, category, snippet: snippetOf(sf, node) });
  };

  // Track AnyKeyword nodes already attributed to an `as`/`<>` cast, so they
  // aren't double-reported as type-any.
  const consumedAny = new Set<ts.Node>();

  const visit = (node: ts.Node) => {
    // `x as any` / `x as any[]` / `x as Foo<any>`
    if (ts.isAsExpression(node) && typeContainsAny(node.type)) {
      add(node, "as-any");
      markAnyNodes(node.type, consumedAny);
    }
    // `<any>x` type assertion
    if (ts.isTypeAssertionExpression(node) && typeContainsAny(node.type)) {
      add(node, "angle-any");
      markAnyNodes(node.type, consumedAny);
    }
    // AnyKeyword elsewhere in type position (`: any`, `Record<string, any>`, …)
    if (node.kind === ts.SyntaxKind.AnyKeyword && !consumedAny.has(node)) {
      add(node, "type-any");
    }
    // Empty catch block without an inline justification comment.
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      if (!blockHasComment(sf, node.block)) add(node, "empty-catch");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Comment-scanned: @ts-ignore / @ts-expect-error (AST does not expose these).
  out.push(...scanTsDirectives(file, text, sf));

  return out;
}

/** Record every AnyKeyword under `typeNode` as already-reported. */
function markAnyNodes(typeNode: ts.Node, set: Set<ts.Node>): void {
  const visit = (n: ts.Node) => {
    if (n.kind === ts.SyntaxKind.AnyKeyword) set.add(n);
    ts.forEachChild(n, visit);
  };
  visit(typeNode);
}

/** A catch block is "justified" if it contains a `//` or `/*` comment between
 *  its braces — that's where the required rationale lives. Pure `{}` or
 *  `{ (void)e; }` has no comment and is flagged. */
function blockHasComment(sf: ts.SourceFile, block: ts.Block): boolean {
  // Slice from just after `{` to the `}`.
  const open = block.getChildAt(0, sf).getEnd(); // the `{` token end
  const close = block.getEnd();                   // includes the closing `}`
  const inner = sf.text.slice(open, close);
  return inner.includes("//") || inner.includes("/*");
}

function scanTsDirectives(file: string, text: string, sf: ts.SourceFile): Violation[] {
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

function collectAll(): Violation[] {
  const all: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    const cwd = path.resolve(ROOT, root);
    if (!fs.existsSync(cwd)) continue;
    for (const p of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd, absolute: true })) {
      if (isExcluded(p)) continue;
      all.push(...scanFile(p));
    }
  }
  return all;
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

function main(): void {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update-baseline");
  const quiet = argv.includes("--quiet");
  const unknown = argv.filter((a) => a !== "--update-baseline" && a !== "--quiet");
  if (unknown.length) {
    console.error(`type-gate: unknown argument(s): ${unknown.join(" ")}`);
    console.error("usage: bun scripts/type-gate.ts [--update-baseline] [--quiet]");
    process.exit(2);
  }

  const violations = collectAll();
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

main();
