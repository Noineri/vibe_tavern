/**
 * Architecture ratchet gate.
 *
 * This freezes existing architecture debt at its current level: domain code may
 * not acquire new dependencies on the API/runtime layers and oversized source
 * files may not grow (baselines only shrink through --update-baseline).
 * Fixed font sizes in `apps/web/src` (pixel classes, rem classes, Tailwind
 * size classes, inline `fontSize`, `styles.css` px rules) are a plain ban
 * with no baseline — any occurrence fails the gate (FIXED_FONT_SIZE_AUDIT_REPORT
 * step 9b: the audit converted every fixed size onto the ladder, so the
 * ratchet had nothing left to count down). Fractional `--ui-fs`/`--mfs`
 * ladder offsets are a plain ban too (diagnosis 6).
 */
import { API } from "typescript/unstable/async";
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from "typescript/unstable/ast";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
	collectFontSizeTargetFiles,
	collectFixedFontSizeMatches,
	cssFontSizeFor,
	FONT_SIZE_ROOT,
	inlineFontSizeFor,
	pixelClassFor,
	remClassFor,
	tailwindClassFor,
	type FontSizeKind,
} from "./font-size-codemod.js";

export const ARCH_GATE_MAX_LINES = 800;

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.resolve(import.meta.dir, "arch-gate-baseline.json");
const API_SOURCE_ROOT = "services/api/src";
const DOMAIN_ROOT = `${API_SOURCE_ROOT}/domain`;
const SIZE_ROOTS = new Set(["apps", "services", "packages", "scripts"]);
const LAYER_IMPORT_HINT = "domain/ must not depend on api/ or runtime/; move the needed code down into domain/ (or packages/*), or take a narrow interface instead of the SessionRuntime coordinator.";
const FILE_SIZE_HINT = "split the file — extract the part you are changing into its own module — instead of appending. Deleting or compressing existing lines (code, comments, or whitespace) is NOT a remedy: this ratchet exists so budgets shrink by moving code out, never by trimming — if no cohesive part can be extracted, stop and escalate instead.";
const FRACTIONAL_LADDER_OFFSET_HINT =
	"ladder offsets are whole pixels only: --ui-fs/--mfs are whole numbers, so a fractional offset always renders between pixels and smears glyph edges; round toward the base — the absolute value of the offset rounds down (-1.5px → -1px, -3.5px → -3px, +1.5px → +1px) (FIXED_FONT_SIZE_AUDIT_REPORT diagnosis 6)";
const FIXED_FONT_SIZE_HINTS: Record<keyof FixedFontSizeCounts, string> = {
	pixelClasses: `size chrome text from the --ui-fs ladder instead: text-[11px] → ${pixelClassFor(11)} (text-[Npx] → text-[calc(var(--ui-fs)-Kpx)], K = 14 - N; N = 14 → text-[var(--ui-fs)])`,
	remClasses: `size chrome text from the --ui-fs ladder instead: text-[0.8rem] → ${remClassFor(0.8)} (rem classes track the 16px browser root, not --ui-fs: map Nrem × 16px onto the ladder, whole-pixel offsets)`,
	tailwindSizeClasses: `map the class by its px at the 16px root and keep its line height: text-xs → ${tailwindClassFor("xs")}, text-sm → ${tailwindClassFor("sm")}, text-lg → ${tailwindClassFor("lg")}`,
	inlineFontSizes: `use the ladder value string instead: fontSize: 18 → ${inlineFontSizeFor(18)}`,
	cssFontSizes: `use the ladder value instead: font-size: 12px → ${cssFontSizeFor(12)} (styles.css only; message rules follow --mfs per FIXED_FONT_SIZE_AUDIT_REPORT)`,
};

// These are flat catalogs by design: every schema/type addition belongs in the
// one exhaustive source of truth, so splitting them would make navigation worse.
export const FILE_SIZE_EXEMPTIONS = {
	"packages/db/src/db-schema.ts": "Flat database schema catalog; each schema addition belongs in the exhaustive source of truth.",
	"packages/domain/src/entities.ts": "Flat domain entity catalog; each type addition belongs in the exhaustive source of truth.",
	"packages/api-contracts/src/schemas/image-gen-schema.ts": "Flat zod wire-schema catalog; each contract-field addition belongs in the exhaustive source of truth.",
} as const;

export interface LayerImport {
	file: string;
	line: number;
	module: string;
}

export interface ArchGateBaseline {
	layerImports: string[];
	oversizedFiles: Record<string, number>;
}

/** Fixed font sizes per pattern kind — the counters the baseline freezes. */
export interface FixedFontSizeCounts {
	pixelClasses: number;
	remClasses: number;
	tailwindSizeClasses: number;
	inlineFontSizes: number;
	cssFontSizes: number;
}

/** A fixed font size in `apps/web/src` — a plain ban, no baseline. */
export interface BannedFixedFontSize {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly text: string;
	readonly pattern: keyof FixedFontSizeCounts;
}

/** A fractional `--ui-fs`/`--mfs` ladder offset (plain ban, no baseline). */
export interface FractionalLadderOffset {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly text: string;
}

export interface OversizedFileChange {
	file: string;
	baseline: number;
	current: number;
}

export interface RemovedOversizedFile {
	file: string;
	baseline: number;
}

export interface NewOversizedFile {
	file: string;
	current: number;
}

export interface ArchGateReport {
	baseline: ArchGateBaseline;
	layerImports: LayerImport[];
	oversizedFiles: Record<string, number>;
	fixedFontSizes: FixedFontSizeCounts;
	newLayerImports: LayerImport[];
	removedLayerImportKeys: string[];
	growingOversizedFiles: OversizedFileChange[];
	newOversizedFiles: NewOversizedFile[];
	shrunkOversizedFiles: OversizedFileChange[];
	removedOversizedFiles: RemovedOversizedFile[];
	bannedFixedFontSizes: BannedFixedFontSize[];
	fractionalLadderOffsets: FractionalLadderOffset[];
}

const FIXED_FONT_SIZE_KIND_KEYS = {
	"pixel-class": "pixelClasses",
	"rem-class": "remClasses",
	"tailwind-size-class": "tailwindSizeClasses",
	"inline-font-size": "inlineFontSizes",
	"css-font-size": "cssFontSizes",
} as const satisfies Record<FontSizeKind, keyof FixedFontSizeCounts>;

/** `var(--ui-fs)`/`var(--mfs)` followed by a fractional ±N.Mpx offset — the
 *  separators cover the codemod's compact form, Tailwind's `_` escapes and
 *  plain css spaces. */
const FRACTIONAL_LADDER_OFFSET_PATTERN = /var\(--(?:ui-fs|mfs)\)[ \t_]*[+-][ \t_]*\d+\.\d+px/g;

function normalizePath(file: string): string {
	return file.split(path.sep).join("/");
}

function isWithin(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function stripModuleExtension(file: string): string {
	return file.replace(/\.(?:[cm]?js|[cm]?ts|tsx)$/, "");
}

function resolveApiModule(root: string, importingFile: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const sourceRoot = path.resolve(root, API_SOURCE_ROOT);
	const resolved = stripModuleExtension(path.resolve(path.dirname(importingFile), specifier));
	if (!isWithin(resolved, sourceRoot)) return undefined;
	return normalizePath(path.relative(sourceRoot, resolved));
}

function isTestSource(file: string): boolean {
	const normalized = normalizePath(file);
	return normalized.endsWith(".test.ts") || normalized.includes("/test/");
}

function collectTsFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const child = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(child);
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				files.push(child);
			}
		}
	};
	walk(root);
	return files.sort();
}

export function toLayerKey(entry: LayerImport): string {
	return `${entry.file} -> ${entry.module}`;
}

export async function collectLayerImports(root: string = ROOT): Promise<LayerImport[]> {
	const domainRoot = path.resolve(root, DOMAIN_ROOT);
	const files = collectTsFiles(domainRoot).filter((file) => !isTestSource(path.relative(domainRoot, file)));
	if (files.length === 0) return [];

	const imports: LayerImport[] = [];
	const api = new API();
	try {
		const snapshot = await api.updateSnapshot({ openFiles: files });
		for (const file of files) {
			const project = await snapshot.getDefaultProjectForFile(file);
			if (!project) throw new Error(`could not parse ${normalizePath(path.relative(root, file))}: no TypeScript project`);
			const sourceFile = await project.program.getSourceFile(file);
			if (!sourceFile) throw new Error(`could not parse ${normalizePath(path.relative(root, file))}: source file unavailable`);

			for (const statement of sourceFile.statements) {
				if (!isImportDeclaration(statement) && !isExportDeclaration(statement)) continue;
				const moduleSpecifier = statement.moduleSpecifier;
				if (moduleSpecifier === undefined || !isStringLiteral(moduleSpecifier)) continue;
				const module = resolveApiModule(root, file, moduleSpecifier.text);
				if (module === undefined || (!module.startsWith("api/") && !module.startsWith("runtime/"))) continue;
				imports.push({
					file: `domain/${normalizePath(path.relative(domainRoot, file))}`,
					line: sourceFile.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sourceFile)).line + 1,
					module,
				});
			}
		}
	} finally {
		api.close();
	}
	return imports.sort((left, right) => toLayerKey(left).localeCompare(toLayerKey(right)) || left.line - right.line);
}

function isSizeScoped(file: string): boolean {
	const normalized = normalizePath(file);
	const [root] = normalized.split("/");
	if (root === undefined || !SIZE_ROOTS.has(root)) return false;
	if (!/\.(?:ts|tsx)$/.test(normalized) || normalized.endsWith(".d.ts")) return false;
	if (/\.test\.(?:ts|tsx)$/.test(normalized) || normalized.includes("/test/")) return false;
	if (normalized.startsWith("packages/db/drizzle/") || normalized.startsWith("apps/web/src/generated/")) return false;
	return !(normalized in FILE_SIZE_EXEMPTIONS);
}

export function countLines(source: string): number {
	if (source.length === 0) return 0;
	const newlines = source.match(/\r\n|\r|\n/g)?.length ?? 0;
	return newlines + (/\r\n$|\r$|\n$/.test(source) ? 0 : 1);
}

function listTrackedFiles(root: string): string[] {
	const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const details = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`git ls-files failed${details === "" ? "" : `: ${details}`}`);
	}
	return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

export function collectOversizedFiles(root: string = ROOT, trackedFiles: readonly string[] = listTrackedFiles(root)): Record<string, number> {
	const oversized: Record<string, number> = {};
	for (const trackedFile of trackedFiles) {
		const file = normalizePath(trackedFile);
		if (!isSizeScoped(file)) continue;
		const absolute = path.resolve(root, file);
		if (!existsSync(absolute)) continue;
		const lines = countLines(readFileSync(absolute, "utf8"));
		if (lines > ARCH_GATE_MAX_LINES) oversized[file] = lines;
	}
	return Object.fromEntries(Object.entries(oversized).sort(([left], [right]) => left.localeCompare(right)));
}

export function emptyFixedFontSizeCounts(): FixedFontSizeCounts {
	return { pixelClasses: 0, remClasses: 0, tailwindSizeClasses: 0, inlineFontSizes: 0, cssFontSizes: 0 };
}

export function totalFixedFontSizes(counts: Readonly<FixedFontSizeCounts>): number {
	return counts.pixelClasses + counts.remClasses + counts.tailwindSizeClasses + counts.inlineFontSizes + counts.cssFontSizes;
}

/** Current fixed font sizes under `apps/web/src` (walked on disk, so a new
 *  component fails the gate before it is ever staged; tests, components/dev/
 *  and the known false positives excluded — see fontSizeScopeRejection). */
export function collectFixedFontSizes(root: string = ROOT): FixedFontSizeCounts {
	const counts = emptyFixedFontSizeCounts();
	for (const file of collectFontSizeTargetFiles(FONT_SIZE_ROOT, root)) {
		const matches = collectFixedFontSizeMatches(file, readFileSync(path.resolve(root, file), "utf8"));
		for (const match of matches) {
			counts[FIXED_FONT_SIZE_KIND_KEYS[match.kind]] += 1;
		}
	}
	return counts;
}

/** Every fixed font size under `apps/web/src` (same scope and exclusions
 *  as the counters) — a plain ban: any occurrence fails the gate. */
export function collectBannedFixedFontSizes(root: string = ROOT): BannedFixedFontSize[] {
	const banned: BannedFixedFontSize[] = [];
	for (const file of collectFontSizeTargetFiles(FONT_SIZE_ROOT, root)) {
		const source = readFileSync(path.resolve(root, file), "utf8");
		for (const match of collectFixedFontSizeMatches(file, source)) {
			banned.push({
				file,
				line: match.line,
				column: match.column,
				text: match.text,
				pattern: FIXED_FONT_SIZE_KIND_KEYS[match.kind],
			});
		}
	}
	return banned;
}

/** Fractional ladder offsets under `apps/web/src` (same scope and exclusions
 *  as the fixed-font rule) — a plain ban: any occurrence fails the gate. */
export function collectFractionalLadderOffsets(root: string = ROOT): FractionalLadderOffset[] {
	const offsets: FractionalLadderOffset[] = [];
	for (const file of collectFontSizeTargetFiles(FONT_SIZE_ROOT, root)) {
		const source = readFileSync(path.resolve(root, file), "utf8");
		for (const match of source.matchAll(FRACTIONAL_LADDER_OFFSET_PATTERN)) {
			if (match.index === undefined) continue;
			const before = source.slice(0, match.index);
			const lineStart = before.lastIndexOf("\n") + 1;
			offsets.push({ file, line: before.split("\n").length, column: match.index - lineStart + 1, text: match[0] });
		}
	}
	return offsets;
}

export function evaluateArchGate(
	baseline: ArchGateBaseline,
	layerImports: readonly LayerImport[],
	oversizedFiles: Readonly<Record<string, number>>,
	fixedFontSizes: Readonly<FixedFontSizeCounts> = emptyFixedFontSizeCounts(),
	fractionalLadderOffsets: readonly FractionalLadderOffset[] = [],
	bannedFixedFontSizes: readonly BannedFixedFontSize[] = [],
): ArchGateReport {
	const baselineLayerImports = new Set(baseline.layerImports);
	const currentLayerImports = new Set(layerImports.map(toLayerKey));
	const currentOversizedFiles = Object.entries(oversizedFiles).sort(([left], [right]) => left.localeCompare(right));
	const baselineOversizedFiles = Object.entries(baseline.oversizedFiles).sort(([left], [right]) => left.localeCompare(right));

	return {
		baseline,
		layerImports: [...layerImports],
		oversizedFiles: { ...oversizedFiles },
		fixedFontSizes: { ...fixedFontSizes },
		fractionalLadderOffsets: [...fractionalLadderOffsets],
		bannedFixedFontSizes: [...bannedFixedFontSizes],
		newLayerImports: layerImports.filter((entry) => !baselineLayerImports.has(toLayerKey(entry))),
		removedLayerImportKeys: baseline.layerImports.filter((key) => !currentLayerImports.has(key)).sort(),
		growingOversizedFiles: currentOversizedFiles.flatMap(([file, current]) => {
			const recorded = baseline.oversizedFiles[file];
			return recorded !== undefined && current > recorded ? [{ file, baseline: recorded, current }] : [];
		}),
		newOversizedFiles: currentOversizedFiles.flatMap(([file, current]) => {
			return baseline.oversizedFiles[file] === undefined ? [{ file, current }] : [];
		}),
		shrunkOversizedFiles: baselineOversizedFiles.flatMap(([file, recorded]) => {
			const current = oversizedFiles[file];
			return current !== undefined && current < recorded ? [{ file, baseline: recorded, current }] : [];
		}),
		removedOversizedFiles: baselineOversizedFiles.flatMap(([file, baseline]) => {
			return oversizedFiles[file] === undefined ? [{ file, baseline }] : [];
		}),
	};
}

function hasFailures(report: ArchGateReport): boolean {
	return (
		report.newLayerImports.length > 0 ||
		report.growingOversizedFiles.length > 0 ||
		report.newOversizedFiles.length > 0 ||
		report.bannedFixedFontSizes.length > 0 ||
		report.fractionalLadderOffsets.length > 0
	);
}

function hasReductions(report: ArchGateReport): boolean {
	return (
		report.removedLayerImportKeys.length > 0 ||
		report.shrunkOversizedFiles.length > 0 ||
		report.removedOversizedFiles.length > 0
	);
}

export function formatArchGateReport(report: ArchGateReport): string {
	const lines: string[] = [];
	if (hasFailures(report)) {
		const failureCount =
			report.newLayerImports.length +
			report.growingOversizedFiles.length +
			report.newOversizedFiles.length +
			report.bannedFixedFontSizes.length +
			report.fractionalLadderOffsets.length;
		lines.push(`Architecture gate: FAIL — ${failureCount} new architecture violation(s) detected.`);
		for (const entry of report.newLayerImports) {
			lines.push(`  [domain-layer-import] services/api/src/${entry.file}:${entry.line}`);
			lines.push(`    ${entry.file} -> ${entry.module}`);
			lines.push(`    → ${LAYER_IMPORT_HINT}`);
		}
		for (const entry of report.growingOversizedFiles) {
			lines.push(`  [file-size-ratchet] ${entry.file}:1`);
			lines.push(`    ${entry.current} lines > baseline ${entry.baseline}`);
			lines.push(`    → ${FILE_SIZE_HINT}`);
		}
		for (const entry of report.newOversizedFiles) {
			lines.push(`  [file-size-ratchet] ${entry.file}:1`);
			lines.push(`    ${entry.current} lines > ${ARCH_GATE_MAX_LINES}-line cap; this file is not in the baseline`);
			lines.push(`    → ${FILE_SIZE_HINT}`);
		}
		for (const entry of report.bannedFixedFontSizes) {
			lines.push(`  [fixed-font-size] ${entry.file}:${entry.line}:${entry.column}`);
			lines.push(`    ${entry.text}`);
			lines.push(`    → ${FIXED_FONT_SIZE_HINTS[entry.pattern]}`);
		}
		for (const entry of report.fractionalLadderOffsets) {
			lines.push(`  [fractional-ladder-offset] ${entry.file}:${entry.line}:${entry.column}`);
			lines.push(`    ${entry.text}`);
			lines.push(`    → ${FRACTIONAL_LADDER_OFFSET_HINT}`);
		}
	} else {
		lines.push("Architecture gate: OK — all current violations are within baseline.");
	}

	if (hasReductions(report)) {
		lines.push("  Baseline debt has shrunk:");
		for (const key of report.removedLayerImportKeys) lines.push(`    [domain-layer-import] ${key} removed`);
		for (const entry of report.shrunkOversizedFiles) {
			lines.push(`    [file-size-ratchet] ${entry.file}: ${entry.current} lines (was ${entry.baseline})`);
		}
		for (const entry of report.removedOversizedFiles) {
			lines.push(`    [file-size-ratchet] ${entry.file}: no longer above ${ARCH_GATE_MAX_LINES} lines (was ${entry.baseline})`);
		}
		lines.push("  Lower the baseline with: bun scripts/arch-gate.ts --update-baseline");
	}

	lines.push(
		`  budgets: layer imports ${report.layerImports.length}/${report.baseline.layerImports.length}, oversized files ${Object.keys(report.oversizedFiles).length}/${Object.keys(report.baseline.oversizedFiles).length}, new-file cap ${ARCH_GATE_MAX_LINES} lines, fixed font sizes ${totalFixedFontSizes(report.fixedFontSizes)} (plain ban: any occurrence fails)`,
	);
	return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBaseline(value: unknown): ArchGateBaseline {
	if (!isRecord(value) || !Array.isArray(value.layerImports) || !isRecord(value.oversizedFiles)) {
		throw new Error("baseline must contain layerImports[] and oversizedFiles{}");
	}
	if (!value.layerImports.every((entry): entry is string => typeof entry === "string")) {
		throw new Error("baseline layerImports must contain only strings");
	}
	const oversizedFiles: Record<string, number> = {};
	for (const [file, lines] of Object.entries(value.oversizedFiles)) {
		if (typeof lines !== "number" || !Number.isInteger(lines) || lines <= ARCH_GATE_MAX_LINES) {
			throw new Error(`baseline size for ${file} must be an integer above ${ARCH_GATE_MAX_LINES}`);
		}
		oversizedFiles[file] = lines;
	}
	return { layerImports: [...new Set(value.layerImports)].sort(), oversizedFiles };
}

async function loadBaseline(): Promise<ArchGateBaseline> {
	try {
		return parseBaseline(JSON.parse(await Bun.file(BASELINE_PATH).text()));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`baseline at ${path.relative(ROOT, BASELINE_PATH)} is corrupt: ${detail}`);
	}
}

function baselineFromCurrent(
	layerImports: readonly LayerImport[],
	oversizedFiles: Readonly<Record<string, number>>,
): ArchGateBaseline {
	return {
		layerImports: [...new Set(layerImports.map(toLayerKey))].sort(),
		oversizedFiles: Object.fromEntries(Object.entries(oversizedFiles).sort(([left], [right]) => left.localeCompare(right))),
	};
}

async function writeBaseline(baseline: ArchGateBaseline): Promise<void> {
	await Bun.write(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
}

async function main(): Promise<number> {
	let updateBaseline = false;
	try {
		const parsed = parseArgs({
			args: process.argv.slice(2),
			options: { "update-baseline": { type: "boolean" } },
			strict: true,
			allowPositionals: false,
		});
		updateBaseline = parsed.values["update-baseline"] === true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`arch-gate: ${detail}`);
		console.error("usage: bun scripts/arch-gate.ts [--update-baseline]");
		return 2;
	}

	const layerImports = await collectLayerImports();
	const oversizedFiles = collectOversizedFiles();
	const fixedFontSizes = collectFixedFontSizes();
	const fractionalLadderOffsets = collectFractionalLadderOffsets();
	const bannedFixedFontSizes = collectBannedFixedFontSizes();
	if (!existsSync(BASELINE_PATH)) {
		if (!updateBaseline) {
			console.error(`arch-gate: no baseline found at ${path.relative(ROOT, BASELINE_PATH)}.`);
			console.error(
				`  Found ${layerImports.length} domain layer pair(s), ${Object.keys(oversizedFiles).length} oversized file(s) and ${totalFixedFontSizes(fixedFontSizes)} fixed font size(s).`,
			);
			console.error("  Verify these counts, then generate the initial baseline with:");
			console.error("    bun scripts/arch-gate.ts --update-baseline");
			return 1;
		}
		await writeBaseline(baselineFromCurrent(layerImports, oversizedFiles));
		console.log(
			`arch-gate: baseline initialized → ${layerImports.length} domain layer pair(s), ${Object.keys(oversizedFiles).length} oversized file(s), ${totalFixedFontSizes(
				fixedFontSizes,
			)} fixed font size(s) (plain ban: any occurrence fails).`,
		);
		return 0;
	}

	let baseline: ArchGateBaseline;
	try {
		baseline = await loadBaseline();
	} catch (error) {
		console.error(`arch-gate: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const report = evaluateArchGate(baseline, layerImports, oversizedFiles, fixedFontSizes, fractionalLadderOffsets, bannedFixedFontSizes);

	if (updateBaseline) {
		if (hasFailures(report)) {
			console.error(formatArchGateReport(report));
			console.error("arch-gate: --update-baseline only lowers existing debt; it never adds a new violation or raises a file limit.");
			return 1;
		}
		await writeBaseline(baselineFromCurrent(layerImports, oversizedFiles));
		console.log(
			`arch-gate: baseline lowered → ${layerImports.length} domain layer pair(s), ${Object.keys(oversizedFiles).length} oversized file(s), ${totalFixedFontSizes(
				fixedFontSizes,
			)} fixed font size(s) (plain ban: any occurrence fails).`,
		);
		return 0;
	}

	const output = formatArchGateReport(report);
	if (hasFailures(report)) {
		console.error(output);
		return 1;
	}
	console.log(output);
	return 0;
}

if (import.meta.main) {
	void main().then((code) => process.exit(code));
}
