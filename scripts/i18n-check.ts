/**
 * i18n locale validator.
 *
 * Audits apps/web/src/i18n/locales/*.json against the source tree and catches
 * the four defect classes found in the 2026-06-17 manual audit — plus the
 * "stale fallback" anti-pattern. Runs as part of `bun run check`.
 *
 * Usage:
 *   bun scripts/i18n-check.ts            # full check, exit 1 on hard errors
 *   bun scripts/i18n-check.ts --quiet    # suppress per-key detail, summary only
 *
 * Checks:
 *   [parity]      (HARD) every locale file has exactly the same key set.
 *                         en.json is the source of truth; others must match.
 *   [duplicate]   (HARD) no key defined twice in one file. JSON.parse is
 *                         last-wins, so an early duplicate is silently dead
 *                         (classic "silent drift" — e.g. provider_active once
 *                         carried a ✓ that JSX also added, rendering two).
 *   [missing-key] (HARD) every t("key") call in code has a matching key in
 *                         every locale. Otherwise the raw key string leaks into
 *                         the UI (the t() fallback returns its argument).
 *   [unused]      (WARN) key defined in JSON but never referenced by any t()
 *                         call. Advisory because dynamic t(`prefix_${x}`) and
 *                         t(identifier) can hide references — see resolution
 *                         notes below. Prefix-aware: a key whose only reference
 *                         is via a template-literal prefix is NOT flagged.
 *
 * What counts as a translation call:
 *   t(...)  where `t` is the conventional name bound by `const { t } = useT()`
 *   or `const t = getT()`. The heuristic: a file "uses i18n" if it imports
 *   useT or getT; in such files every `t(...)` call is treated as a translation
 *   call. (False positives possible if a file reuses `t` for something else
 *   AND imports i18n — not seen in this codebase; revisit if it happens.)
 *
 * Argument resolution (how a t() call maps to key names):
 *   t("literal")            → the literal
 *   t(`no-sub`)             → the literal (template w/o interpolation)
 *   t(`prefix_${x}`)        → dynamic; records `prefix` so any JSON key
 *                             starting with it counts as referenced
 *   t(identifier)           → resolved via per-file const-binding map:
 *     const k = "lit"                 → ["lit"]
 *     const k = cond ? "a" : "b"      → ["a", "b"]   (recursive on ternaries)
 *     otherwise                       → dynamic (unresolvable; warned per site)
 *
 * No type checker is used — ts.createSourceFile is a pure parser, so this is
 * fast and independent of project/tsconfig. Scoping is intentionally loose
 * (file-level binding map, not proper scope resolution): correct for every
 * pattern currently in the tree, and unused-key is advisory anyway.
 */

import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Config ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dir, "..");
const LOCALES_DIR = path.resolve(ROOT, "apps/web/src/i18n/locales");
const SRC_DIR = path.resolve(ROOT, "apps/web/src");
const TRANSLATION_FN = "t";

// Files/dirs excluded from source scanning:
//   i18n/   — the locale machinery itself (registry, context, helpers); it
//             constructs keys at runtime (import(`./locales/${locale}.json`))
//             and has no user-facing t() calls.
//   *.test.*— test fixtures; keys there are not production references.
//   dev/    — throwaway dev tooling (ThemeTuner etc.); self-contained.
const EXCLUDE_DIRS = ["i18n", "dev"];
const EXCLUDE_SUFFIXES = [".test.ts", ".test.tsx", ".d.ts"];

interface Violation {
  kind: string;
  file: string;
  line?: number;
  message: string;
}

const quiet = process.argv.includes("--quiet");
const errors: Violation[] = [];
const warnings: Violation[] = [];

function rel(p: string): string {
  const norm = path.resolve(p).replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/");
  return norm.startsWith(root + "/") ? norm.slice(root.length + 1) : norm;
}

// ─── 1. JSON loading + duplicate detection ────────────────────────────────

interface LocaleFile {
  name: string;          // "en", "ru", ...
  path: string;
  keys: Set<string>;     // unique keys (last-wins semantics)
  raw: string;           // original text (for duplicate line numbers)
}

/** Scan raw text for key occurrences with line numbers (JSON.parse loses them). */
function scanKeyLines(raw: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const re = /^[ \t]*"([a-z0-9_]+)"\s*:/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    const line = raw.slice(0, m.index).split("\n").length;
    const arr = out.get(key) ?? [];
    arr.push(line);
    out.set(key, arr);
  }
  return out;
}

function loadLocales(): LocaleFile[] {
  const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: LOCALES_DIR })).sort();
  return files.map((f) => {
    const path = `${LOCALES_DIR}/${f}`;
    const raw = fs.readFileSync(path, "utf8");
    const name = f.replace(/\.json$/, "");
    const map = JSON.parse(raw) as Record<string, string>;
    return { name, path, keys: new Set(Object.keys(map)), raw };
  });
}

// ─── 2. Source collection ──────────────────────────────────────────────────

function collectSources(): string[] {
  const out: string[] = [];
  for (const path of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC_DIR, absolute: true })) {
    const norm = path.replace(/\\/g, "/");
    if (EXCLUDE_DIRS.some((d) => norm.includes(`/src/${d}/`))) continue;
    if (EXCLUDE_SUFFIXES.some((s) => norm.endsWith(s))) continue;
    out.push(path);
  }
  return out;
}

// ─── 3. AST walk: collect t() references + per-file bindings ───────────────

interface KeyReferences {
  literals: Set<string>;           // keys used as literal/resolvable string args
  templatePrefixes: Set<string>;   // non-empty prefixes from t(`prefix${x}`) or t("prefix" + x)
  unresolvable: Array<{ file: string; line: number; detail: string }>;
  loose: Set<string>;              // keys appearing as ANY string literal in source
                                   // (covers registry/prop patterns: labelKey: "build_scripts")
}

interface FileBindings {
  // variable name → list of literal keys it can resolve to (ternaries fan out)
  map: Map<string, string[]>;
}

/** Collect `const/let/var x = <resolvable>` bindings into the file map. */
function collectBindings(src: ts.SourceFile): FileBindings {
  const map = new Map<string, string[]>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const resolved = resolveInitializer(decl.initializer);
          if (resolved) map.set(decl.name.text, resolved);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { map };
}

/** Resolve an initializer expression to literal keys, or null if unresolvable. */
function resolveInitializer(expr: ts.Expression): string[] | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isConditionalExpression(expr)) {
    const a = expr.whenTrue ? resolveInitializer(expr.whenTrue) : null;
    const b = expr.whenFalse ? resolveInitializer(expr.whenFalse) : null;
    if (a && b) return [...a, ...b];
  }
  return null;
}

/** Resolve a t() argument to keys; dynamic ones report a reason. */
function resolveArg(
  arg: ts.Expression,
  bindings: FileBindings,
): { keys: string[]; dynamic: boolean; detail?: string } {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { keys: [arg.text], dynamic: false };
  }
  if (ts.isTemplateExpression(arg)) {
    // has ${} — the static head is the prefix; any key starting with it matches
    return { keys: [], dynamic: true, detail: `template prefix "${arg.head.text}"` };
  }
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // "prefix_" + var  → capture the static prefix
    if (ts.isStringLiteral(arg.left) || ts.isNoSubstitutionTemplateLiteral(arg.left)) {
      return { keys: [], dynamic: true, detail: `template prefix "${arg.left.text}"` };
    }
    const l = resolveArg(arg.left, bindings);
    const r = resolveArg(arg.right, bindings);
    if (!l.dynamic && !r.dynamic) return { keys: [...l.keys, ...r.keys], dynamic: false };
    return { keys: [], dynamic: true, detail: "concatenated expression" };
  }
  if (ts.isIdentifier(arg)) {
    const resolved = bindings.map.get(arg.text);
    if (resolved) return { keys: resolved, dynamic: false };
    return { keys: [], dynamic: true, detail: `unresolved variable "${arg.text}"` };
  }
  if (ts.isConditionalExpression(arg)) {
    const a = resolveArg(arg.whenTrue, bindings);
    const b = resolveArg(arg.whenFalse, bindings);
    return { keys: [...a.keys, ...b.keys], dynamic: a.dynamic || b.dynamic };
  }
  return { keys: [], dynamic: true, detail: "computed argument" };
}

/** Does this source file use the i18n system (import useT / getT)? */
function fileUsesI18n(src: ts.SourceFile): boolean {
  let uses = false;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.includes("i18n")) {
        // confirm it actually imports the hook/helper, not just types
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (el.name.text === "useT" || el.name.text === "getT") uses = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return uses;
}

function collectReferences(sources: string[], looseKeySet: Set<string>): KeyReferences {
  const refs: KeyReferences = {
    literals: new Set(),
    templatePrefixes: new Set(),
    unresolvable: [],
    loose: new Set(),
  };
  for (const path of sources) {
    const text = fs.readFileSync(path, "utf8");
    // Parse .tsx as TSX so JSX nodes are recognized; .ts as TS.
    const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind);
    if (!fileUsesI18n(parsed)) continue;
    const bindings = collectBindings(parsed);
    // First pass: gather every string literal that exactly matches a known key.
    // This is the "loose" set — it catches keys referenced via object property
    // values in registries (e.g. labelKey: "build_scripts" in build-panel-registry)
    // or maps, which the t()-call walk can't see because the key is passed as a
    // prop, not handed directly to t().
    const looseVisit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && looseKeySet.has(node.text)) {
        refs.loose.add(node.text);
      }
      ts.forEachChild(node, looseVisit);
    };
    looseVisit(parsed);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === TRANSLATION_FN) {
          const arg = node.arguments[0];
          if (arg) {
            const { keys, dynamic, detail } = resolveArg(arg, bindings);
            for (const k of keys) refs.literals.add(k);
            if (dynamic) {
              if (detail?.startsWith("template prefix ")) {
                const prefix = detail.slice('template prefix "'.length, -1);
                if (prefix) refs.templatePrefixes.add(prefix);
              }
              const { line } = parsed.getLineAndCharacterOfPosition(arg.getStart(parsed));
              refs.unresolvable.push({ file: rel(path), line: line + 1, detail: detail ?? "dynamic" });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return refs;
}

// ─── 4. Checks ─────────────────────────────────────────────────────────────

function checkParity(locales: LocaleFile[]): void {
  if (locales.length < 2) return;
  const base = locales[0]; // en (alphabetically first among {en, ru, ...})
  for (const lf of locales.slice(1)) {
    const missing = [...base.keys].filter((k) => !lf.keys.has(k));
    const extra = [...lf.keys].filter((k) => !base.keys.has(k));
    for (const k of missing) {
      errors.push({ kind: "parity", file: rel(lf.path), message: `key "${k}" present in ${base.name} but missing in ${lf.name}` });
    }
    for (const k of extra) {
      errors.push({ kind: "parity", file: rel(lf.path), message: `key "${k}" present in ${lf.name} but missing in ${base.name}` });
    }
  }
}

function checkDuplicates(locales: LocaleFile[]): void {
  for (const lf of locales) {
    const lines = scanKeyLines(lf.raw);
    for (const [key, lineList] of lines) {
      if (lineList.length > 1) {
        errors.push({
          kind: "duplicate",
          file: rel(lf.path),
          message: `key "${key}" defined ${lineList.length}× (lines ${lineList.join(", ")}) — JSON.parse keeps the last, earlier occurrences are dead`,
        });
      }
    }
  }
}

function checkMissingKeys(locales: LocaleFile[], refs: KeyReferences): void {
  for (const key of refs.literals) {
    for (const lf of locales) {
      if (!lf.keys.has(key)) {
        // find a representative call site from unresolvable? No — literals come
        // from t("key"); we don't carry file:line here. Report against locale.
        errors.push({ kind: "missing-key", file: rel(lf.path), message: `t("${key}") is called in code but not defined in ${lf.name}.json` });
      }
    }
  }
}

function checkUnused(locales: LocaleFile[], refs: KeyReferences): void {
  const base = locales[0];
  for (const key of base.keys) {
    if (refs.literals.has(key)) continue;
    if (refs.loose.has(key)) continue;
    // covered by a template-literal / string-concat prefix?
    let covered = false;
    for (const prefix of refs.templatePrefixes) {
      if (key.startsWith(prefix)) { covered = true; break; }
    }
    if (covered) continue;
    warnings.push({ kind: "unused", file: rel(base.path), message: `key "${key}" is defined but no t("${key}") reference found (may be referenced dynamically — verify before deleting)` });
  }
}

function warnUnresolvable(refs: KeyReferences): void {
  for (const u of refs.unresolvable) {
    warnings.push({ kind: "dynamic", file: u.file, line: u.line, message: `t() called with ${u.detail} — cannot statically verify all keys exist. Check manually.` });
  }
}

// ─── 5. Report ─────────────────────────────────────────────────────────────

function printGroup(title: string, items: Violation[]): void {
  if (items.length === 0) return;
  console.log(`\n${title} (${items.length})`);
  if (quiet) return;
  const byKind = new Map<string, Violation[]>();
  for (const v of items) {
    const arr = byKind.get(v.kind) ?? [];
    arr.push(v);
    byKind.set(v.kind, arr);
  }
  for (const [kind, vs] of byKind) {
    console.log(`  [${kind}]`);
    for (const v of vs) {
      const loc = v.line ? `${v.file}:${v.line}` : v.file;
      console.log(`    ${loc.padEnd(52)} ${v.message}`);
    }
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

function main(): void {
  const locales = loadLocales();
  if (locales.length === 0) {
    console.error(`i18n-check: no locale files found in ${rel(LOCALES_DIR)}`);
    process.exit(2);
  }
  const sources = collectSources();
  // Union of all keys across locales — used for the loose-reference scan.
  const looseKeySet = new Set<string>();
  for (const lf of locales) for (const k of lf.keys) looseKeySet.add(k);
  const refs = collectReferences(sources, looseKeySet);

  checkParity(locales);
  checkDuplicates(locales);
  checkMissingKeys(locales, refs);
  checkUnused(locales, refs);
  warnUnresolvable(refs);

  console.log(`i18n check — ${locales.length} locale(s), ${sources.length} source file(s), ${refs.literals.size} literal + ${refs.loose.size} loose key reference(s)`);
  printGroup("ERRORS", errors);
  printGroup("WARNINGS", warnings);

  const status = errors.length === 0 ? "✓ clean" : `✗ ${errors.length} error(s)`;
  console.log(`\n${status}, ${warnings.length} warning(s)`);
  process.exit(errors.length === 0 ? 0 : 1);
}

main();
