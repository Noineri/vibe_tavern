/**
 * Fixed font-size → UI ladder codemod (FIXED_FONT_SIZE_AUDIT_REPORT, step 1).
 *
 * The app sizes chrome text through the `--ui-fs` CSS variable (Tweaks "UI
 * font size"); fixed pixel classes, Tailwind size classes and inline sizes
 * ignore the setting and render ~3px small next to ladder-sized neighbours at
 * the default 17px. This script is the one mechanical mapping every area step
 * reuses — no hand conversion:
 *
 * - `text-[Npx]`                → `text-[calc(var(--ui-fs)-Kpx)]`, K = 14 - N
 *                                  (N = 14 → `text-[var(--ui-fs)]`, N > 14 → `+K`;
 *                                  |K| rounds DOWN — ladder offsets are whole
 *                                  pixels only: 12.5px → `-1px`, 10.5px →
 *                                  `-3px`, 15.5px → `+1px`)
 * - `text-[Nrem]`               → the same ladder via Nrem × 16px — rem tracks
 *                                  the 16px browser root (the app never moves
 *                                  the root; `body` carries `--ui-fs`), so a
 *                                  rem class is a fixed size deaf to the
 *                                  setting: 0.8rem = 12.8px → `-1px`, 0.9rem
 *                                  = 14.4px → the bare variable (step 9a)
 * - `text-xs|sm|base|lg|xl|2xl` → the calc class for the class's px at the
 *                                  16px root PLUS its Tailwind line height
 *                                  (`leading-4/5/6/7/7/8`) — an arbitrary value
 *                                  class carries no line height of its own.
 * - `fontSize: 18` / `"12px"`   → `fontSize: "calc(var(--ui-fs)±Kpx)"`
 * - `font-size: Npx` in styles.css → `font-size: calc(var(--ui-fs)±Kpx)`
 *
 * Not `--ui-fs`: roleplay message content follows the chat font size `--mfs`
 * (reference 17px). Files under `components/chat/` with a `message*` path
 * segment are LISTED, not converted, in the default mode — every occurrence
 * there is a per-occurrence decision for the area step; `--mfs` converts
 * exactly those files onto the `--mfs` ladder (point it at the decided
 * files/folders; non-message files are listed, not converted, in that mode).
 * `--var ui` overrides the listing for message files the area step decided
 * are chrome, not message content: it converts exactly those files onto the
 * `--ui-fs` ladder with the unchanged mapping table (font audit step 8).
 *
 * Flag, don't silently convert: text inside a fixed-size box (`h-4` / `h-5` /
 * `w-4` / `w-5` / `size-*`) can overflow once it grows — such matches are
 * converted AND listed for the worker to check the box. A Tailwind size class
 * converted on a line that already carries ANY `leading-*` — numeric, named
 * (`leading-none` / `leading-snug` / …) or arbitrary (`leading-[1.4]`) — keeps
 * that line height (no companion added) and is listed too (font audit step
 * 9a: steps 3–8 caught false numeric companions beside authored named
 * leadings by manual sweep; the pattern now sees them mechanically).
 *
 * Scope: `*.ts` / `*.tsx` under `apps/web/src` (test files and
 * `components/dev/` excluded) plus `apps/web/src/styles.css`. Theme css and
 * the experience starter templates are out of scope: themes define the ladder
 * variables themselves, and starter frames are isolated documents where the
 * variables do not exist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

export const UI_FS_VARIABLE = "--ui-fs";
export const MFS_VARIABLE = "--mfs";
export const UI_FS_REFERENCE_PX = 14;
export const MFS_REFERENCE_PX = 17;

export const UI_FS_LADDER: LadderOptions = {};
export const MFS_LADDER: LadderOptions = { variable: MFS_VARIABLE, referencePx: MFS_REFERENCE_PX };

export type FontSizeKind = "pixel-class" | "rem-class" | "tailwind-size-class" | "inline-font-size" | "css-font-size";

export interface FontSizeMatch {
	readonly kind: FontSizeKind;
	readonly text: string;
	readonly sizePx: number;
	readonly offset: number;
	readonly line: number;
	readonly column: number;
}

/** Tailwind font-size utilities with their px at the 16px root and the line
 *  height the class carries (the arbitrary replacement must state it). */
export const TAILWIND_SIZE_LADDER = {
	xs: { px: 12, leading: "leading-4" },
	sm: { px: 14, leading: "leading-5" },
	base: { px: 16, leading: "leading-6" },
	lg: { px: 18, leading: "leading-7" },
	xl: { px: 20, leading: "leading-7" },
	"2xl": { px: 24, leading: "leading-8" },
} as const;

export type TailwindSizeClass = keyof typeof TAILWIND_SIZE_LADDER;

export const PIXEL_CLASS_PATTERN = /(?<![\w-])text-\[(\d+(?:\.\d+)?)px\]/g;
/** Rem classes track the 16px browser root (the app never moves the root;
 *  `body` carries `--ui-fs`), so `text-[Nrem]` is a fixed size just like
 *  `text-[Npx]` — mapped at Nrem × 16px onto the ladder (font audit step 9a). */
export const REM_ROOT_PX = 16;
export const REM_CLASS_PATTERN = /(?<![\w-])text-\[(\d+(?:\.\d+)?)rem\]/g;
export const TAILWIND_SIZE_CLASS_PATTERN = /(?<![\w-])text-(xs|sm|base|lg|xl|2xl)(?![\w-])/g;
export const INLINE_FONT_SIZE_PATTERN = /(?<![\w.])fontSize:\s*(?:"(\d+(?:\.\d+)?)px"|(\d+(?:\.\d+)?))/g;
export const CSS_FONT_SIZE_PATTERN = /(?<![\w-])font-size:\s*(\d+(?:\.\d+)?)px/g;
export const FIXED_SIZE_BOX_PATTERN = /(?<![\w-])(?:h-4|h-5|w-4|w-5|size-(?:\d+(?:\.\d+)?|\[[^\]\s]*\]))(?![\w-])/;
/** ANY `leading-*` utility — numeric (`leading-5`), named (`leading-none`,
 *  `leading-snug`, `leading-relaxed`, …) or arbitrary (`leading-[1.4]`). A
 *  converted Tailwind size class never adds its numeric companion beside an
 *  existing one (font audit step 9a). */
export const LEADING_CLASS_PATTERN = /(?<![\w-])leading-(?:\d+(?:\.\d+)?|none|tight|snug|normal|relaxed|loose|\[[^\]\s]*\])(?![\w-])/;

export const FONT_SIZE_ROOT = "apps/web/src";
export const FONT_SIZE_CSS_TARGET = `${FONT_SIZE_ROOT}/styles.css`;
export const FONT_SIZE_DEV_ROOT = `${FONT_SIZE_ROOT}/components/dev`;
export const CHAT_MESSAGE_ROOT = `${FONT_SIZE_ROOT}/components/chat`;

/** Known false positives — counted by nothing, converted by nothing. */
export const FONT_SIZE_EXEMPT_FILES = {
	[`${FONT_SIZE_ROOT}/lib/local-storage.ts`]:
		"DEFAULT_TWEAKS.fontSize is the chat font-size setting (the --mfs source), not a rendered style",
} as const;

/** Report areas (FIXED_FONT_SIZE_AUDIT_REPORT census); everything else is "rest". */
export const FONT_SIZE_AREAS = [
	"build",
	"settings",
	"shared",
	"chat",
	"coauthor",
	"modals",
	"experience",
	"context",
	"layout",
] as const;

export interface LadderOptions {
	readonly variable?: string;
	readonly referencePx?: number;
}

function normalizeRelativePath(file: string): string {
	return file.split(path.sep).join("/");
}

/** The ladder value for a px size: `calc(var(--ui-fs)-3px)` / `var(--ui-fs)`.
 *  Offsets are whole pixels only (FIXED_FONT_SIZE_AUDIT_REPORT diagnosis 6):
 *  the ladder variables are whole numbers, so a fractional offset always
 *  lands between pixels and smears glyph edges. The offset rounds toward the
 *  base — its absolute value rounds down (12.5px → `-1px`, 10.5px → `-3px`,
 *  15.5px → `+1px`); the `--mfs` reference follows the same rule. */
export function ladderValue(sizePx: number, options: LadderOptions = {}): string {
	const variable = options.variable ?? UI_FS_VARIABLE;
	const referencePx = options.referencePx ?? UI_FS_REFERENCE_PX;
	if (sizePx === referencePx) return `var(${variable})`;
	const offset = Math.floor(Math.abs(sizePx - referencePx));
	if (offset === 0) return `var(${variable})`;
	const sign = sizePx < referencePx ? "-" : "+";
	return `calc(var(${variable})${sign}${offset}px)`;
}

export function pixelClassFor(sizePx: number, options: LadderOptions = {}): string {
	return `text-[${ladderValue(sizePx, options)}]`;
}

/** The ladder class for a rem size — rem × 16px onto the same ladder. */
export function remClassFor(sizeRem: number, options: LadderOptions = {}): string {
	return `text-[${ladderValue(sizeRem * REM_ROOT_PX, options)}]`;
}

/** The arbitrary class plus the line-height companion the size class carried. */
export function tailwindClassFor(sizeClass: TailwindSizeClass, options: LadderOptions = {}): string {
	const step = TAILWIND_SIZE_LADDER[sizeClass];
	return `${pixelClassFor(step.px, options)} ${step.leading}`;
}

export function inlineFontSizeFor(sizePx: number, options: LadderOptions = {}): string {
	return `fontSize: "${ladderValue(sizePx, options)}"`;
}

export function cssFontSizeFor(sizePx: number, options: LadderOptions = {}): string {
	return `font-size: ${ladderValue(sizePx, options)}`;
}

/** Why a repo-relative file is out of codemod scope, or undefined when in scope. */
export function fontSizeScopeRejection(file: string): string | undefined {
	const normalized = normalizeRelativePath(file);
	const exemption = (FONT_SIZE_EXEMPT_FILES as Record<string, string>)[normalized];
	if (exemption !== undefined) return `exempt — ${exemption}`;
	if (normalized === FONT_SIZE_CSS_TARGET) return undefined;
	if (!normalized.startsWith(`${FONT_SIZE_ROOT}/`)) return `outside ${FONT_SIZE_ROOT}`;
	if (normalized.startsWith(`${FONT_SIZE_DEV_ROOT}/`)) return "components/dev is excluded";
	if (/\.test\.(?:ts|tsx)$/.test(normalized)) return "test file";
	if (!/\.(?:ts|tsx)$/.test(normalized)) return "not a .ts/.tsx source (styles.css is the only css target)";
	return undefined;
}

export function isFontSizeScopeFile(file: string): boolean {
	return fontSizeScopeRejection(file) === undefined;
}

/** Chat message files (`components/chat/**` with a `message*` path segment) —
 *  message content candidates: listed, not converted, in the default mode. */
export function isChatMessageFile(file: string): boolean {
	const normalized = normalizeRelativePath(file);
	if (!normalized.startsWith(`${CHAT_MESSAGE_ROOT}/`)) return false;
	return normalized
		.slice(CHAT_MESSAGE_ROOT.length + 1)
		.split("/")
		.some((segment) => segment.toLowerCase().startsWith("message"));
}

export function fontSizeArea(file: string): string {
	const normalized = normalizeRelativePath(file);
	const componentsPrefix = `${FONT_SIZE_ROOT}/components/`;
	if (!normalized.startsWith(componentsPrefix)) return "rest";
	const area = normalized.slice(componentsPrefix.length).split("/")[0] ?? "";
	return (FONT_SIZE_AREAS as readonly string[]).includes(area) ? `components/${area}` : "rest";
}

function collectLineStarts(source: string): number[] {
	const starts = [0];
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function positionAt(lineStarts: readonly number[], offset: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let index = 0; index < lineStarts.length; index++) {
		const start = lineStarts[index];
		if (start === undefined || start > offset) break;
		line = index + 1;
		lineStart = start;
	}
	return { line, column: offset - lineStart + 1 };
}

/** All fixed font sizes in a source file, in source order.
 *  The css rule applies to the styles.css target only. */
export function collectFixedFontSizeMatches(file: string, source: string): FontSizeMatch[] {
	const lineStarts = collectLineStarts(source);
	const matches: FontSizeMatch[] = [];
	const push = (kind: FontSizeKind, text: string, sizePx: number, offset: number): void => {
		const { line, column } = positionAt(lineStarts, offset);
		matches.push({ kind, text, sizePx, offset, line, column });
	};

	for (const match of source.matchAll(PIXEL_CLASS_PATTERN)) {
		if (match.index === undefined || match[1] === undefined) continue;
		push("pixel-class", match[0], Number.parseFloat(match[1]), match.index);
	}
	for (const match of source.matchAll(REM_CLASS_PATTERN)) {
		if (match.index === undefined || match[1] === undefined) continue;
		push("rem-class", match[0], Number.parseFloat(match[1]) * REM_ROOT_PX, match.index);
	}
	for (const match of source.matchAll(TAILWIND_SIZE_CLASS_PATTERN)) {
		const sizeClass = match[1] as TailwindSizeClass | undefined;
		if (match.index === undefined || sizeClass === undefined) continue;
		push("tailwind-size-class", match[0], TAILWIND_SIZE_LADDER[sizeClass].px, match.index);
	}
	for (const match of source.matchAll(INLINE_FONT_SIZE_PATTERN)) {
		const raw = match[1] ?? match[2];
		if (match.index === undefined || raw === undefined) continue;
		push("inline-font-size", match[0], Number.parseFloat(raw), match.index);
	}
	if (normalizeRelativePath(file) === FONT_SIZE_CSS_TARGET) {
		for (const match of source.matchAll(CSS_FONT_SIZE_PATTERN)) {
			if (match.index === undefined || match[1] === undefined) continue;
			push("css-font-size", match[0], Number.parseFloat(match[1]), match.index);
		}
	}
	return matches.sort((left, right) => left.offset - right.offset);
}

export interface FontSizeReplacement {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export interface FontSizeConversion {
	/** Repo-relative file the conversion ran on. */
	readonly file: string;
	readonly mode: "ui-fs" | "mfs";
	/** True when the ladder conversion was applied (listed/skipped files keep their source). */
	readonly converted: boolean;
	readonly output: string;
	readonly matches: readonly FontSizeMatch[];
	readonly replacements: readonly FontSizeReplacement[];
	/** Converted, but the line also carries a fixed-size box — check the box grows with the text. */
	readonly flaggedFixedSizeBox: readonly FontSizeMatch[];
	/** Converted without the leading companion because an explicit leading-* stays on the line. */
	readonly flaggedLeadingConflict: readonly FontSizeMatch[];
	/** Default mode + chat message file: listed for the per-occurrence --mfs decision, not converted. */
	readonly listedMfsDecision: readonly FontSizeMatch[];
	/** --mfs mode + non-message file: out of scope for that mode, not converted. */
	readonly skippedNotChatMessage: boolean;
}

function lineTextAt(source: string, lineStarts: readonly number[], offset: number): string {
	let start = 0;
	let end = source.length;
	for (let index = 0; index < lineStarts.length; index++) {
		const candidate = lineStarts[index];
		if (candidate === undefined) continue;
		if (candidate <= offset) start = candidate;
		else {
			end = candidate;
			break;
		}
	}
	return source.slice(start, end);
}

function spliceReplacements(source: string, replacements: readonly FontSizeReplacement[]): string {
	let output = "";
	let cursor = 0;
	for (const replacement of replacements) {
		if (replacement.start < cursor) throw new Error(`overlapping font-size replacement at offset ${replacement.start}`);
		output += source.slice(cursor, replacement.start) + replacement.text;
		cursor = replacement.end;
	}
	return output + source.slice(cursor);
}

/** Convert one source file onto the ladder. Pure: (file, source, options) → conversion.
 *  `var: "ui"` forces the `--ui-fs` ladder even for chat message files (the
 *  area step's per-occurrence chrome decision); `var: "mfs"` equals `mfs: true`.
 *  `only` restricts the conversion to the listed match kinds (font audit step
 *  9a: `--only rem` converts a file's rem classes without touching the pixel /
 *  Tailwind residue a later area step owns). */
export function convertSourceFontSizes(
	file: string,
	source: string,
	options: { readonly mfs?: boolean; readonly var?: "ui" | "mfs"; readonly only?: readonly FontSizeKind[] } = {},
): FontSizeConversion {
	const normalized = normalizeRelativePath(file);
	const mfsMode = options.var === "mfs" || (options.var === undefined && options.mfs === true);
	const forceUi = options.var === "ui";
	const chatMessage = isChatMessageFile(normalized);
	const ladder = mfsMode ? MFS_LADDER : UI_FS_LADDER;
	const collected = collectFixedFontSizeMatches(normalized, source);
	const matches = options.only === undefined ? collected : collected.filter((match) => options.only?.includes(match.kind));
	const base = { file: normalized, mode: mfsMode ? ("mfs" as const) : ("ui-fs" as const), matches };

	if (mfsMode && !chatMessage) {
		return {
			...base,
			converted: false,
			output: source,
			replacements: [],
			flaggedFixedSizeBox: [],
			flaggedLeadingConflict: [],
			listedMfsDecision: [],
			skippedNotChatMessage: true,
		};
	}
	if (!mfsMode && chatMessage && !forceUi) {
		return {
			...base,
			converted: false,
			output: source,
			replacements: [],
			flaggedFixedSizeBox: [],
			flaggedLeadingConflict: [],
			listedMfsDecision: matches,
			skippedNotChatMessage: false,
		};
	}

	const lineStarts = collectLineStarts(source);
	const replacements: FontSizeReplacement[] = [];
	const flaggedFixedSizeBox: FontSizeMatch[] = [];
	const flaggedLeadingConflict: FontSizeMatch[] = [];
	for (const match of matches) {
		const line = lineTextAt(source, lineStarts, match.offset);
		if (FIXED_SIZE_BOX_PATTERN.test(line)) flaggedFixedSizeBox.push(match);
		let replacement: string;
		if (match.kind === "pixel-class" || match.kind === "rem-class") {
			replacement = pixelClassFor(match.sizePx, ladder);
		} else if (match.kind === "tailwind-size-class") {
			const sizeClass = match.text.slice("text-".length) as TailwindSizeClass;
			if (LEADING_CLASS_PATTERN.test(line)) {
				flaggedLeadingConflict.push(match);
				replacement = pixelClassFor(TAILWIND_SIZE_LADDER[sizeClass].px, ladder);
			} else {
				replacement = tailwindClassFor(sizeClass, ladder);
			}
		} else if (match.kind === "inline-font-size") {
			replacement = inlineFontSizeFor(match.sizePx, ladder);
		} else {
			replacement = cssFontSizeFor(match.sizePx, ladder);
		}
		replacements.push({ start: match.offset, end: match.offset + match.text.length, text: replacement });
	}

	return {
		...base,
		converted: true,
		output: spliceReplacements(source, replacements),
		replacements,
		flaggedFixedSizeBox,
		flaggedLeadingConflict,
		listedMfsDecision: [],
		skippedNotChatMessage: false,
	};
}

/** Repo-relative scope files under a target path (file or directory), sorted. */
export function collectFontSizeTargetFiles(target: string, root: string = process.cwd()): string[] {
	const absolute = path.resolve(root, target);
	if (!existsSync(absolute)) throw new Error(`path not found: ${target}`);
	const relative = normalizeRelativePath(path.relative(root, absolute));
	if (statSync(absolute).isFile()) {
		const rejection = fontSizeScopeRejection(relative);
		if (rejection !== undefined) throw new Error(`${relative} is out of codemod scope (${rejection})`);
		return [relative];
	}
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const child = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(child);
			} else if (entry.isFile() && /\.(?:ts|tsx|css)$/.test(entry.name)) {
			const childRelative = normalizeRelativePath(path.relative(root, child));
				if (isFontSizeScopeFile(childRelative)) files.push(childRelative);
			}
		}
	};
	walk(absolute);
	return [...new Set(files)].sort();
}

export interface FontSizeRunOptions {
	readonly dryRun?: boolean;
	readonly mfs?: boolean;
	readonly var?: "ui" | "mfs";
	readonly only?: readonly FontSizeKind[];
	readonly root?: string;
}

export interface FontSizeRunOutcome {
	readonly report: string;
	readonly changedFiles: string[];
	readonly scopedFiles: string[];
}

function countKind(conversions: readonly FontSizeConversion[], kind: FontSizeKind): number {
	return conversions.reduce((total, conversion) => total + conversion.matches.filter((match) => match.kind === kind).length, 0);
}

function formatMatchLocations(conversions: readonly FontSizeConversion[], select: (conversion: FontSizeConversion) => readonly FontSizeMatch[]): string[] {
	const lines: string[] = [];
	for (const conversion of conversions) {
		for (const match of select(conversion)) lines.push(`  ${conversion.file}:${match.line}:${match.column}  ${match.text}`);
	}
	return lines;
}

/** Deterministic dry-run/write report: per-area totals, per-file counts, flagged lists. */
export function formatFontSizeRunReport(
	conversions: readonly FontSizeConversion[],
	info: { readonly target: string; readonly mfs: boolean; readonly dryRun: boolean; readonly written: number },
): string {
	const withMatches = conversions.filter((conversion) => conversion.matches.length > 0);
	const totalMatches = conversions.reduce((total, conversion) => total + conversion.matches.length, 0);
	const lines: string[] = [];
	lines.push(
		`font-size codemod: ${info.dryRun ? "dry run " : ""}${info.target} (mode: ${
			info.mfs ? `${MFS_VARIABLE}, ${MFS_REFERENCE_PX}px reference` : `${UI_FS_VARIABLE}, ${UI_FS_REFERENCE_PX}px reference`
		})`,
	);

	const areaOrder = [...FONT_SIZE_AREAS.map((area) => `components/${area}`), "rest"];
	const areas = new Map<string, { occurrences: number; files: number; agentShell: number; agentShellFiles: number }>();
	for (const conversion of withMatches) {
		const area = fontSizeArea(conversion.file);
		const entry = areas.get(area) ?? { occurrences: 0, files: 0, agentShell: 0, agentShellFiles: 0 };
		entry.occurrences += conversion.matches.length;
		entry.files += 1;
		if (conversion.file.startsWith("apps/web/src/components/shared/agent-shell/")) {
			entry.agentShell += conversion.matches.length;
			entry.agentShellFiles += 1;
		}
		areas.set(area, entry);
	}
	lines.push("areas:");
	for (const area of areaOrder) {
		const entry = areas.get(area);
		if (entry === undefined) continue;
		const agentShellNote = area === "components/shared" && entry.agentShell > 0 ? ` (agent-shell: ${entry.agentShell} in ${entry.agentShellFiles})` : "";
		lines.push(`  ${area}  ${entry.occurrences} in ${entry.files} file(s)${agentShellNote}`);
	}

	lines.push("files:");
	for (const conversion of withMatches) {
		const counts = {
			"pixel-class": 0,
			"rem-class": 0,
			"tailwind-size-class": 0,
			"inline-font-size": 0,
			"css-font-size": 0,
		} as Record<FontSizeKind, number>;
		for (const match of conversion.matches) counts[match.kind] += 1;
		lines.push(
			`  ${conversion.file}  ${conversion.matches.length} (pixel ${counts["pixel-class"]}, rem ${counts["rem-class"]}, tailwind ${counts["tailwind-size-class"]}, inline ${counts["inline-font-size"]}, css ${counts["css-font-size"]})${
				conversion.converted ? "" : conversion.skippedNotChatMessage ? "  [not converted: not message content]" : "  [not converted: --mfs decision]"
			}`,
		);
	}

	const sections: Array<[string, (conversion: FontSizeConversion) => readonly FontSizeMatch[]]> = [
		["flagged — fixed-size box (converted; check the box still fits):", (conversion) => conversion.flaggedFixedSizeBox],
		["flagged — explicit leading kept, companion not added:", (conversion) => conversion.flaggedLeadingConflict],
		["--mfs decision — NOT converted (decide per occurrence, rerun with --mfs):", (conversion) => conversion.listedMfsDecision],
	];
	for (const [header, select] of sections) {
		const locations = formatMatchLocations(conversions, select);
		if (locations.length === 0) continue;
		lines.push(header, ...locations);
	}

	lines.push(
		`totals: ${totalMatches} occurrence(s) in ${withMatches.length} file(s) — pixel ${countKind(conversions, "pixel-class")}, rem ${countKind(
			conversions,
			"rem-class",
		)}, tailwind ${countKind(conversions, "tailwind-size-class")}, inline ${countKind(conversions, "inline-font-size")}, css ${countKind(conversions, "css-font-size")}`,
	);
	lines.push(info.dryRun ? "dry run — no files written" : `written: ${info.written} file(s)`);
	return lines.join("\n");
}

export async function runFontSizeCodemod(target: string, options: FontSizeRunOptions = {}): Promise<FontSizeRunOutcome> {
	const root = options.root ?? process.cwd();
	const files = collectFontSizeTargetFiles(target, root);
	const conversions: FontSizeConversion[] = [];
	const changedFiles: string[] = [];
	for (const file of files) {
		const source = readFileSync(path.resolve(root, file), "utf8");
		const conversion = convertSourceFontSizes(file, source, { mfs: options.mfs, var: options.var, only: options.only });
		conversions.push(conversion);
		if (options.dryRun !== true && conversion.converted && conversion.output !== source) {
			await Bun.write(path.resolve(root, file), conversion.output);
			changedFiles.push(file);
		}
	}
	const report = formatFontSizeRunReport(conversions, { target, mfs: options.var === "mfs" || (options.var === undefined && options.mfs === true), dryRun: options.dryRun === true, written: changedFiles.length });
	return { report, changedFiles, scopedFiles: files };
}

function usage(): string {
	return [
		"usage: bun scripts/font-size-codemod.ts [--dry-run] [--mfs] [--var ui|mfs] [--only kinds] <path>",
		"  <path>     file or directory (directory walks recursively; scope: apps/web/src ts/tsx + styles.css)",
		"  --dry-run  print per-area/per-file counts and the flagged lists without writing",
		"  --mfs      convert chat message files onto the --mfs ladder (17px reference); non-message files are listed, not converted",
		"  --var ui|mfs  explicit ladder variable: ui forces the --ui-fs ladder even for chat message",
		"               files decided to be chrome (font audit step 8); mfs equals --mfs; conflicts with --mfs when set to ui",
		"  --only kinds  convert ONLY the listed match kinds, comma-separated from:",
		"               pixel, rem, tailwind, inline, css (font audit step 9a: --only rem",
		"               converts a file's rem classes and leaves the residue a later",
		"               area step owns untouched)",
	].join("\n");
}

const ONLY_KIND_FLAGS = {
	pixel: "pixel-class",
	rem: "rem-class",
	tailwind: "tailwind-size-class",
	inline: "inline-font-size",
	css: "css-font-size",
} as const;

function parseOnlyFlag(value: string): FontSizeKind[] {
	const kinds: FontSizeKind[] = [];
	for (const name of value.split(",")) {
		const kind = (ONLY_KIND_FLAGS as Record<string, FontSizeKind | undefined>)[name.trim()];
		if (kind === undefined) throw new Error(`--only must be a comma list of: ${Object.keys(ONLY_KIND_FLAGS).join(", ")} (got "${name.trim()}")`);
		if (!kinds.includes(kind)) kinds.push(kind);
	}
	if (kinds.length === 0) throw new Error("--only must name at least one kind");
	return kinds;
}

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args: process.argv.slice(2),
			options: { "dry-run": { type: "boolean" }, mfs: { type: "boolean" }, var: { type: "string" }, only: { type: "string" } },
			strict: true,
			allowPositionals: true,
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`font-size-codemod: ${detail}`);
		console.error(usage());
		return 2;
	}
	if (parsed.positionals.length !== 1) {
		console.error("font-size-codemod: exactly one <path> argument is required");
		console.error(usage());
		return 2;
	}
	const varFlag = parsed.values.var;
	if (varFlag !== undefined && varFlag !== "ui" && varFlag !== "mfs") {
		console.error(`font-size-codemod: --var must be ui or mfs, got "${varFlag}"`);
		console.error(usage());
		return 2;
	}
	if (varFlag === "ui" && parsed.values.mfs === true) {
		console.error("font-size-codemod: --var ui conflicts with --mfs (use one ladder)");
		console.error(usage());
		return 2;
	}
	let only: FontSizeKind[] | undefined;
	if (parsed.values.only !== undefined) {
		try {
			only = parseOnlyFlag(parsed.values.only);
		} catch (error) {
			console.error(`font-size-codemod: ${error instanceof Error ? error.message : String(error)}`);
			console.error(usage());
			return 2;
		}
	}
	try {
		const outcome = await runFontSizeCodemod(parsed.positionals[0] ?? "", {
			dryRun: parsed.values["dry-run"] === true,
			mfs: parsed.values.mfs === true,
			var: varFlag === "ui" || varFlag === "mfs" ? varFlag : undefined,
			only,
		});
		console.log(outcome.report);
		return 0;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`font-size-codemod: ${detail}`);
		return 1;
	}
}

if (import.meta.main) {
	void main().then((code) => process.exit(code));
}
