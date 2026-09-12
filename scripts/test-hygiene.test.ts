import { describe, expect, test } from "bun:test";
import {
	BUDGETS,
	formatReport,
	isTestFilePath,
	runGuard,
	scanFile,
} from "./test-hygiene.js";

describe("test-hygiene guard (TH-4c, L2 layer)", () => {
	test("flags out-of-repo path literals, accepts derived and relative paths", () => {
		const bad = [
			`await loadFixture("N:/janitor_characters/vibe_tavern/fixture.json");`,
			`const p = \`C:\\\\Users\\\\user\\\\scratch.json\`;`,
			`const scratch = "/tmp/probe.json";`,
			`const home = "/home/runner/data.bin";`,
		];
		for (const line of bad) {
			const { violations } = scanFile(`test("${Math.random()}", () => {\n  ${line}\n});`, "a.test.ts");
			expect(violations.some((v) => v.rule === "no-out-of-repo-paths")).toBe(true);
		}

		const good = [
			`const fixture = join(import.meta.dir, "../../fixtures/card.json");`,
			`const url = "https://example.com/api/v2";`,
			`const urlPath = "/api/providers";`,
			`const scratch = join(tmpdir(), "probe.json");`,
		];
		for (const line of good) {
			const { violations } = scanFile(`test("ok", () => {\n  ${line}\n});`, "a.test.ts");
			expect(violations.filter((v) => v.rule === "no-out-of-repo-paths")).toEqual([]);
		}
	});

	test("flags a registry reset call without restore; accepts snapshot+restore and comment mentions", () => {
		const resetOnly = scanFile(
			`import { __resetSttRegistryForTests } from "../src/domain/stt/stt-registry.js";\n` +
				`test("poisons the process", () => {\n  __resetSttRegistryForTests();\n});\n`,
			"a.test.ts",
		);
		expect(resetOnly.violations.some((v) => v.rule === "registry-reset-needs-restore")).toBe(true);

		const withRestore = scanFile(
			`import { __resetSttRegistryForTests, __snapshotSttRegistryForTests, __restoreSttRegistryForTests } from "../src/domain/stt/stt-registry.js";\n` +
				`const snap = __snapshotSttRegistryForTests();\n` +
				`test("safe", () => { __resetSttRegistryForTests(); });\n` +
				`afterAll(() => { __restoreSttRegistryForTests(snap); });\n`,
			"a.test.ts",
		);
		expect(withRestore.violations).toEqual([]);

		const commentOnly = scanFile(
			`// NOTE: no __resetSttRegistryForTests() here — resetting would clear the\n` +
				`// module-scope registration for the entire process.\n`,
			"a.test.ts",
		);
		expect(commentOnly.violations).toEqual([]);

		const benignReset = scanFile(
			`import { __resetGoogleTokenCacheForTests } from "../src/domain/tts/backends/google-cloud-tts.js";\n` +
				`test("cache reset is not a registry reset", () => { __resetGoogleTokenCacheForTests(); });\n`,
			"a.test.ts",
		);
		expect(benignReset.violations).toEqual([]);
	});

	test("counts ratchet metrics exactly (as never, screen, innerHTML, long sleeps)", () => {
		const content = [
			`const a = mock as never;`,
			`const b = x as never; const c = y as never;`,
			`expect(screen.getByRole("button")).toBeTruthy();`,
			`expect(screen.getByText("hi")).toBeTruthy();`,
			`document.body.innerHTML = "";`,
			`await sleep(350);`,
			`await Bun.sleep(201);`,
			`await sleep(120);`,
			`await sleep(TIMEOUT_MS);`,
		].join("\n");
		const { metrics } = scanFile(content, "a.test.ts");
		expect(metrics.asNever).toBe(3);
		expect(metrics.screen).toBe(2);
		expect(metrics.innerHTMLEmpty).toBe(1);
		expect(metrics.longSleeps).toBe(2);
	});

	test("runGuard breaches budgets only on growth and formatReport names the breach", () => {
		const files: string[] = [];
		const make = (body: string, n: number): string => Array.from({ length: n }, (_, i) => body.replace("IDX", String(i))).join("\n");
		files.push(`over-as-never.test.ts:${make("const vIDX = m as never;", BUDGETS.asNever)}\nconst extra = m as never;`);
		files.push(`cap-screen.test.ts:${make("expect(screen.qIDX).toBe(1);", BUDGETS.screen)}`);
		files.push(`cap-innerhtml.test.ts:${make('function fIDX() { document.body.innerHTML = ""; }', BUDGETS.innerHTMLEmpty)}`);
		files.push(`cap-sleeps.test.ts:${make("async function fIDX() { await sleep(500); }", BUDGETS.longSleeps)}`);

		const read = (file: string): string => file.slice(file.indexOf(":") + 1);
		const report = runGuard(files, read);

		// Only the as-never cap was exceeded, by exactly one.
		expect(report.budgetBreaches.length).toBe(1);
		expect(report.budgetBreaches[0]).toContain(`as-never: ${BUDGETS.asNever + 1} > budget ${BUDGETS.asNever}`);
		expect(report.totals.screen).toBe(BUDGETS.screen);
		expect(report.totals.innerHTMLEmpty).toBe(BUDGETS.innerHTMLEmpty);
		expect(report.totals.longSleeps).toBe(BUDGETS.longSleeps);

		const text = formatReport(report);
		expect(text).toContain("Hygiene: FAIL");
		expect(text).toContain("[budget]");
	});

	test("a clean report formats OK with the budget line", () => {
		const report = runGuard([], () => "");
		const text = formatReport(report);
		expect(text).toContain("Hygiene: OK (0 test files, all rules green)");
		expect(text).toContain(`as-never 0/${BUDGETS.asNever}`);
	});

	test("the hostile-input marker exempts the path rule only (registry rule stays armed)", () => {
		const hostile = `// hygiene:allow-abs-path-inputs — zip-slip attack inputs, never loaded
` +
			`test("evil entry", () => {
  expect(resolve("C:\\Windows\\evil.dll")).toBeNull();
});
`;
		const { violations } = scanFile(hostile, "archive.test.ts");
		expect(violations.filter((v) => v.rule === "no-out-of-repo-paths")).toEqual([]);

		const hostileAndBroken = `// hygiene:allow-abs-path-inputs — x
` +
			`test("unrelated violation stays armed", () => {
  __resetTtsRegistryForTests();
});
`;
		const { violations: v2 } = scanFile(hostileAndBroken, "b.test.ts");
		expect(v2.some((x) => x.rule === "registry-reset-needs-restore")).toBe(true);
	});

	test("test-file detection covers ts/tsx in any directory", () => {
		expect(isTestFilePath("apps/web/src/lib/avatar.test.ts")).toBe(true);
		expect(isTestFilePath("apps/web/src/components/x.test.tsx")).toBe(true);
		expect(isTestFilePath("services/api/test/send-debug-log.test.ts")).toBe(true);
		expect(isTestFilePath("scripts/test-web.ts")).toBe(false);
		expect(isTestFilePath("apps/web/src/lib/avatar.ts")).toBe(false);
	});
});
