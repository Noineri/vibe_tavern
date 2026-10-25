/**
 * Inline `i18n/context.js` test mocks → shared seam codemod (I18N MOCK
 * MIGRATION PROGRAM; owner ruling 2026-10-25 — all batches in one pass, by
 * codemod, hands only for the residue).
 *
 * Every apps/web test file that hand-mocks `mock.module("…/i18n/context.js")`
 * replaces the process-global `useT` for every later file in a hand-bundled
 * run, so real-i18next suites (mounted `LocaleProvider`) render raw keys
 * (15-red incident, 2026-10-27). The shared seam
 * (`apps/web/test/i18n-context-seam.ts`) decides per RENDER: provider mounted
 * → delegate to the real context; no provider → the deterministic stub with
 * the registering suite's optional `interpolateKeys`.
 *
 * This script classifies each remaining inline mock and rewrites it:
 *
 * - IDENTITY — factory spreads the real module and `useT` returns only the
 *   identity family (`t`/`tDynamic` echo the key, `locale: "en"`,
 *   `setLocale` noop, `ready: true`; any subset of the non-`t` fields)
 *   → `installI18nContextSeam();` at the exact spot the mock occupied
 *   (the before-dynamic-imports ordering constraint), seam import after the
 *   `dom-env` import.
 * - INTERPOLATED — hand-verified overrides (below): the mock's inline
 *   templates are byte-identical to the bundled EN table after single-brace
 *   `{param}` interpolation → `installI18nContextSeam({ interpolateKeys: […] });`
 * - OTHER — custom semantics the seam cannot express without pin rewrites
 *   (`key:name` suffixes, `key#count`, JSON.stringify(params), switch-table
 *   literals, RU label tables, stable-object identity). Listed, never
 *   touched; they stay for per-file hand work.
 * - ON-SEAM — already migrated; never touched.
 *
 * Editing mechanics (statement boundaries, never line regexes): the mock
 * block is found by the `mock.module("…i18n/context.js"` call and cut by
 * balanced parentheses starting INSIDE the call's own opening paren; the
 * `const real… = await import("…/i18n/context.js")` declaration is removed
 * with it when no other reference survives; the `mock` binding is dropped
 * from the `bun:test` import when nothing else uses it.
 *
 * Usage:
 *   bun scripts/i18n-mock-codemod.ts [--dry-run] [--apply] [path-prefix]
 *   --dry-run (default) prints the per-file classification and planned edit;
 *   --apply writes the IDENTITY/INTERPOLATED files; the optional positional
 *   filters by path prefix (batch application per subtree).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const TEST_ROOT = "apps/web/src";
const SEAM_MODULE = "i18n-context-seam";

export type MockClassification = "IDENTITY" | "INTERPOLATED" | "OTHER" | "ON-SEAM" | "NO-MOCK";

export interface FilePlan {
	readonly file: string;
	readonly classification: MockClassification;
	/** INTERPOLATED: the seam spec keys; IDENTITY: empty. */
	readonly interpolateKeys: readonly string[];
	/** OTHER: the normalized `useT` body (the semantics that need hand reading). */
	readonly reason?: string;
	/** True when the transform would (or did) change the file. */
	readonly editable: boolean;
}

/**
 * Hand-verified INTERPOLATED overrides. Each entry documents that the mock's
 * inline template literals render byte-identical to the bundled EN table via
 * the seam's single-brace interpolation; `markers` must all appear in the
 * file's mock block before the override applies (a stale override fails loud
 * instead of silently misclassifying).
 */
export const INTERPOLATED_OVERRIDES: Readonly<
	Record<string, { interpolateKeys: readonly string[]; markers: readonly string[] }>
> = {
	"apps/web/src/components/layout/topbar-regex-indicator.test.tsx": {
		// Inline "{{name}}"/"{{n}}" literals vs en.json "Regex active: {name}" /
		// "Regex active: {n}" — identical after interpolation; every other key echoes.
		interpolateKeys: ["topbar_regex_active_one", "topbar_regex_active_many"],
		markers: ["topbar_regex_active_one", "topbar_regex_active_many"],
	},
	"apps/web/src/components/chat/ImageGenProgressRow.test.tsx": {
		// Inline "In queue: position … · ~…m" / "Drawing…" vs the identical
		// en.json templates for these two keys.
		interpolateKeys: ["image_gen_horde_queue", "image_gen_horde_drawing"],
		markers: ["image_gen_horde_queue", "image_gen_horde_drawing"],
	},
};

const MOCK_CALL_PATTERN = /mock\.module\(\s*(["'])([^"']*i18n\/context\.js)\1\s*,/;
const REAL_CONST_PATTERN = /const\s+(\w+)\s*=\s*await\s+import\(\s*(["'])[^"']*i18n\/context\.js\2\s*\)\s*;?/;

/** Consume the statement tail at `i` (just past the closing paren): the `;` and horizontal padding, plus the newline for full-line deletions — never the following statement's leading blank line. */
function consumeStatementTail(src: string, i: number, includeNewline: boolean): number {
	let end = i;
	if (src[end] === ";") end++;
	while (end < src.length && (src[end] === " " || src[end] === "\t")) end++;
	if (includeNewline && src[end] === "\n") end++;
	return end;
}

/** Find the `mock.module("…/i18n/context.js", …)` statement span (balanced parens, starting inside the call's own paren). */
export function findMockCallSpan(src: string): { start: number; end: number } | null {
	const match = MOCK_CALL_PATTERN.exec(src);
	if (!match) return null;
	let i = match.index + match[0].length;
	let depth = 1;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) break;
		}
	}
	let end = i + 1;
	end = consumeStatementTail(src, end, false);
	return { start: match.index, end };
}

/** The `useT` object literal body, comments stripped and whitespace-collapsed; null when `useT` is not an arrow returning a paren-wrapped object. */
export function extractUseTBody(block: string): string | null {
	const match = /useT\s*:\s*\(\)\s*=>\s*\(?\s*\{/.exec(block);
	if (!match) return null;
	let i = match.index + match[0].length - 1;
	let depth = 0;
	for (; i < block.length; i++) {
		if (block[i] === "{") depth++;
		else if (block[i] === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	let body = block.slice(match.index + match[0].length, i);
	body = body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
	return body.replace(/\s+/g, " ").trim();
}

const IDENTITY_T = /^t: \((k|key)(?:: string)?\) => \1$/;
const IDENTITY_T_DYNAMIC = /^tDynamic: \((k|key)(?:: string)?\) => \1$/;
const IDENTITY_LOCALE = /^locale: "en"$/;
const IDENTITY_SET_LOCALE = /^setLocale: \(\) => \{\}$|^setLocale: NOOP$/;
const IDENTITY_READY = /^ready: true$/;

/** True when the normalized `useT` object is exactly the identity family (t required; tDynamic/locale/setLocale/ready optional; nothing else). */
export function isIdentityUseTBody(normalized: string): boolean {
	const entries = normalized.replace(/,$/, "").split(",").map((entry) => entry.trim());
	if (entries.length === 0 || !IDENTITY_T.test(entries[0] ?? "")) return false;
	return entries.slice(1).every((entry) =>
		IDENTITY_T_DYNAMIC.test(entry) || IDENTITY_LOCALE.test(entry) || IDENTITY_SET_LOCALE.test(entry) || IDENTITY_READY.test(entry),
	);
}

export function* walkTestFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) yield* walkTestFiles(full);
		else if (/\.test\.tsx?$/.test(entry)) yield full.split(path.sep).join("/");
	}
}

export function classifyFile(file: string, src: string): FilePlan {
	if (src.includes("installI18nContextSeam")) {
		return { file, classification: "ON-SEAM", interpolateKeys: [], editable: false };
	}
	const span = findMockCallSpan(src);
	if (!span) return { file, classification: "NO-MOCK", interpolateKeys: [], editable: false };
	const second = MOCK_CALL_PATTERN.exec(src.slice(span.end));
	if (second) {
		return { file, classification: "OTHER", interpolateKeys: [], reason: "multiple i18n/context mock.module calls", editable: false };
	}
	const block = src.slice(span.start, span.end);
	const realConst = REAL_CONST_PATTERN.exec(src);
	// The factory must spread the same real module the file imports (the
	// seam's ...real contract); a missing/mismatched spread is hand work.
	const spreadOk = realConst !== null && block.includes(`...${realConst[1]},`);
	const normalized = extractUseTBody(block);
	if (normalized !== null && spreadOk && isIdentityUseTBody(normalized)) {
		return { file, classification: "IDENTITY", interpolateKeys: [], editable: true };
	}
	const override = INTERPOLATED_OVERRIDES[file];
	if (override && override.markers.every((marker) => block.includes(marker))) {
		return { file, classification: "INTERPOLATED", interpolateKeys: override.interpolateKeys, editable: true };
	}
	return {
		file,
		classification: "OTHER",
		interpolateKeys: [],
		reason: (normalized ?? "useT is not an object-returning arrow").slice(0, 120),
		editable: false,
	};
}

/** Relative import path from a test file to apps/web/test/i18n-context-seam.js. */
function seamImportSpecifier(file: string): string {
	const dir = path.posix.dirname(file);
	const rel = path.posix.relative(dir, "apps/web/test");
	return `${rel.startsWith(".") ? rel : `./${rel}`}/${SEAM_MODULE}.js`;
}

/** Insert the seam import: after the dom-env import when present, else after the last statement of the leading import run. */
export function insertSeamImport(src: string, file: string): string {
	const specifier = seamImportSpecifier(file);
	if (src.includes(`i18n-context-seam.js`)) return src;
	const line = `import { installI18nContextSeam } from "${specifier}";\n`;
	const domEnv = /^import[^\n]*test\/dom-env\.js";$/m.exec(src);
	if (domEnv) {
		const at = domEnv.index + domEnv[0].length + 1;
		return src.slice(0, at) + line + src.slice(at);
	}
	// Leading import run: statements starting with `import ` at column 0.
	const importStart = /^import[ (\t]/m.exec(src);
	if (!importStart) return line + src;
	let end = importStart.index;
	for (const m of src.matchAll(/^import[^\n]*?;$/gm)) {
		if (m.index === undefined || m.index < end) continue;
		if (m.index > end + 1) break; // a non-import line closed the run
		end = m.index + m[0].length;
	}
	const at = end + 1;
	return src.slice(0, at) + line + src.slice(at);
}

/** Drop `mock` from the bun:test import when no other usage survives (word-boundary count). */
function dropUnusedMockBinding(src: string): string {
	const importMatch = /import\s*\{([^}]*)\}\s*from\s*"bun:test";/.exec(src);
	if (!importMatch) return src;
	const withoutImport = src.slice(0, importMatch.index) + src.slice(importMatch.index + importMatch[0].length);
	const uses = withoutImport.match(/\bmock\b/g);
	if (uses && uses.length > 0) return src;
	const names = importMatch[1]
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0 && name !== "mock");
	const replacement = `import { ${names.join(", ")} } from "bun:test";`;
	return src.slice(0, importMatch.index) + replacement + src.slice(importMatch.index + importMatch[0].length);
}

export function transformFile(src: string, plan: FilePlan): string | null {
	if (!plan.editable) return null;
	const span = findMockCallSpan(src);
	if (!span) return null;
	const lineStart = src.lastIndexOf("\n", span.start) + 1;
	const indent = src.slice(lineStart, span.start);
	const call =
		plan.interpolateKeys.length > 0
			? `installI18nContextSeam({ interpolateKeys: [${plan.interpolateKeys.map((key) => `"${key}"`).join(", ")}] });`
			: "installI18nContextSeam();";
	let out = src.slice(0, span.start) + indent + call + src.slice(span.end);
	// Remove the now-dead real-context const when nothing else references it.
	const realConst = REAL_CONST_PATTERN.exec(out);
	if (realConst) {
		const identifier = realConst[1] ?? "";
		const rest = out.slice(0, realConst.index) + out.slice(realConst.index + realConst[0].length);
		const uses = rest.match(new RegExp(`\\b${identifier}\\b`, "g"));
		if (!uses || uses.length === 0) {
			const constEnd = consumeStatementTail(out, realConst.index + realConst[0].length, true);
			out = out.slice(0, realConst.index) + out.slice(constEnd);
		}
	}
	out = dropUnusedMockBinding(out);
	out = insertSeamImport(out, plan.file);
	return out;
}

export function runCodemod(prefix: string, dryRun: boolean): { report: string; edited: number } {
	const files = [...walkTestFiles(TEST_ROOT)].filter((file) => file.includes(prefix)).sort();
	const plans: FilePlan[] = [];
	let edited = 0;
	for (const file of files) {
		// Normalize to LF up front (the repo stores LF; a CRLF working copy
		// must not leak half-\r\n lines into the inserted statements).
		const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
		const plan = classifyFile(file, src);
		if (plan.classification === "NO-MOCK") continue;
		plans.push(plan);
		if (!dryRun && plan.editable) {
			const out = transformFile(src, plan);
			if (out === null || out === src) throw new Error(`${file}: transform produced no change`);
			writeFileSync(file, out);
			edited++;
		}
	}
	const counts = { IDENTITY: 0, INTERPOLATED: 0, OTHER: 0, "ON-SEAM": 0 } as Record<MockClassification, number>;	const lines: string[] = [];
	for (const plan of plans) {
		counts[plan.classification]++;
		const spec = plan.interpolateKeys.length > 0 ? ` keys=[${plan.interpolateKeys.join(", ")}]` : "";
		const reason = plan.classification === "OTHER" ? ` — ${plan.reason}` : "";
		lines.push(`${plan.classification.padEnd(13)} ${plan.file}${spec}${reason}`);
	}
	const report = [
		`i18n mock codemod: ${dryRun ? "dry run" : "apply"} prefix="${prefix}" over ${files.length} test file(s)`,
		`identity: ${counts.IDENTITY}  interpolated: ${counts.INTERPOLATED}  other: ${counts.OTHER}  on-seam: ${counts["ON-SEAM"]}`,
		...lines,
		dryRun ? "dry run — no files written" : `written: ${edited} file(s)`,
	].join("\n");
	return { report, edited };
}

function usage(): string[] {
	return [
		"usage: bun scripts/i18n-mock-codemod.ts [--dry-run] [--apply] [path-prefix]",
		"  --dry-run    print the per-file classification without writing (default)",
		"  --apply      rewrite the IDENTITY/INTERPOLATED files",
		"  path-prefix  restrict to files whose path contains the prefix (subtree batches)",
	];
}

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({ args: process.argv.slice(2), options: { "dry-run": { type: "boolean" }, apply: { type: "boolean" } }, strict: true, allowPositionals: true });
	} catch (error) {
		console.error(`i18n-mock-codemod: ${error instanceof Error ? error.message : String(error)}`);
		console.error(usage().join("\n"));
		return 2;
	}
	if (parsed.values.apply === true && parsed.values["dry-run"] === true) {
		console.error("i18n-mock-codemod: --apply and --dry-run are mutually exclusive");
		return 2;
	}
	const prefix = parsed.positionals[0] ?? "";
	const dryRun = parsed.values.apply !== true;
	try {
		const { report } = runCodemod(prefix, dryRun);
		console.log(report);
		return 0;
	} catch (error) {
		console.error(`i18n-mock-codemod: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) {
	void main().then((code) => process.exit(code));
}
