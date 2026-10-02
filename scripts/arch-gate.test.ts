import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ARCH_GATE_MAX_LINES,
	collectLayerImports,
	collectOversizedFiles,
	evaluateArchGate,
	formatArchGateReport,
	toLayerKey,
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
			expect(output).toContain("split the file — extract the part you are changing into its own module — instead of appending.");
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
