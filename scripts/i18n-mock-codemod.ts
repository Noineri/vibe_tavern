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
 * - CUSTOM — the mock's `t` (and optional `tDynamic`) is a portable inline
 *   function and every other `useT` field is the identity family →
 *   `installI18nContextSeam({ custom: { t: …, tDynamic: … } });` with the
 *   function bodies ported VERBATIM (parameter annotations dropped — they
 *   take the seam's `TFunc`/`TDynamic` shapes contextually) and their
 *   original indentation preserved. The suite's pins keep their checked
 *   facts with ZERO assertion changes.
 * - OTHER — semantics the codemod cannot port mechanically: named-reference
 *   `t` (`t: stableT`, `useT: () => stableT`), a missing `...real` spread,
 *   a non-identity mutable `locale` field, or several mock calls. Listed,
 *   never touched; they stay for per-file hand work.
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

export type MockClassification = "IDENTITY" | "INTERPOLATED" | "CUSTOM" | "OTHER" | "ON-SEAM" | "NO-MOCK";

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

/** The RAW `useT` object literal body (no comment stripping, no collapsing); same null rule as `extractUseTBody`. */
export function extractUseTBodyRaw(block: string): string | null {
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
	return block.slice(match.index + match[0].length, i);
}

/** Whitespace-collapse + comment-strip a RAW slice (the identity-entry test normalizer). */
function collapse(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Split an object-literal body into RAW top-level entries. Strings, template
 * literals (their `${…}` code included), and comments are skipped so a comma
 * inside any of them never splits an entry (TrackerTemplateSummaryRow carries
 * ` mode, ` inside plain template text).
 */
export function splitObjectEntries(body: string): string[] | null {
	const entries: string[] = [];
	let start = 0;
	let depth = 0;
	// Frame stack: "code" (plain code), "tpl" (template literal text), or an
	// interpolation code frame carrying the brace depth its closing `}` pops to.
	const frames: Array<{ kind: "code" | "tpl"; exitDepth?: number }> = [{ kind: "code" }];
	for (let i = 0; i < body.length; i++) {
		const frame = frames[frames.length - 1]!;
		const c = body[i];
		if (frame.kind === "tpl") {
			if (c === "\\") { i++; continue; }
			if (c === "`") { frames.pop(); continue; }
			if (c === "$" && body[i + 1] === "{") {
				depth++;
				frames.push({ kind: "code", exitDepth: depth });
				i++; // consume the `{` of `${`
				continue;
			}
			continue;
		}
		if (c === "/" && body[i + 1] === "/") {
			while (i < body.length && body[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && body[i + 1] === "*") {
			const end = body.indexOf("*/", i + 2);
			if (end === -1) return null;
			i = end + 1;
			continue;
		}
		if (c === '"' || c === "'") {
			i++;
			while (i < body.length && body[i] !== c) {
				if (body[i] === "\\") i++;
				i++;
			}
			if (i >= body.length) return null;
			continue;
		}
		if (c === "`") { frames.push({ kind: "tpl" }); continue; }
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			depth--;
			if (depth < 0) return null;
			if (frame.exitDepth !== undefined && depth === frame.exitDepth - 1) frames.pop();
		} else if (c === "," && depth === 0 && frame.exitDepth === undefined) {
			entries.push(body.slice(start, i));
			start = i + 1;
		}
	}
	if (frames.length > 1) return null;
	entries.push(body.slice(start));
	// A trailing separator (or a body of only whitespace/comments) yields an
	// empty tail entry — not an entry.
	if (entries[entries.length - 1]!.trim() === "") entries.pop();
	return entries;
}

/** One parsed `useT` object entry: the field name and its RAW value slice. */
export interface UseTEntry {
	readonly name: string;
	readonly value: string;
	/** The entry's full raw text (name + value), for the identity-family checks. */
	readonly raw: string;
}

/** Parse the raw entries into name/value pairs; an entry without a plain `name:` shape makes the whole parse fail (→ hand work). */
export function parseUseTEntries(rawBody: string): UseTEntry[] | null {
	const split = splitObjectEntries(rawBody);
	if (split === null) return null;
	const entries: UseTEntry[] = [];
	for (const entry of split) {
		const match = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*([A-Za-z_$][\w$]*)\s*:/.exec(entry);
		if (!match) {
			// A whole-entry comment (e.g. a trailing `// note`) is not an entry.
			if (/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/.test(entry)) continue;
			return null;
		}
		entries.push({ name: match[1]!, value: entry.slice(match[0].length), raw: entry });
	}
	return entries;
}

/** True when the entry value is an inline function the codemod can port (arrow with a single-line parameter list, or a function expression). Concise object-literal returns (`=> ({`) are rejected — they are not string `t` semantics. */
export function isPortableFunctionValue(value: string): boolean {
	const v = value.trim();
	if (/^function\b/.test(v)) return true;
	if (!v.startsWith("(")) {
		return /^[A-Za-z_$][\w$]*\s*=>/.test(v);
	}
	let depth = 0;
	let close = -1;
	for (let i = 0; i < v.length; i++) {
		const c = v[i]!;
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) { close = i; break; }
		}
	}
	if (close === -1) return false;
	const firstLineEnd = v.indexOf("\n");
	const firstLine = firstLineEnd === -1 ? v : v.slice(0, firstLineEnd);
	if (!firstLine.includes(")") || !/^\)[\s]*=>/.test(v.slice(close))) return false;
	// `=> ({ … })` returns an object literal — not a string `t`; hand work.
	return !/^\)[\s]*=>\s*\(\s*\{/.test(v.slice(close));
}

/** Drop the parameter annotations of a ported inline function — the seam's `TFunc`/`TDynamic` contextual types replace them (runtime untouched). Angle/round/curly/square brackets and their commas are tracked so `Record<string, unknown>` survives intact. */
export function stripParameterAnnotations(value: string): string {
	const open = value.indexOf("(");
	if (open === -1) return value;
	let depth = 0;
	let close = -1;
	for (let i = open; i < value.length; i++) {
		const c = value[i]!;
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) { close = i; break; }
		}
	}
	if (close === -1) return value;
	const params = value.slice(open + 1, close);
	// Scan the parameter list: cut each parameter at its first depth-0 `:`
	// (the name/annotation separator); everything after it — the annotation —
	// is dropped together with the separator.
	const kept: string[] = [];
	let bracketDepth = 0;
	let cutAt = -1;
	let paramStart = 0;
	for (let i = 0; i <= params.length; i++) {
		const c = params[i] ?? ",";
		if (bracketDepth === 0 && cutAt === -1 && c === ":") { cutAt = i; continue; }
		if (c === "(" || c === "[" || c === "{" || c === "<") bracketDepth++;
		else if (c === ")" || c === "]" || c === "}" || c === ">") bracketDepth--;
		else if (c === "," && bracketDepth === 0) {
			const end = cutAt === -1 ? i : cutAt;
			kept.push(params.slice(paramStart, end));
			paramStart = i + 1;
			cutAt = -1;
		}
	}
	return `${value.slice(0, open + 1)}${kept.join(",")}${value.slice(close)}`;
}

const IDENTITY_T = /^t: \((k|key)(?:: string)?\) => \1$/;
const IDENTITY_T_DYNAMIC = /^tDynamic: \((k|key)(?:: string)?\) => \1$/;
const IDENTITY_LOCALE = /^locale: "en"$/;
const IDENTITY_SET_LOCALE = /^setLocale: \(\) => \{\}$|^setLocale: NOOP$/;
const IDENTITY_READY = /^ready: true$/;
const IDENTITY_EXTRA_ENTRY =
	/^locale: "en"$|^setLocale: \(\) => \{\}$|^setLocale: NOOP$|^ready: true$/;

/** True when the entry (raw text, collapsed) is exactly one of the identity family's non-`t` fields. */
export function isIdentityExtraEntry(rawEntry: string): boolean {
	return IDENTITY_EXTRA_ENTRY.test(collapse(rawEntry));
}

/** A portable custom stub extracted from the mock's `useT` object (verbatim, annotation-stripped function bodies). */
export interface CustomSpecExtraction {
	readonly t: string;
	readonly tDynamic: string | null;
}

/**
 * Extract the `custom` spec when the mock is mechanically portable: `t` is an
 * inline function, `tDynamic` is an inline function or absent, and every other
 * `useT` field is the identity family. Named references (`t: stableT`),
 * non-identity `locale` entries (mutable-locale suites) and unparsable shapes
 * return null → OTHER → per-file hand work.
 */
export function extractCustomSpec(block: string): CustomSpecExtraction | null {
	const rawBody = extractUseTBodyRaw(block);
	if (rawBody === null) return null;
	const entries = parseUseTEntries(rawBody);
	if (entries === null) return null;
	const tEntry = entries.find((entry) => entry.name === "t");
	const tDynEntry = entries.find((entry) => entry.name === "tDynamic");
	if (!tEntry || !isPortableFunctionValue(tEntry.value)) return null;
	if (tDynEntry && !isPortableFunctionValue(tDynEntry.value)) return null;
	for (const entry of entries) {
		if (entry === tEntry || entry === tDynEntry) continue;
		if (!isIdentityExtraEntry(entry.raw)) return null;
	}
	return {
		t: stripParameterAnnotations(tEntry.value),
		tDynamic: tDynEntry ? stripParameterAnnotations(tDynEntry.value) : null,
	};
}

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
	if (spreadOk && extractCustomSpec(block) !== null) {
		return { file, classification: "CUSTOM", interpolateKeys: [], editable: true };
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

/** Build the multi-line `installI18nContextSeam({ custom: … })` call: verbatim function bodies, original indentation columns (the install call sits exactly where the mock sat, so every original column still lines up). */
function buildCustomCall(block: string, mockIndent: string): string {
	const spec = extractCustomSpec(block);
	if (spec === null) throw new Error("buildCustomCall: block is not CUSTOM-classified");
	const useTIndent = /^([ \t]*)useT\s*:/m.exec(block)?.[1] ?? "";
	const unit = useTIndent.startsWith(mockIndent) ? useTIndent.slice(mockIndent.length) : "  ";
	const entryIndent = `${mockIndent}${unit}${unit}`;
	const tLineIndent = /^([ \t]*)t\s*:/m.exec(block)?.[1] ?? entryIndent;
	const lines: string[] = [`${mockIndent}installI18nContextSeam({`, `${mockIndent}${unit}custom: {`];
	const emitField = (name: string, value: string, originalIndent: string) => {
		const valueLines = value.split("\n");
		// First line: re-anchored at the field's original column (annotation-stripped).
		lines.push(`${originalIndent}${name}:${valueLines[0]}`);
		// Continuation lines: byte-verbatim — their original columns are still correct.
		for (const line of valueLines.slice(1)) lines.push(line);
		lines[lines.length - 1] += ",";
	};
	emitField("t", spec.t, tLineIndent);
	if (spec.tDynamic !== null) {
		const tdLineIndent = /^([ \t]*)tDynamic\s*:/m.exec(block)?.[1] ?? entryIndent;
		emitField("tDynamic", spec.tDynamic, tdLineIndent);
	} else {
		lines.push(`${entryIndent}tDynamic: (key: string) => key,`);
	}
	lines.push(`${mockIndent}${unit}},`, `${mockIndent}});`);
	return lines.join("\n");
}

export function transformFile(src: string, plan: FilePlan): string | null {
	if (!plan.editable) return null;
	const span = findMockCallSpan(src);
	if (!span) return null;
	const lineStart = src.lastIndexOf("\n", span.start) + 1;
	const indent = src.slice(lineStart, span.start);
	const call =
		plan.classification === "CUSTOM"
			? buildCustomCall(src.slice(span.start, span.end), indent)
			: plan.interpolateKeys.length > 0
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
	const counts = { IDENTITY: 0, INTERPOLATED: 0, CUSTOM: 0, OTHER: 0, "ON-SEAM": 0 } as Record<MockClassification, number>;	const lines: string[] = [];
	for (const plan of plans) {
		counts[plan.classification]++;
		const spec = plan.interpolateKeys.length > 0 ? ` keys=[${plan.interpolateKeys.join(", ")}]` : "";
		const reason = plan.classification === "OTHER" ? ` — ${plan.reason}` : "";
		lines.push(`${plan.classification.padEnd(13)} ${plan.file}${spec}${reason}`);
	}
	const report = [
		`i18n mock codemod: ${dryRun ? "dry run" : "apply"} prefix="${prefix}" over ${files.length} test file(s)`,
		`identity: ${counts.IDENTITY}  interpolated: ${counts.INTERPOLATED}  custom: ${counts.CUSTOM}  other: ${counts.OTHER}  on-seam: ${counts["ON-SEAM"]}`,
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
