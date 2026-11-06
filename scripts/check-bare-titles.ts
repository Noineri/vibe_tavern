/**
 * check-bare-titles — ratchet guard for native-element `title` tooltip attributes.
 * fork #2 of check-bare-api-fetch (scripts/check-bare-api-fetch.ts): same
 * walk-apps/web/src-and-report shape; deviates by counting against a ratchet
 * budget (test-hygiene style) instead of failing on any hit, and by masking
 * string/comment literals before scanning — `title=` sits deep inside
 * multi-line opening tags, so the line-prefix comment skip of fork #1
 * (check-icon-button-labels) is not enough here.
 *
 * WHY (owner request 2026-10-20, plan repo: BARE_TITLE_TOOLTIPS_REPORT): a
 * native `title` attribute renders the browser's own off-theme tooltip,
 * unreachable on touch, wherever the app has a themed shared `CustomTooltip`
 * (apps/web/src/components/shared/Tooltip.tsx). The legacy tree carries a
 * stock of them; this check freezes the count so no new bare `title` lands
 * while the report's fix steps burn the stock down.
 *
 * What counts:
 *  - a `title="…"` / `title={…}` attribute on an INTRINSIC (lowercase) JSX
 *    element in a non-test .tsx under apps/web/src — multi-line opening tags
 *    included (strings and comments are masked first, so JSX inside template
 *    interpolations still scans as code);
 *  - EXEMPT: `iframe` — `title` there is the accessible name and must stay
 *    (an `<svg><title>` child element would likewise be exempt; none exist).
 * Not covered: `title` on PascalCase components (a prop, not a DOM attribute),
 * titles smuggled through a `{...spread}`, and literals inside regex literals
 * (a regex containing a quote can confuse the string mask — misses only,
 * never false hits; the report's inventory cross-checks against raw grep).
 *
 * RATCHET: fails only when the count GROWS past BARE_TITLE_BUDGET. A cleanup
 * lowers the budget in the same commit; never raise it.
 *
 * Run via `bun run check:bare-titles` (also part of `bun run check`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Snapshot of the tree on 2026-11-05 — the step-1 inventory table lives in
 *  plan repo BARE_TITLE_TOOLTIPS_REPORT. Lower after cleanups, never raise. */
export const BARE_TITLE_BUDGET = 0;

const ROOT = join(import.meta.dir, "..");
const WEB_SRC = join(ROOT, "apps", "web", "src");

/** Elements whose `title` is an accessible name, not a tooltip. */
const EXEMPT_ELEMENTS = new Set(["iframe"]);

export interface BareTitle {
	/** 1-based line of the element's `<name`. */
	line: number;
	/** Intrinsic element name, e.g. `div`. */
	element: string;
	/** Raw attribute value text (`"…"` literal or `{…}` expression), possibly truncated. */
	value: string;
}

/**
 * Replace string-literal contents and comments with spaces (newlines kept) so
 * scanning only ever matches real JSX. Length is preserved, so indices and
 * line numbers computed on the mask apply to the original. Template literals
 * are fully opaque (their `${`/`}` delimiters mask with the body); the code
 * INSIDE an interpolation is still scanned as code (nested literals masked).
 */
export function maskLiterals(src: string): string {
	const out = src.split("");
	const n = src.length;
	let i = 0;
	let mode: "code" | "tpl" = "code";
	// Brace depth per OPEN `${` interpolation whose template is unfinished.
	const frames: number[] = [];
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
	};
	const scanTemplate = (): void => {
		for (;;) {
			if (i >= n) return;
			const c = src[i];
			if (c === "\\") {
				blank(i, i + 2);
				i += 2;
				continue;
			}
			if (c === "`") {
				out[i] = " ";
				i++;
				mode = "code";
				return;
			}
			if (c === "$" && src[i + 1] === "{") {
				blank(i, i + 2);
				i += 2;
				frames.push(0);
				mode = "code";
				return;
			}
			if (c !== "\n") out[i] = " ";
			i++;
		}
	};
	while (i < n) {
		if (mode === "tpl") {
			scanTemplate();
			continue;
		}
		const ch = src[i];
		const next = i + 1 < n ? src[i + 1] : "";
		if (ch === "/" && next === "/") {
			let j = i;
			while (j < n && src[j] !== "\n") j++;
			blank(i, j);
			i = j;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = src.indexOf("*/", i + 2);
			const j = end === -1 ? n : end + 2;
			blank(i, j);
			i = j;
			continue;
		}
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < n && src[j] !== ch) {
				if (src[j] === "\\") j++;
				j++;
			}
			blank(i + 1, Math.min(j, n)); // keep delimiters, mask content
			i = Math.min(j + 1, n);
			continue;
		}
		if (ch === "`") {
			out[i] = " ";
			i++;
			mode = "tpl";
			continue;
		}
		if (ch === "{") {
			if (frames.length) frames[frames.length - 1]++;
			i++;
			continue;
		}
		if (ch === "}") {
			if (frames.length) {
				const depth = frames[frames.length - 1];
				if (depth > 0) frames[frames.length - 1] = depth - 1;
				else {
					frames.pop();
					out[i] = " "; // the interpolation's closing brace is part of the literal
					mode = "tpl"; // back into the owning template body
				}
			}
			i++;
			continue;
		}
		i++;
	}
	return out.join("");
}

/** End index (exclusive) of the JSX opening tag starting at `start` (`<div`),
 *  skipping `>` inside `{…}` expressions and quoted attribute values. */
function openingTagEnd(src: string, start: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = start + 1; i < src.length; i++) {
		const ch = src[i];
		if (quote !== null) {
			if (ch === quote) quote = null;
			continue;
		}
		if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
		else if (ch === "{") depth++;
		else if (ch === "}" && depth > 0) depth--;
		else if (ch === ">" && depth === 0) return i + 1;
	}
	return src.length;
}

/** Attribute value text after `title=`, from the ORIGINAL source. */
function attrValue(tag: string): string {
	const at = tag.search(/\stitle\s*=/);
	if (at === -1) return "";
	let i = at + tag.slice(at).indexOf("=") + 1;
	while (i < tag.length && /\s/.test(tag[i])) i++;
	if (tag[i] === '"' || tag[i] === "'") {
		const end = tag.indexOf(tag[i], i + 1);
		return tag.slice(i, end === -1 ? tag.length : end + 1);
	}
	if (tag[i] === "{") {
		let depth = 0;
		let j = i;
		for (; j < tag.length; j++) {
			if (tag[j] === "{") depth++;
			else if (tag[j] === "}") {
				depth--;
				if (depth === 0) {
					j++;
					break;
				}
			}
		}
		const text = tag.slice(i, j).replace(/\s+/g, " ");
		return text.length > 60 ? `${text.slice(0, 57)}…` : text;
	}
	return tag.slice(i, i + 20);
}

const INTRINSIC_RE = /<([a-z][a-zA-Z0-9]*)(?=[\s/>])/g;
// `<name` must not continue an identifier/call/index — kills generic args
// like `useState<record<…>>` and member access; comparisons like `a < b`
// can still match the name but never carry a `title=`, so they stay inert.
const PREV_CHAR_RE = /[A-Za-z0-9_$.)\]]/;
// Attribute position: always whitespace-separated after the element name.
const TITLE_ATTR_RE = /\stitle\s*=/;

/** Bare native `title` attributes in one source file's intrinsic JSX. */
export function findBareTitles(src: string): BareTitle[] {
	const masked = maskLiterals(src);
	const hits: BareTitle[] = [];
	for (let m = INTRINSIC_RE.exec(masked); m !== null; m = INTRINSIC_RE.exec(masked)) {
		if (m.index > 0 && PREV_CHAR_RE.test(masked[m.index - 1])) continue;
		const element = m[1];
		const tagEnd = openingTagEnd(masked, m.index);
		const tag = masked.slice(m.index, tagEnd);
		if (!TITLE_ATTR_RE.test(tag)) continue;
		if (EXEMPT_ELEMENTS.has(element)) continue;
		hits.push({
			line: src.slice(0, m.index).split("\n").length,
			element,
			value: attrValue(src.slice(m.index, tagEnd)),
		});
	}
	return hits;
}

function* walkTsx(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walkTsx(full);
			continue;
		}
		if (entry.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(entry)) yield full;
	}
}

function main(): number {
	const hits: string[] = [];
	let scanned = 0;
	for (const file of walkTsx(WEB_SRC)) {
		scanned++;
		const rel = relative(ROOT, file).replace(/\\/g, "/");
		for (const hit of findBareTitles(readFileSync(file, "utf8"))) {
			hits.push(`${rel}:${hit.line} <${hit.element}> ${hit.value}`);
		}
	}

	if (hits.length > BARE_TITLE_BUDGET) {
		console.error(`Bare-title guard: FAIL — ${hits.length} native title attributes > budget ${BARE_TITLE_BUDGET} (${scanned} files scanned)`);
		console.error("  A native `title` renders the browser's off-theme tooltip (unreachable on touch).");
		console.error("  Use the shared CustomTooltip, keep `title` only on <iframe> (accessible name),");
		console.error("  or drop it when it repeats visible text. The budget is a ratchet — never raise it. All current hits:");
		for (const hit of hits) console.error(`    ${hit}`);
		return 1;
	}
	const slack = BARE_TITLE_BUDGET - hits.length;
	console.log(
		`Bare-title guard: OK (${scanned} files scanned, ${hits.length}/${BARE_TITLE_BUDGET} native title attributes)` +
			(slack > 0 ? ` — lower BARE_TITLE_BUDGET to ${hits.length} in scripts/check-bare-titles.ts` : ""),
	);
	return 0;
}

if (import.meta.main) process.exitCode = main();
