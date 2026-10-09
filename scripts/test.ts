import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatTestReport, type TestSuiteResult } from "./test-report.js";
import { classifySuiteRun, readQuarantineList, type QuarantineEntry } from "./test-quarantine.js";

export { formatTestReport, type TestSuiteResult } from "./test-report.js";

export interface TestSuite {
	readonly name: string;
	readonly cwd: string;
	readonly command: readonly string[];
	/**
	 * Dropped from a bare `bun run test` only on Windows CI, where every syscall
	 * costs 2–4× what it does on Linux and this suite has no platform-specific
	 * behaviour to pin. Local Windows runs include it; naming it
	 * (`bun run test web`) runs it everywhere.
	 */
	readonly skipOnWindows?: boolean;
	/**
	 * JUnit collection for the quarantine verdict (TH-8 fix step 10.2).
	 *
	 * - `"appended"`: the suite is a plain `bun test` invocation, so the runner
	 *   appends `--reporter=junit --reporter-outfile <suite temp root>/junit.xml`
	 *   AT SPAWN TIME. The flags deliberately stay out of `command` itself —
	 *   that array is the declared, pinned argv (`suite.command` is asserted in
	 *   test.test.ts), and the report path is per-run private state.
	 * - `"child"`: the suite's command cannot take reporter flags (the web suite
	 *   runs `bun run test`, whose strict parseArgs exits 2 on unknown flags);
	 *   its own runner writes the report. The target path is handed down via the
	 *   `VIBE_TAVERN_TEST_JUNIT_OUT` environment variable and read here after
	 *   the child exits.
	 */
	readonly junit?: "appended" | "child";
}

export type TestSuiteStartHandler = (suite: TestSuite, index: number, total: number) => void;
export type TestOutputWriter = (message: string) => void;

const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath;

/**
 * Per-test timeout for every `bun test` invocation. Bun's 5s default is a
 * product-sized budget; these suites run several at a time (see
 * `runTestSuites`) on shared CI runners, so a test doing a normal amount of
 * SQLite + filesystem work can lose seconds to contention alone. Windows is the
 * worst case — a `mkdtemp` + full migration stack costs milliseconds on Linux
 * and seconds there — but the floor is machine speed under load, not platform,
 * so the headroom is unconditional.
 *
 * The budget also bounds the store-cleanup preload's process-global afterAll
 * (close every SQLite handle + sweep the run's temp dirs, see
 * services/api/test/store-cleanup.ts). That hook is legitimate long-pole work,
 * NOT a hung test: measured 16.6s / 18.7s on the GitHub Windows runner with
 * 2–4 suites sweeping concurrently, and ~26s locally under a full-suite load —
 * all over a previous 15s budget while every actual test passed. That was
 * historically the only lever (the old numeric form `afterAll(fn, ms)` never
 * worked), but as of bun 1.3.13 the object form does: each preload hook now
 * carries its own explicit `{ timeout: 180_000 }` (covers direct `bun test`
 * runs in a workspace, which don't pass --timeout and would otherwise burst
 * bun's 5s hook default with a phantom `(unnamed)` failure). This global
 * budget remains for the TESTS themselves under CI contention.
 */
export const TEST_TIMEOUT_MS = 45_000;

export function testTimeoutArgs(): readonly string[] {
	return ["--timeout", String(TEST_TIMEOUT_MS)];
}

/** `bun test` invocation for one suite. Flags precede the positional filter. */
function bunTestCommand(...positionals: readonly string[]): readonly string[] {
	return [BUN, "test", "--only-failures", ...testTimeoutArgs(), ...positionals];
}

/**
 * Declared longest-first. `runTestSuites` hands these to a worker pool in this
 * order, so a long suite declared last would start last and run alone at the
 * tail; the ranking is what keeps the pool busy to the end.
 */
export function createTestSuites(): readonly TestSuite[] {
	return [
		{
			// One `bun test --parallel=8` run under --isolate — the timeout and the
			// zero-test guard live in scripts/test-web.ts.
			// In Windows CI, all but two of its 336 files are React components and
			// stores; exactly two touch `node:fs`/`node:path`/`process.platform`, so
			// that job gains no Windows-specific coverage for its ~83s cost.
			name: "web",
			cwd: join(ROOT, "apps", "web"),
			command: [BUN, "run", "test"],
			skipOnWindows: true,
			junit: "child",
		},
		{
			name: "api",
			cwd: join(ROOT, "services", "api"),
			command: bunTestCommand(),
			junit: "appended",
		},
		{
			name: "db",
			cwd: join(ROOT, "packages", "db"),
			command: bunTestCommand(),
			junit: "appended",
		},
		{
			name: "scripts",
			cwd: ROOT,
			command: bunTestCommand("scripts"),
			junit: "appended",
		},
		{
			name: "prompt-pipeline",
			cwd: join(ROOT, "packages", "prompt-pipeline"),
			command: bunTestCommand(),
			junit: "appended",
		},
		{
			name: "api-contracts",
			cwd: join(ROOT, "packages", "api-contracts"),
			command: bunTestCommand(),
			junit: "appended",
		},
		{
			name: "import-export",
			cwd: join(ROOT, "packages", "import-export"),
			command: bunTestCommand(),
			junit: "appended",
		},
		{
			name: "domain",
			cwd: join(ROOT, "packages", "domain"),
			command: bunTestCommand(),
			junit: "appended",
		},
	];
}

const TEST_SUITES = createTestSuites();

/** Host desktop-proxy variables dropped from every spawned suite's
 *  environment. Bun's fetch reads HTTP(S)_PROXY / NO_PROXY at process start
 *  and honors them EVEN when tests inject an explicit per-request `proxy`
 *  option — on a developer machine running a system proxy (HTTP_PROXY=http://
 *  127.0.0.1:… + NO_PROXY=localhost,127.0.0.1), the loopback mock targets of
 *  the proxy-traversal suites bypassed their per-test mock proxies, failing
 *  3 tests locally while CI (no proxy env) stayed green. Test processes must
 *  pin VT's proxy semantics, not inherit the desktop setup — same rationale
 *  as the FORCE_COLOR/NO_COLOR overrides below. (In-file env mutation cannot
 *  fix this: the values are captured before any test file's code runs;
 *  verified 2026-09-14.) */
const HOST_PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

/** Suite spawn environment: the host env minus the desktop proxy variables
 *  (see HOST_PROXY_ENV_KEYS), plus the per-suite temp, color and — for suites
 *  whose own runner writes the JUnit report — quarantine-handoff overrides. */
function suiteSpawnEnv(suiteTempRoot: string, junitOut?: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value === undefined) continue;
		if ((HOST_PROXY_ENV_KEYS as readonly string[]).includes(key)) continue;
		env[key] = value;
	}
	env.TEMP = suiteTempRoot;
	env.TMP = suiteTempRoot;
	env.TMPDIR = suiteTempRoot;
	env.FORCE_COLOR = "0";
	env.NO_COLOR = "1";
	if (junitOut !== undefined) env.VIBE_TAVERN_TEST_JUNIT_OUT = junitOut;
	return env;
}

async function runTestSuite(
	suite: TestSuite,
	tempRoot: string,
	quarantine: readonly QuarantineEntry[],
): Promise<TestSuiteResult> {
	const startedAt = performance.now();
	// PER-SUITE temp dir, deliberately not shared: suites run several at a time,
	// and the store-cleanup preload's process-global afterAll sweeps `vt-*` dirs
	// in TMPDIR created after its own start. With one shared root, a fast suite
	// (scripts finishes in ~3s) sweeps a slow suite's LIVE dirs mid-test — rm of
	// open files succeeds on Linux, so the victim gets ENOENT / empty scans
	// (observed as CI flakes: st-directory-scanner characters=0, gallery-avatar
	// promote 400). A private root makes the sweep structurally incapable of
	// seeing another suite's dirs. The runner's final recursive rm of the shared
	// root still cleans everything up.
	const suiteTempRoot = await mkdtemp(join(tempRoot, `${suite.name}-`));
	// The JUnit report always lands in the suite's OWN private temp root: two
	// suites must never share a report path, and the root is swept with it.
	const junitReportPath = suite.junit === undefined ? null : join(suiteTempRoot, "junit.xml");
	try {
		const process = Bun.spawn(
			[
				...suite.command,
				// Reporter flags are appended at spawn time, never baked into
				// `command` — see TestSuite.junit. Bun accepts flags after the
				// positional filter (verified on 1.4.2), and the console reporter
				// still prints alongside the junit outfile.
				...(suite.junit === "appended" && junitReportPath !== null
					? ["--reporter=junit", "--reporter-outfile", junitReportPath]
					: []),
			],
			{
				cwd: suite.cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: suiteSpawnEnv(
					suiteTempRoot,
					suite.junit === "child" && junitReportPath !== null ? junitReportPath : undefined,
				),
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		const durationMs = Math.round(performance.now() - startedAt);
		if (junitReportPath === null) {
			return { name: suite.name, exitCode, durationMs, stdout, stderr };
		}
		// The quarantine verdict (TH-8 fix step 10.2): a suite whose every failed
		// test case matches the committed list PASSES even though bun exited
		// non-zero, so the recorded exit code becomes the verdict; anything the
		// verdict still blocks keeps bun's own non-zero code. The quarantined
		// matches ride on the result so the final report can list them.
		const report = await Bun.file(junitReportPath).exists()
			? await Bun.file(junitReportPath).text()
			: "";
		const verdict = classifySuiteRun({ exitCode, report, suite: suite.name, quarantine });
		const green = verdict.blocking.length === 0 && verdict.fileLevel.length === 0;
		return {
			name: suite.name,
			exitCode: green ? 0 : exitCode,
			durationMs,
			stdout,
			stderr,
			quarantined: verdict.quarantined,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		return {
			name: suite.name,
			exitCode: null,
			durationMs: Math.round(performance.now() - startedAt),
			stdout: "",
			stderr: message,
		};
	}
}

export interface TestRunOptions {
	/** Existing directory used as the parent for this run's disposable temp root. */
	readonly tempBase?: string;
	/** How many suites may run at once. Defaults to `suiteConcurrency()`. */
	readonly concurrency?: number;
	/** Overrides the committed quarantine list (scripts/test-quarantine.json) —
	 *  tests inject entries without touching the repo. */
	readonly quarantine?: readonly QuarantineEntry[];
}

/**
 * Half the cores, floored at 2 and capped at 4. `web` fans its own files out to
 * 8 subprocesses, so the pool only has to keep the single-process suites (`api`,
 * `db`, `scripts`) off the critical path — past ~3 the runner is saturated and
 * extra slots only add contention. Measured on a 4-core box (`taskset -c 0-3`):
 * 69.1s sequential, 50.9s at 2 and 3, 53.7s at 4.
 */
export function suiteConcurrency(cores: number = availableParallelism()): number {
	return Math.max(2, Math.min(4, Math.floor(cores / 2)));
}

export async function runTestSuites(
	suites: readonly TestSuite[],
	onStart?: TestSuiteStartHandler,
	options: TestRunOptions = {},
): Promise<readonly TestSuiteResult[]> {
	const tempBase = resolve(options.tempBase ?? Bun.env.VIBE_TAVERN_TEST_TEMP_BASE ?? tmpdir());
	await mkdir(tempBase, { recursive: true });
	const testTempRoot = await mkdtemp(join(tempBase, "vibe-tavern-test-run-"));
	const quarantine = options.quarantine ?? await readQuarantineList();
	// Indexed rather than pushed: suites finish out of order, the report must not.
	const results: Array<TestSuiteResult | undefined> = Array.from({ length: suites.length });
	const poolSize = Math.max(1, Math.min(options.concurrency ?? suiteConcurrency(), suites.length));
	let next = 0;
	try {
		await Promise.all(
			Array.from({ length: poolSize }, async () => {
				for (let index = next++; index < suites.length; index = next++) {
					const suite = suites[index];
					if (suite === undefined) continue;
					onStart?.(suite, index, suites.length);
					results[index] = await runTestSuite(suite, testTempRoot, quarantine);
				}
			}),
		);
		return results.flatMap((result) => (result === undefined ? [] : [result]));
	} finally {
		await rm(testTempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

type TestSuiteSelection =
	| { readonly kind: "selected"; readonly suites: readonly TestSuite[] }
	| { readonly kind: "error"; readonly message: string };

function selectTestSuites(
	suites: readonly TestSuite[],
	args: readonly string[],
	platform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv,
): TestSuiteSelection {
	if (args.length === 0) {
		return {
			kind: "selected",
			suites: platform === "win32" && environment.CI
				? suites.filter((suite) => suite.skipOnWindows !== true)
				: suites,
		};
	}

	const suitesByName = new Map(suites.map((suite) => [suite.name, suite]));
	const selected: TestSuite[] = [];
	const unknownNames: string[] = [];
	for (const name of args) {
		const suite = suitesByName.get(name);
		if (suite) {
			if (!selected.includes(suite)) selected.push(suite);
		} else {
			unknownNames.push(name);
		}
	}

	if (unknownNames.length > 0) {
		return {
			kind: "error",
			message: [
				`Unknown test suite: ${unknownNames.join(", ")}`,
				`Available suites: ${suites.map((suite) => suite.name).join(", ")}`,
				"Usage: bun run test [suite ...]",
			].join("\n"),
		};
	}

	return { kind: "selected", suites: selected };
}

export async function runTestCli(
	suites: readonly TestSuite[],
	args: readonly string[],
	write: TestOutputWriter,
	platform: NodeJS.Platform = process.platform,
	environment: NodeJS.ProcessEnv = process.env,
	quarantine?: readonly QuarantineEntry[],
): Promise<number> {
	const selection = selectTestSuites(suites, args, platform, environment);
	switch (selection.kind) {
		case "error":
			write(selection.message);
			return 1;
		case "selected": {
			const skipped = args.length === 0 ? suites.filter((suite) => !selection.suites.includes(suite)) : [];
			if (skipped.length > 0) {
				write(`Skipping on ${platform}: ${skipped.map((suite) => suite.name).join(", ")}`);
			}
			write(`Running ${selection.suites.length} isolated test suites (max ${suiteConcurrency()} at a time)...`);
			const startedAt = performance.now();
			const results = await runTestSuites(selection.suites, (suite, index, total) => {
				write(`[${index + 1}/${total}] ${suite.name}`);
			}, { quarantine });
			write(`\n${formatTestReport(results, Math.round(performance.now() - startedAt))}`);
			return results.some((result) => result.exitCode !== 0) ? 1 : 0;
		}
		default: {
			const exhaustiveSelection: never = selection;
			return exhaustiveSelection;
		}
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { tokens } = parseArgs({
		args,
		options: {},
		strict: false,
		allowPositionals: true,
		tokens: true,
	});
	const parsedArgs = [...new Set(tokens.map((token) => token.index))].flatMap((index) => {
		const arg = args[index];
		return arg === undefined ? [] : [arg];
	});
	process.exitCode = await runTestCli(TEST_SUITES, parsedArgs, console.log);
}

if (import.meta.main) {
	await main();
}
