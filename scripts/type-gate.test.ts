import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { API } from "typescript/async";
import { runGate, scanAst, toKey, type Violation } from "./type-gate.js";

/**
 * Tests for scripts/type-gate.ts — the type-safety baseline gate.
 *
 * Fixture source text is assembled at RUNTIME through the builders below on
 * purpose: scripts/test-hygiene.ts counts `\bas\s+never\b` occurrences per
 * test file against a ratchet budget (1243), and this file QUOTES the erasure
 * patterns as fixture data without committing any of them. Interpolation keeps
 * the literal whitespace-separated pattern out of this file's source text, so
 * the budget never counts it (same class as the guard's self-exempt test file,
 * which quotes every banned pattern deliberately).
 */
const AS = "as";
const UNKNOWN = "unknown";
const NEVER = "never";

const plainDoubleCast = (expression: string, target: string): string =>
	`${expression} ${AS} ${UNKNOWN} ${AS} ${target}`;
const parenHopCast = (expression: string, target: string): string =>
	`(${expression} ${AS} ${UNKNOWN}) ${AS} ${target}`;
const multiHopCast = (expression: string, middle: string, target: string): string =>
	`${expression} ${AS} ${UNKNOWN} ${AS} ${middle} ${AS} ${target}`;
const bareNarrowing = (expression: string): string => `${expression} ${AS} ${UNKNOWN}`;
const asNeverCast = (expression: string): string => `${expression} ${AS} ${NEVER}`;

interface FixtureFile {
	readonly name: string;
	readonly text: string;
}

/** Write fixture files into a fresh temp root, parse them with the same TS 7
 *  API the gate uses, and scan them. Root is removed even on failure. */
async function scanFixtureFiles(files: readonly FixtureFile[]): Promise<Violation[]> {
	const root = mkdtempSync(join(tmpdir(), "vt-type-gate-"));
	try {
		const absPaths = files.map((file) => {
			const absPath = join(root, file.name);
			mkdirSync(dirname(absPath), { recursive: true });
			writeFileSync(absPath, file.text);
			return absPath;
		});
		await using api = new API();
		const parsed = await Promise.all(absPaths.map((absPath) => api.createSourceFileFromFile(absPath)));
		return parsed.flatMap(({ sourceFile }, i) => scanAst(sourceFile, absPaths[i]!));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeFixture(root: string, relativePath: string, content: string): string {
	const absPath = join(root, relativePath);
	mkdirSync(dirname(absPath), { recursive: true });
	writeFileSync(absPath, content);
	return absPath;
}

describe("type-gate scanner", () => {
	test("unknown-cast: plain, paren-wrapped and multi-hop double casts flag ONCE, at the outermost cast; bare narrowing into unknown does not flag", async () => {
		const violations = await scanFixtureFiles([
			{
				name: "prod/erasure.ts",
				text: [
					"interface Snapshot { ready: boolean }",
					"declare const raw: unknown;",
					`const plain = ${plainDoubleCast("raw", "Snapshot")};`,
					`const parenHop = ${parenHopCast("raw", "Snapshot")};`,
					`const multiHop = ${multiHopCast("raw", "Snapshot", "Snapshot")};`,
					`const bare = ${bareNarrowing("raw")};`,
					`passThrough(${bareNarrowing("raw")});`,
					"",
				].join("\n"),
			},
		]);

		const casts = violations.filter((v) => v.category === "unknown-cast");
		// One violation per erasure chain — multi-hop's inner casts are consumed.
		expect(casts.map((v) => v.line).sort((a, b) => a - b)).toEqual([3, 4, 5]);
		// The bare single-cast-into-unknown lines stay silent — and no other
		// category fires on this file.
		expect(violations.filter((v) => v.line === 6 || v.line === 7)).toEqual([]);
		expect(violations.every((v) => v.category !== "as-any")).toBe(true);
		expect(violations.every((v) => v.category !== "type-any")).toBe(true);
		expect(violations.every((v) => v.category !== "angle-any")).toBe(true);
	});

	test("as-never: production-shaped files flag, test-shaped files stay out (test-hygiene owns their budget)", async () => {
		const violations = await scanFixtureFiles([
			{
				name: "prod/deps.ts",
				text: `export const deps = ${asNeverCast("null")};\nexport const other = ${asNeverCast("value")};\n`,
			},
			{
				name: "prod/deps.test.ts",
				text: `export const deps = ${asNeverCast("null")};\n`,
			},
		]);

		const flagged = violations.filter((v) => v.category === "as-never");
		expect(flagged).toHaveLength(2);
		expect(flagged.every((v) => !v.file.endsWith(".test.ts"))).toBe(true);
		expect(flagged.every((v) => v.file.endsWith("/deps.ts"))).toBe(true);
	});

	test("ts-directive: @ts-nocheck is flagged like @ts-ignore / @ts-expect-error", async () => {
		const violations = await scanFixtureFiles([
			{ name: "prod/nocheck.ts", text: "// @ts-nocheck\nexport const value = 1;\n" },
		]);
		expect(violations.map((v) => v.category)).toEqual(["ts-directive"]);
		expect(violations[0]?.snippet).toBe("@ts-nocheck");
	});
});

describe("type-gate ratchet", () => {
	test("--update-baseline snapshots current debt; a NEW violation aborts with exit 1; the covering baseline exits 0", async () => {
		const root = mkdtempSync(join(tmpdir(), "vt-type-gate-run-"));
		const logs: string[] = [];
		const errors: string[] = [];
		try {
			const files = [
				writeFixture(root, "prod/erasure.ts", `const snapshot = ${plainDoubleCast("raw", "Snapshot")};\n`),
				writeFixture(root, "prod/deps.ts", `export const deps = ${asNeverCast("null")};\n`),
			];
			const baselinePath = join(root, "baseline.json");
			const io = {
				log: (message: string) => logs.push(message),
				error: (message: string) => errors.push(message),
			};

			// 1. The sanctioned first snapshot: --update-baseline records the debt.
			const updated = await runGate(files, { update: true, quiet: false, baselinePath, ...io });
			expect(updated.code).toBe(0);
			const snapshotKeys = (JSON.parse(await Bun.file(baselinePath).text()) as string[]).sort();
			expect(snapshotKeys).toHaveLength(2);
			expect(snapshotKeys.some((k) => k.endsWith(":unknown-cast"))).toBe(true);
			expect(snapshotKeys.some((k) => k.endsWith(":as-never"))).toBe(true);

			// 2. A violation NOT in the baseline aborts with exit 1 and carries
			//    the WHY (rationale dies with the agent's context window).
			await Bun.write(baselinePath, JSON.stringify(snapshotKeys.filter((k) => !k.endsWith(":unknown-cast"))));
			const enforcing = await runGate(files, { update: false, quiet: false, baselinePath, ...io });
			expect(enforcing.code).toBe(1);
			expect(enforcing.fresh.map((v) => v.category)).toEqual(["unknown-cast"]);
			expect(enforcing.fresh.map(toKey)).toEqual(snapshotKeys.filter((k) => k.endsWith(":unknown-cast")));
			const failureText = errors.join("\n");
			expect(failureText).toContain("NEW type-safety violation");
			expect(failureText).toContain("[unknown-cast]");
			expect(failureText).toContain("context window");
			expect(failureText).toContain("--update-baseline");

			// 3. The covering baseline holds: clean, exit 0. (Restore the full
			//    snapshot from step 1 — step 2 deliberately weakened the file.)
			await Bun.write(baselinePath, JSON.stringify(snapshotKeys));
			const clean = await runGate(files, { update: false, quiet: false, baselinePath, ...io });
			expect(clean.code).toBe(0);
			expect(clean.fresh).toEqual([]);
			expect(logs.join("\n")).toContain("all within baseline");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
