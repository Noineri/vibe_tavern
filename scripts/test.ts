import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatTestReport, type TestSuiteResult } from "./test-report.js";

export { formatTestReport, type TestSuiteResult } from "./test-report.js";

export interface TestSuite {
	readonly name: string;
	readonly cwd: string;
	readonly command: readonly string[];
	/**
	 * Dropped from a bare `bun run test` on Windows, where every syscall costs
	 * 2–4× what it does on Linux and this suite has no platform-specific
	 * behaviour to pin. Naming it (`bun run test web`) still runs it anywhere.
	 */
	readonly skipOnWindows?: boolean;
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
 * carries its own explicit `{ timeout: 60_000 }` (covers direct `bun test`
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
			// Runs each file in its own subprocess — the timeout lives in scripts/test-web.ts.
			// 160+ of its 162 files are React components and stores; exactly two touch
			// `node:fs`/`node:path`/`process.platform`, so it buys no Windows coverage
			// for the ~83s it costs there.
			name: "web",
			cwd: join(ROOT, "apps", "web"),
			command: [BUN, "run", "test"],
			skipOnWindows: true,
		},
		{
			name: "api",
			cwd: join(ROOT, "services", "api"),
			command: bunTestCommand(),
		},
		{
			name: "db",
			cwd: join(ROOT, "packages", "db"),
			command: bunTestCommand(),
		},
		{
			name: "scripts",
			cwd: ROOT,
			command: bunTestCommand("scripts"),
		},
		{
			name: "prompt-pipeline",
			cwd: join(ROOT, "packages", "prompt-pipeline"),
			command: bunTestCommand(),
		},
		{
			name: "api-contracts",
			cwd: join(ROOT, "packages", "api-contracts"),
			command: bunTestCommand(),
		},
		{
			name: "import-export",
			cwd: join(ROOT, "packages", "import-export"),
			command: bunTestCommand(),
		},
		{
			name: "domain",
			cwd: join(ROOT, "packages", "domain"),
			command: bunTestCommand(),
		},
	];
}

const TEST_SUITES = createTestSuites();

async function runTestSuite(suite: TestSuite, tempRoot: string): Promise<TestSuiteResult> {
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
	try {
		const process = Bun.spawn([...suite.command], {
			cwd: suite.cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...Bun.env,
				TEMP: suiteTempRoot,
				TMP: suiteTempRoot,
				TMPDIR: suiteTempRoot,
				FORCE_COLOR: "0",
				NO_COLOR: "1",
			},
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		return {
			name: suite.name,
			exitCode,
			durationMs: Math.round(performance.now() - startedAt),
			stdout,
			stderr,
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
					results[index] = await runTestSuite(suite, testTempRoot);
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
): TestSuiteSelection {
	if (args.length === 0) {
		return {
			kind: "selected",
			suites: platform === "win32" ? suites.filter((suite) => suite.skipOnWindows !== true) : suites,
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
): Promise<number> {
	const selection = selectTestSuites(suites, args, platform);
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
			});
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
