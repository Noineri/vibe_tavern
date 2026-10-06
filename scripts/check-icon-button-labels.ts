/**
 * check-icon-button-labels — ratchet guard for unnamed icon-only buttons.
 * fork #1 of check-bare-api-fetch (scripts/check-bare-api-fetch.ts): same
 * walk-apps/web/src-and-report shape; deviates by counting against a ratchet
 * budget (test-hygiene style) instead of failing on any hit.
 *
 * WHY (owner request 2026-10-01): agents drive the live app through the
 * accessibility tree (Playwright snapshots). A `<button>` whose only content is
 * an icon and that carries no `aria-label` / `aria-labelledby` / `title` shows
 * up there as a bare "button" — the agent has to guess or screenshot, and a
 * screen-reader user hears nothing. The legacy tree has such buttons; this
 * check freezes their count so no new ones land while the backlog is burned
 * down (plan repo: ICON_BUTTON_ARIA_LABELS_REPORT).
 *
 * What counts (deliberately conservative — a false positive would block a
 * commit for nothing):
 *  - an intrinsic `<button …>` in a non-test .tsx under apps/web/src;
 *  - no `aria-label`, `aria-labelledby` or `title` attribute, and no `{...spread}`
 *    (a spread may carry the label);
 *  - the content is empty or ONLY self-closing JSX elements (`<XIcon size={14} />`)
 *    plus whitespace and JSX comments. Text, `{t("…")}`, `{label}`, ternaries and
 *    nested non-self-closing elements are assumed to name the button.
 * Not covered: custom button components, Radix triggers with `asChild`,
 * clickable non-button elements (the report tracks widening the net).
 *
 * RATCHET: fails only when the count GROWS past ICON_BUTTON_LABEL_BUDGET. A
 * cleanup lowers the budget in the same commit; never raise it.
 *
 * Run via `bun run check:icon-button-labels` (also part of `bun run check`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Snapshot of the tree on 2026-10-01. Lower after cleanups, never raise. */
export const ICON_BUTTON_LABEL_BUDGET = 70;

const ROOT = join(import.meta.dir, "..");
const WEB_SRC = join(ROOT, "apps", "web", "src");

const NAMING_ATTR_RE = /\s(?:aria-label|aria-labelledby|title)\s*=/;
const SPREAD_ATTR_RE = /\{\s*\.\.\./;

/** End index (exclusive) of the JSX opening tag starting at `start` (`<button`),
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
		else if (ch === "}") depth--;
		else if (ch === ">" && depth === 0) return i + 1;
	}
	return src.length;
}

/** True when the button content names nothing: only self-closing elements,
 *  JSX comments and whitespace. */
export function isIconOnlyContent(content: string): boolean {
	let rest = content.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
	for (;;) {
		const open = rest.indexOf("<");
		if (open === -1) break;
		const end = openingTagEnd(rest, open);
		const tag = rest.slice(open, end);
		if (!tag.endsWith("/>")) return false;
		rest = rest.slice(0, open) + rest.slice(end);
	}
	return rest.trim() === "";
}

/** 1-based line numbers of unnamed icon-only `<button>`s in one source file. */
export function findUnlabeledIconButtons(src: string): number[] {
	const lines: number[] = [];
	const re = /<button(?=[\s/>])/g;
	for (let m = re.exec(src); m !== null; m = re.exec(src)) {
		const lineStart = src.lastIndexOf("\n", m.index) + 1;
		const linePrefix = src.slice(lineStart, m.index).trimStart();
		// Comment-only lines never count (mirrors test-hygiene).
		if (linePrefix.startsWith("//") || linePrefix.startsWith("*")) continue;

		const tagEnd = openingTagEnd(src, m.index);
		const tag = src.slice(m.index, tagEnd);
		if (NAMING_ATTR_RE.test(tag) || SPREAD_ATTR_RE.test(tag)) continue;

		let content = "";
		if (!tag.endsWith("/>")) {
			const close = src.indexOf("</button>", tagEnd);
			if (close === -1) continue;
			content = src.slice(tagEnd, close);
		}
		if (isIconOnlyContent(content)) {
			lines.push(src.slice(0, m.index).split("\n").length);
		}
	}
	return lines;
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
		for (const line of findUnlabeledIconButtons(readFileSync(file, "utf8"))) {
			hits.push(`${rel}:${line}`);
		}
	}

	if (hits.length > ICON_BUTTON_LABEL_BUDGET) {
		console.error(`Icon-button label guard: FAIL — ${hits.length} unnamed icon-only buttons > budget ${ICON_BUTTON_LABEL_BUDGET} (${scanned} files scanned)`);
		console.error("  An icon-only <button> needs an accessible name: aria-label={t(\"…\")} (both locales),");
		console.error("  or aria-labelledby / title. Agents (Playwright snapshots) and screen readers see a bare \"button\" otherwise.");
		console.error("  The budget is a ratchet — label the new button, never raise the number. All current hits:");
		for (const hit of hits) console.error(`    ${hit}`);
		return 1;
	}
	const slack = ICON_BUTTON_LABEL_BUDGET - hits.length;
	console.log(
		`Icon-button label guard: OK (${scanned} files scanned, ${hits.length}/${ICON_BUTTON_LABEL_BUDGET} unnamed icon-only buttons)` +
			(slack > 0 ? ` — lower ICON_BUTTON_LABEL_BUDGET to ${hits.length} in scripts/check-icon-button-labels.ts` : ""),
	);
	return 0;
}

if (import.meta.main) process.exitCode = main();
