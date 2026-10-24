import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ARCH_GATE_MAX_LINES,
	collectBannedFixedFontSizes,
	collectFixedFontSizes,
	collectFractionalLadderOffsets,
	collectLayerImports,
	collectOversizedFiles,
	emptyFixedFontSizeCounts,
	evaluateArchGate,
	formatArchGateReport,
	toLayerKey,
	type FixedFontSizeCounts,
} from "./arch-gate.js";

function writeFixture(root: string, relativePath: string, content: string): void {
	const file = join(root, relativePath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function lines(count: number): string {
	return Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n";
}

describe("architecture ratchet gate", () => {
	test("flags single-line and multi-line domain imports into runtime or api", async () => {
		const root = mkdtempSync(join(tmpdir(), "vt-arch-gate-"));
		try {
			writeFixture(root, "services/api/src/domain/feature/clean.ts", 'import { value } from "../shared/value.js";\nexport { value };\n');
			writeFixture(root, "services/api/src/domain/feature/single-line-api-leak.ts", 'import { RuntimeApi } from "../../api/contract/runtime-api.js";\nexport { RuntimeApi };\n');
			writeFixture(
				root,
				"services/api/src/domain/feature/runtime-leak.ts",
				[
					"import type {",
					"\tSessionRuntime,",
					'} from "../../runtime/session/session-runtime.js";',
					"export type {",
					"\tRuntimeApi,",
					'} from "../../api/contract/runtime-api.js";',
					"",
				].join("\n"),
			);

			const imports = await collectLayerImports(root);
			expect(imports.map(toLayerKey)).toEqual([
				"domain/feature/runtime-leak.ts -> api/contract/runtime-api",
				"domain/feature/runtime-leak.ts -> runtime/session/session-runtime",
				"domain/feature/single-line-api-leak.ts -> api/contract/runtime-api",
			]);

			const report = evaluateArchGate({ layerImports: [], oversizedFiles: {} }, imports, {});
			expect(report.newLayerImports.map(toLayerKey)).toEqual([
				"domain/feature/runtime-leak.ts -> api/contract/runtime-api",
				"domain/feature/runtime-leak.ts -> runtime/session/session-runtime",
				"domain/feature/single-line-api-leak.ts -> api/contract/runtime-api",
			]);
			const output = formatArchGateReport(report);
			expect(output).toContain("Architecture gate: FAIL");
			expect(output).toContain("domain/ must not depend on api/ or runtime/");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a new oversized file and growth beyond a file's baseline", () => {
		const root = mkdtempSync(join(tmpdir(), "vt-arch-gate-"));
		try {
			writeFixture(root, "apps/existing.ts", lines(ARCH_GATE_MAX_LINES + 2));
			writeFixture(root, "services/new-large.ts", lines(ARCH_GATE_MAX_LINES + 1));
			writeFixture(root, "apps/ignored.test.ts", lines(ARCH_GATE_MAX_LINES + 2));
			writeFixture(root, "apps/test/ignored.ts", lines(ARCH_GATE_MAX_LINES + 2));
			writeFixture(root, "apps/web/src/generated/ignored.ts", lines(ARCH_GATE_MAX_LINES + 2));
			writeFixture(root, "packages/db/drizzle/ignored.ts", lines(ARCH_GATE_MAX_LINES + 2));
			writeFixture(root, "packages/db/src/db-schema.ts", lines(ARCH_GATE_MAX_LINES + 2));
			writeFixture(root, "packages/domain/src/entities.ts", lines(ARCH_GATE_MAX_LINES + 2));

			const trackedFiles = [
				"apps/existing.ts",
				"services/new-large.ts",
				"apps/ignored.test.ts",
				"apps/test/ignored.ts",
				"apps/web/src/generated/ignored.ts",
				"packages/db/drizzle/ignored.ts",
				"packages/db/src/db-schema.ts",
				"packages/domain/src/entities.ts",
			];
			const oversizedFiles = collectOversizedFiles(root, trackedFiles);
			expect(oversizedFiles).toEqual({
				"apps/existing.ts": ARCH_GATE_MAX_LINES + 2,
				"services/new-large.ts": ARCH_GATE_MAX_LINES + 1,
			});

			const report = evaluateArchGate(
				{ layerImports: [], oversizedFiles: { "apps/existing.ts": ARCH_GATE_MAX_LINES + 1 } },
				[],
				oversizedFiles,
			);
			expect(report.growingOversizedFiles).toEqual([
				{ file: "apps/existing.ts", baseline: ARCH_GATE_MAX_LINES + 1, current: ARCH_GATE_MAX_LINES + 2 },
			]);
			expect(report.newOversizedFiles).toEqual([
				{ file: "services/new-large.ts", current: ARCH_GATE_MAX_LINES + 1 },
			]);
			const output = formatArchGateReport(report);
			expect(output).toContain("Architecture gate: FAIL");
			expect(output).toContain("split the file — extract the part you are changing into its own module — instead of appending. Deleting or compressing existing lines (code, comments, or whitespace) is NOT a remedy: this ratchet exists so budgets shrink by moving code out, never by trimming — if no cohesive part can be extracted, stop and escalate instead.");
			expect(output).toContain("budgets:");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports baseline debt that has shrunk so --update-baseline can lower it", () => {
		const baseline = {
			layerImports: ["domain/feature/old.ts -> runtime/session/session-runtime"],
			oversizedFiles: {
				"apps/shrunk.ts": ARCH_GATE_MAX_LINES + 2,
				"services/deleted.ts": ARCH_GATE_MAX_LINES + 1,
			},
		};
		const report = evaluateArchGate(baseline, [], { "apps/shrunk.ts": ARCH_GATE_MAX_LINES + 1 });

		expect(report.removedLayerImportKeys).toEqual(baseline.layerImports);
		expect(report.shrunkOversizedFiles).toEqual([
			{ file: "apps/shrunk.ts", baseline: ARCH_GATE_MAX_LINES + 2, current: ARCH_GATE_MAX_LINES + 1 },
		]);
		expect(report.removedOversizedFiles).toEqual([
			{ file: "services/deleted.ts", baseline: ARCH_GATE_MAX_LINES + 1 },
		]);
		expect(formatArchGateReport(report)).toContain("bun scripts/arch-gate.ts --update-baseline");
	});
});

describe("fixed font-size ratchet", () => {
	function baseline(overrides: Partial<FixedFontSizeCounts> = {}): FixedFontSizeCounts {
		return { ...emptyFixedFontSizeCounts(), ...overrides };
	}

	test("counts each fixed-size pattern and excludes tests, dev and the tweaks default", () => {
		const root = mkdtempSync(join(tmpdir(), "vt-arch-gate-"));
		try {
			writeFixture(root, "apps/web/src/components/shared/A.tsx", '<a className="text-[11px]">1</a>\n<a className="text-[12px]">2</a>\n');
			writeFixture(root, "apps/web/src/components/shared/Rem.tsx", '<a className="text-[0.8rem]">r</a>\n<b className="text-[1.6rem]">R</b>\n');
			writeFixture(root, "apps/web/src/components/shared/B.tsx", '<b className="text-xs sm:text-sm text-red-500">x</b>\n');
			writeFixture(root, "apps/web/src/components/build/C.tsx", '<c style={{ fontSize: 18 }}>y</c>\n<c style={{ fontSize: "12px" }}>z</c>\n');
			writeFixture(root, "apps/web/src/styles.css", ".tag{font-size:11px}\n.note{font-size: 12.5px}\n");
			writeFixture(root, "apps/web/src/lib/local-storage.ts", "export const DEFAULT_TWEAKS = { fontSize: 17, uiFontSize: 17 };\n");
			writeFixture(root, "apps/web/src/components/shared/D.test.tsx", '<d className="text-[10px]">t</d>\n');
			writeFixture(root, "apps/web/src/components/dev/ThemeTuner.tsx", '<e className="text-[9px]">dev</e>\n');
			writeFixture(root, "apps/web/src/themes/coffee.css", ".themed{font-size:12px}\n");

			expect(collectFixedFontSizes(root)).toEqual(
				baseline({ pixelClasses: 2, remClasses: 2, tailwindSizeClasses: 2, inlineFontSizes: 2, cssFontSizes: 2 }),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("red: a probe text-[13px] fails the gate with the ladder message", () => {
		const root = mkdtempSync(join(tmpdir(), "vt-arch-gate-"));
		try {
			writeFixture(
				root,
				"apps/web/src/components/shared/Probe.tsx",
				'<a className="text-[13px]">x</a>\n<b className="text-xs">y</b>\n',
			);
			writeFixture(root, "apps/web/src/styles.css", ".tag{font-size:11px}\n");
			writeFixture(root, "apps/web/src/components/shared/Skip.test.tsx", '<d className="text-[10px]">t</d>\n');
			const banned = collectBannedFixedFontSizes(root);
			expect(banned).toEqual([
				{ file: "apps/web/src/components/shared/Probe.tsx", line: 1, column: 15, text: "text-[13px]", pattern: "pixelClasses" },
				{ file: "apps/web/src/components/shared/Probe.tsx", line: 2, column: 15, text: "text-xs", pattern: "tailwindSizeClasses" },
				{ file: "apps/web/src/styles.css", line: 1, column: 6, text: "font-size:11px", pattern: "cssFontSizes" },
			]);
			const report = evaluateArchGate({ layerImports: [], oversizedFiles: {} }, [], {}, emptyFixedFontSizeCounts(), [], banned);
			expect(report.bannedFixedFontSizes).toHaveLength(3);
			const output = formatArchGateReport(report);
			expect(output).toContain("Architecture gate: FAIL — 3 new architecture violation(s) detected.");
			expect(output).toContain("[fixed-font-size] apps/web/src/components/shared/Probe.tsx:1:15");
			expect(output).toContain("text-[13px]");
			expect(output).toContain("[fixed-font-size] apps/web/src/components/shared/Probe.tsx:2:15");
			expect(output).toContain("[fixed-font-size] apps/web/src/styles.css:1:6");
			expect(output).toContain("text-[11px] → text-[calc(var(--ui-fs)-3px)]");
			expect(output).toContain("text-xs → text-[calc(var(--ui-fs)-2px)] leading-4");
			expect(output).toContain("font-size: 12px → font-size: calc(var(--ui-fs)-2px)");
			expect(output).toContain("fixed font sizes 0 (plain ban: any occurrence fails)");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("green: zero fixed sizes pass with a block-less baseline", () => {
		const report = evaluateArchGate({ layerImports: [], oversizedFiles: {} }, [], {}, emptyFixedFontSizeCounts(), [], []);
		expect(report.bannedFixedFontSizes).toEqual([]);
		const output = formatArchGateReport(report);
		expect(output).toContain("Architecture gate: OK — all current violations are within baseline.");
		expect(output).toContain("fixed font sizes 0 (plain ban: any occurrence fails)");
	});
});

describe("fractional ladder offset ban", () => {
	test("red: a fractional --ui-fs/--mfs offset fails the gate naming the rounding rule", () => {
		const root = mkdtempSync(join(tmpdir(), "vt-arch-gate-"));
		try {
			writeFixture(
				root,
				"apps/web/src/components/shared/Probe.tsx",
				'<a className="text-[calc(var(--ui-fs)-1.5px)]">x</a>\n<b className="text-[calc(var(--mfs)+1.5px)]">y</b>\n',
			);
			const offsets = collectFractionalLadderOffsets(root);
			expect(offsets).toEqual([
				{ file: "apps/web/src/components/shared/Probe.tsx", line: 1, column: 26, text: "var(--ui-fs)-1.5px" },
				{ file: "apps/web/src/components/shared/Probe.tsx", line: 2, column: 26, text: "var(--mfs)+1.5px" },
			]);
			const report = evaluateArchGate({ layerImports: [], oversizedFiles: {} }, [], {}, emptyFixedFontSizeCounts(), offsets);
			expect(report.fractionalLadderOffsets).toHaveLength(2);
			const output = formatArchGateReport(report);
			expect(output).toContain("Architecture gate: FAIL — 2 new architecture violation(s) detected.");
			expect(output).toContain("[fractional-ladder-offset] apps/web/src/components/shared/Probe.tsx:1:26");
			expect(output).toContain("var(--ui-fs)-1.5px");
			expect(output).toContain("round toward the base — the absolute value of the offset rounds down (-1.5px → -1px, -3.5px → -3px, +1.5px → +1px)");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("green: whole-pixel offsets and non-font fractional values are not the rule's business", () => {
		const root = mkdtempSync(join(tmpdir(), "vt-arch-gate-"));
		try {
			// tracking/leading/padding fractional utilities, gap-1.5, rounded-[2.5px],
			// a spaced css calc and the underscore tailwind form must all be judged
			// only when the ladder variable itself carries the fractional offset.
			writeFixture(
				root,
				"apps/web/src/components/shared/Whole.tsx",
				[
				'<a className="text-[calc(var(--ui-fs)-1px)] tracking-[0.06em] leading-[1.4] gap-1.5 p-2.5 rounded-[2.5px]">x</a>',
				'<b style={{ fontSize: "calc(var(--ui-fs)+2px)" }}>y</b>',
			].join("\n") + "\n",
			);
			writeFixture(root, "apps/web/src/styles.css", ".ok{font-size: calc(var(--ui-fs) - 1px)}\n");
			expect(collectFractionalLadderOffsets(root)).toEqual([]);
			const report = evaluateArchGate({ layerImports: [], oversizedFiles: {} }, [], {}, emptyFixedFontSizeCounts(), []);
			expect(formatArchGateReport(report)).toContain("Architecture gate: OK — all current violations are within baseline.");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("same scope and exclusions as the fixed-font rule: tests and components/dev ignored", () => {
		const root = mkdtempSync(join(tmpdir(), "vt-arch-gate-"));
		try {
			writeFixture(root, "apps/web/src/components/shared/Skip.test.tsx", '<a className="text-[calc(var(--ui-fs)-1.5px)]">t</a>\n');
			writeFixture(root, "apps/web/src/components/dev/ThemeTuner.tsx", '<a className="text-[calc(var(--ui-fs)-1.5px)]">dev</a>\n');
			writeFixture(root, "apps/web/src/themes/coffee.css", ".themed{font-size: calc(var(--ui-fs) - 1.5px)}\n");
			expect(collectFractionalLadderOffsets(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
