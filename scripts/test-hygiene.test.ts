import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUDGETS,
	collectTestFiles,
	formatReport,
	isTestFilePath,
	KNOWN_SUITES,
	runGuard,
	scanFile,
	validateQuarantineList,
	writeReminderLines,
} from "./test-hygiene.js";

describe("test-hygiene guard (TH-4c, L2 layer)", () => {
	test("collects this checkout's tests without traversing nested repositories or worktrees", () => {
		const root = mkdtempSync(join(tmpdir(), "vt-hygiene-"));
		try {
			mkdirSync(join(root, ".git"));
			writeFileSync(join(root, "root.test.ts"), "");
			for (const [path, worktree] of [[".claude/worktrees/example", true], ["vendor/repo", false]] as const) {
				const nested = join(root, path);
				mkdirSync(nested, { recursive: true });
				if (worktree) writeFileSync(join(nested, ".git"), "gitdir: placeholder");
				else mkdirSync(join(nested, ".git"));
				writeFileSync(join(nested, "nested.test.ts"), "");
			}
			mkdirSync(join(root, "apps/web"), { recursive: true });
			writeFileSync(join(root, "apps/web/component.test.tsx"), "");
			expect(collectTestFiles(root)).toEqual(["apps/web/component.test.tsx", "root.test.ts"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

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

	test("rejects static RTL imports in web tests and accepts a dynamic import after useDomEnv", () => {
		const normal = scanFile(
			`import { render } from "@testing-library/react";\nuseDomEnv();\n`,
			"apps/web/src/example.test.tsx",
		);
		expect(normal.violations.some((v) => v.rule === "rtl-import-needs-dom-env")).toBe(true);

		const multilineTypeOnly = scanFile(
			`import type {\n  RenderResult,\n} from "@testing-library/react";\n`,
			"apps/web/src/example.test.tsx",
		);
		expect(multilineTypeOnly.violations.some((v) => v.rule === "rtl-import-needs-dom-env")).toBe(true);

		const dynamic = scanFile(
			`useDomEnv();\nconst { render } = await import("@testing-library/react");\ntype RenderResult = import("@testing-library/react").RenderResult;\n`,
			"apps/web/src/example.test.tsx",
		);
		expect(dynamic.violations.filter((v) => v.rule === "rtl-import-needs-dom-env")).toEqual([]);
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

describe("quarantine hygiene (TH-8 fix step 10.3)", () => {
	const TODAY = "2026-10-31";

	function makeTempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "vt-hygiene-q-"));
		writeFileSync(join(root, "exists.test.ts"), "");
		return root;
	}

	function listOf(...entries: readonly unknown[]): string {
		return JSON.stringify(entries);
	}

	function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			suite: "api",
			file: "exists.test.ts",
			test: "A ctx > leaf",
			reason: "known flake — TEST_SUITE_HYGIENE_REPORT fix step 10",
			since: "2026-09-30",
			...overrides,
		};
	}

	test("the known-suite check covers all eight orchestrator suites", () => {
		expect([...KNOWN_SUITES].sort()).toEqual([
			"api",
			"api-contracts",
			"db",
			"domain",
			"import-export",
			"prompt-pipeline",
			"scripts",
			"web",
		].sort());
	});

	test("a 31-day-old entry produces the reminder line and no violation", () => {
		const root = makeTempRoot();
		try {
			// since 2026-09-30 → today 2026-10-31 = 31 days.
			const report = validateQuarantineList(listOf(validEntry({ since: "2026-09-30" })), root, TODAY);
			expect(report.violations).toEqual([]);
			expect(report.reminders).toEqual([
				"quarantined since 2026-09-30 (31 days): api A ctx > leaf",
			]);
			// The reminder never fails the guard.
			const text = formatReport(runGuard([], () => ""), report);
			expect(text).toContain("Hygiene: OK (0 test files, all rules green)");
			expect(text).toContain("quarantined since 2026-09-30 (31 days): api A ctx > leaf");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the reminder boundary is strictly greater than 30 days", () => {
		const root = makeTempRoot();
		try {
			// exactly 30 days (2026-10-01 → 2026-10-31) — not a reminder.
			const at30 = validateQuarantineList(listOf(validEntry({ since: "2026-10-01" })), root, TODAY);
			expect(at30.violations).toEqual([]);
			expect(at30.reminders).toEqual([]);
			// 31 days — reminder.
			const at31 = validateQuarantineList(listOf(validEntry({ since: "2026-09-30" })), root, TODAY);
			expect(at31.reminders).toEqual(["quarantined since 2026-09-30 (31 days): api A ctx > leaf"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a future since date", () => {
		const root = makeTempRoot();
		try {
			const { violations } = validateQuarantineList(listOf(validEntry({ since: "2026-11-01" })), root, TODAY);
			expect(violations.some((v) => v.rule === "quarantine-future-since")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects an unknown suite", () => {
		const root = makeTempRoot();
		try {
			const { violations } = validateQuarantineList(listOf(validEntry({ suite: "nope" })), root, TODAY);
			expect(violations.some((v) => v.rule === "quarantine-unknown-suite")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a missing file", () => {
		const root = makeTempRoot();
		try {
			const { violations } = validateQuarantineList(listOf(validEntry({ file: "missing.test.ts" })), root, TODAY);
			expect(violations.some((v) => v.rule === "quarantine-missing-file")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects an empty test and an empty reason", () => {
		const root = makeTempRoot();
		try {
			const emptyTest = validateQuarantineList(listOf(validEntry({ test: "" })), root, TODAY);
			expect(emptyTest.violations.some((v) => v.rule === "quarantine-empty-test")).toBe(true);
			const emptyReason = validateQuarantineList(listOf(validEntry({ reason: "  " })), root, TODAY);
			expect(emptyReason.violations.some((v) => v.rule === "quarantine-empty-reason")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a malformed since date and a non-array list", () => {
		const root = makeTempRoot();
		try {
			const badSince = validateQuarantineList(listOf(validEntry({ since: "10-01" })), root, TODAY);
			expect(badSince.violations.some((v) => v.rule === "quarantine-bad-since")).toBe(true);
			const notArray = validateQuarantineList(JSON.stringify({ suite: "api" }), root, TODAY);
			expect(notArray.violations.some((v) => v.rule === "quarantine-not-array")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects unparsable JSON", () => {
		const root = makeTempRoot();
		try {
			const { violations } = validateQuarantineList("{ not json", root, TODAY);
			expect(violations.some((v) => v.rule === "quarantine-json-unparsable")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("appends reminder lines to the step summary and no-ops without a path", () => {
		const root = makeTempRoot();
		try {
			const summaryPath = join(root, "summary.md");
			const reminders = ["quarantined since 2026-09-30 (31 days): api A ctx > leaf"];
			writeReminderLines(reminders, summaryPath);
			expect(readFileSync(summaryPath, "utf8")).toBe("quarantined since 2026-09-30 (31 days): api A ctx > leaf\n");
			expect(() => writeReminderLines(reminders, undefined)).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
