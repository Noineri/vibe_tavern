import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { failingFiles, filesWithTests, junitCrossAttribution } from "./test-junit.js";
import { classifySuiteRun, readQuarantineList } from "./test-quarantine.js";
import { testTimeoutArgs } from "./test.js";

// The JUnit parsers live in ./test-junit.js since the orchestrator started
// collecting reports for every suite (TH-8 fix step 10.2); re-exported here so
// this module's existing consumers (scripts/test-web.test.ts) keep their
// boundary unchanged.
export { failingFiles, filesWithTests, junitCrossAttribution, type FailingFile } from "./test-junit.js";

interface ParsedCli {
	readonly files: readonly string[];
	readonly randomize: boolean;
	readonly seed: string | undefined;
}

interface RunOutcome {
	readonly exitCode: number | null;
	readonly report: string;
	readonly spawnError: string | null;
}

type OutputWriter = (message: string) => void;

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_PATTERN = "apps/web/src/**/*.test.{ts,tsx}";
const TOOLING_PATTERN = "apps/web/test/*.test.{ts,tsx}";
const HARNESS_FILE = "apps/web/test/harness.smoke.test.tsx";
/**
 * Deliberately below `nproc`. `scripts/test.ts` runs this suite alongside the
 * other seven, so an unbounded default would oversubscribe the box. Measured on
 * a 16-core machine: 14.0s at 8 workers against 13.7s at 16 — the cap costs
 * essentially nothing and keeps the envelope the per-file runner had.
 */
const CONCURRENCY = 8;

function normalizePath(root: string, input: string): string | null {
	const path = relative(root, resolve(root, input));
	if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
	return path.split(sep).join("/");
}

function findDuplicate(files: readonly string[]): string | null {
	const seen = new Set<string>();
	for (const file of files) {
		if (seen.has(file)) return file;
		seen.add(file);
	}
	return null;
}

function parseCli(args: readonly string[]): ParsedCli | string {
	try {
		const { values, positionals } = parseArgs({
			args,
			options: { randomize: { type: "boolean" }, seed: { type: "string" } },
			strict: true,
			allowPositionals: true,
		});
		return { files: positionals, randomize: values.randomize ?? false, seed: values.seed };
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export async function discoverWebTestFiles(root: string): Promise<readonly string[]> {
	const files: string[] = [];
	for (const pattern of [SOURCE_PATTERN, TOOLING_PATTERN]) {
		for await (const path of new Bun.Glob(pattern).scan({
			cwd: root,
			onlyFiles: true,
			followSymlinks: false,
		})) {
			const normalized = normalizePath(root, path);
			if (normalized !== null && normalized !== HARNESS_FILE) files.push(normalized);
		}
	}
	return [...files.sort(), HARNESS_FILE];
}

async function validateFiles(root: string, files: readonly string[], write: OutputWriter): Promise<boolean> {
	const duplicate = findDuplicate(files);
	if (duplicate !== null) {
		write(`Duplicate web test file: ${duplicate}`);
		return false;
	}
	for (const file of files) {
		if (!(await Bun.file(join(root, file)).exists())) {
			write(`Missing web test file: ${file}`);
			return false;
		}
	}
	return true;
}

/**
 * One `bun test` invocation for the whole suite.
 *
 * `--parallel` implies `--isolate`: every file gets a fresh global object AND a
 * fresh module registry, which is the property this suite actually depends on.
 * `apps/web/test/dom-env.ts` registers a happy-dom window and never unregisters
 * it (unregistering closes the window React was evaluated against), while
 * DOM-averse files such as `avatar.test.ts` need `typeof window === "undefined"`
 * — so a window created by one file must not survive into the next. Verified by
 * forcing all 217 files through a single worker (`--parallel=1`): 2304 pass,
 * 0 fail.
 *
 * Timeout headroom: see scripts/test.ts.
 */
export function createWebTestCommand(
	files: readonly string[],
	reportPath: string,
	options: { readonly randomize: boolean; readonly seed: string | undefined },
): readonly string[] {
	return [
		process.execPath,
		"test",
		`--parallel=${CONCURRENCY}`,
		...testTimeoutArgs(),
		...(options.randomize ? ["--randomize"] : []),
		...(options.seed === undefined ? [] : ["--seed", options.seed]),
		"--reporter=junit",
		"--reporter-outfile",
		reportPath,
		...files,
	];
}

async function forward(stream: ReadableStream<Uint8Array>, write: OutputWriter): Promise<void> {
	const text = (await new Response(stream).text()).trimEnd();
	if (text.length > 0) write(text);
}

async function runBunTest(
	root: string,
	command: readonly string[],
	reportPath: string,
	write: OutputWriter,
): Promise<RunOutcome> {
	try {
		const child = Bun.spawn([...command], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...Bun.env, FORCE_COLOR: "0", NO_COLOR: "1" },
		});
		const [exitCode] = await Promise.all([
			child.exited,
			forward(child.stdout, write),
			forward(child.stderr, write),
		]);
		const report = await Bun.file(reportPath).exists() ? await Bun.file(reportPath).text() : "";
		return { exitCode, report, spawnError: null };
	} catch (error) {
		return {
			exitCode: null,
			report: "",
			spawnError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
		};
	}
}

export async function runWebTestCli(
	args: readonly string[],
	root: string = ROOT,
	write: OutputWriter = console.log,
	errorWrite: OutputWriter = console.error,
	/**
	 * Optional path the finished JUnit report is copied to after the run: the
	 * orchestrator's quarantine handoff (see the entry point below). Undefined
	 * for standalone runs and every test-driven call — a nested call must never
	 * inherit it and clobber an outer suite's report.
	 */
	junitHandoffPath?: string,
): Promise<number> {
	const parsed = parseCli(args);
	if (typeof parsed === "string") {
		write(`Invalid web test arguments: ${parsed}`);
		return 2;
	}

	let files: readonly string[];
	if (parsed.files.length > 0) {
		const normalized: string[] = [];
		for (const file of parsed.files) {
			const path = normalizePath(root, file);
			if (path === null) {
				write(`Web test file must be inside the repository root: ${file}`);
				return 1;
			}
			normalized.push(path);
		}
		files = normalized.sort();
	} else {
		try {
			const discovered = await discoverWebTestFiles(root);
			if (discovered.length <= 1) {
				write(`No web source test files discovered by ${SOURCE_PATTERN} or ${TOOLING_PATTERN}`);
				return 1;
			}
			files = discovered;
		} catch (error) {
			write(`Web test discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}

	if (!(await validateFiles(root, files, write))) return 1;

	const order = parsed.randomize ? `randomized${parsed.seed === undefined ? "" : ` seed ${parsed.seed}`}` : "sorted";
	write(`Running ${files.length} isolated web test files (${order}, max ${CONCURRENCY} workers)...`);

	const reportDirectory = await mkdtemp(join(tmpdir(), "vibe-tavern-test-web-reports-"));
	const reportPath = join(reportDirectory, "web.xml");
	let outcome: RunOutcome;
	try {
		const command = createWebTestCommand(files, reportPath, parsed);
		outcome = await runBunTest(root, command, reportPath, write);
		// The orchestrator's handoff: it cannot append reporter flags to this
		// suite's `bun run test` command (strict parseArgs exits 2 on unknown
		// flags), so it hands a target path down instead and classifies the web
		// run with the same shared verdict every other suite gets. Copied BEFORE
		// the temp dir below is swept, so the caller reads it only after exit.
		if (junitHandoffPath !== undefined && outcome.report !== "") {
			await Bun.write(junitHandoffPath, outcome.report);
		}
	} finally {
		await rm(reportDirectory, { recursive: true, force: true });
	}

	if (outcome.spawnError !== null) {
		errorWrite(`Web test run failed to start: ${outcome.spawnError}`);
		write(`\nWeb tests: FAIL (${files.length} files)`);
		return 1;
	}

	// Which tests failed and where is on screen above, printed by bun's own
	// reporter — but CI log systems truncate exactly that part (see the comment
	// on failingFiles in ./test-junit.js), so the runner names the failing files
	// itself from the JUnit report, which no truncation can eat. The empty-file
	// list remains the part bun cannot tell us. This block prints for EVERY
	// bun-reported failure, quarantined or not — the quarantine verdict below
	// decides the exit code, never the on-screen record.
	const covered = filesWithTests(outcome.report);
	const empty = files.filter((file) => !covered.has(file));
	if (empty.length > 0) {
		errorWrite(`Web test files declaring zero tests (${empty.length}):\n${empty.join("\n")}`);
	}
	if (outcome.exitCode !== 0) {
		const failing = [...failingFiles(outcome.report).values()].sort(
			(a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
		);
		if (failing.length > 0) {
			const lines = failing.flatMap((entry) => [
				`FAIL ${entry.file} (${entry.count} failed)`,
				...entry.entries.map(
				(e) =>
					`  · ${e.name}${e.message === "" ? "" : ` — ${e.message}`}${
						(() => {
							const note = junitCrossAttribution(entry.file, e.message);
							return note === null ? "" : `
  ⚠ ${note}`;
						})()
					}`,
			),
			]);
			errorWrite(`Web test files with failures (${failing.length}):\n${lines.join("\n")}`);
		} else {
			errorWrite(
				"Web test failed, but no failing test case was found in the JUnit report — " +
					"the failure is file-level (unhandled rejection or a crash); see bun's output above.",
			);
		}
	}
	// The quarantine verdict (TH-8 fix step 10.2): a run whose every failed
	// test case matches the committed quarantine list PASSES even though bun
	// exited non-zero; file-level failures and any unmatched failure still fail
	// the suite. Quarantined tests still ran — no skips, no retries.
	const verdict = classifySuiteRun({
		exitCode: outcome.exitCode,
		report: outcome.report,
		suite: "web",
		quarantine: await readQuarantineList(),
	});
	if (empty.length > 0 || verdict.blocking.length > 0 || verdict.fileLevel.length > 0) {
		write(`\nWeb tests: FAIL (${files.length} files)`);
		return 1;
	}
	write(`\nWeb tests: PASS (${files.length} files)`);
	if (verdict.quarantined.length > 0) {
		write(`Quarantined failures (${verdict.quarantined.length}):`);
		for (const entry of verdict.quarantined) {
			write(`  ${entry.suite} · ${entry.file} · ${entry.test} · since ${entry.since} · ${entry.reason}`);
		}
	}
	return 0;
}

if (import.meta.main) {
	// The orchestrator (scripts/test.ts) spawns this suite as `bun run test`
	// with VIBE_TAVERN_TEST_JUNIT_OUT pointing into the suite's private temp
	// root; read it ONCE, here, so nested runWebTestCli calls (this module's own
	// tests) never inherit it and clobber an outer suite's report.
	const handoff = Bun.env.VIBE_TAVERN_TEST_JUNIT_OUT;
	process.exitCode = await runWebTestCli(
		process.argv.slice(2),
		ROOT,
		console.log,
		console.error,
		handoff === undefined || handoff === "" ? undefined : handoff,
	);
}
