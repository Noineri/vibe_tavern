import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { testTimeoutArgs } from "./test.js";

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

/**
 * Files the JUnit report saw at least one test case for, keyed the way the rest
 * of this script keys files: repository-relative with forward slashes. The paths
 * are repository-relative already because the child runs with `cwd: root`, but
 * the reporter writes them with the PLATFORM separator — `apps\web\test\a.test.ts`
 * on Windows — so they are re-slashed before the caller can compare them against
 * a normalized file list. Skipping that turns every file on Windows into an
 * apparent zero-test file.
 *
 * `bun test` exits 0 for a file that registers no tests at all, so this set is
 * the only thing standing between a silently emptied test file and a green suite.
 *
 * `>` is XML-escaped inside attribute values, so `[^>]*` cannot run past the
 * element it started in.
 */
export function filesWithTests(report: string): ReadonlySet<string> {
	return new Set(
		[...report.matchAll(/<testcase\b[^>]*\bfile="([^"]+)"/g)].flatMap((match) =>
			match[1] === undefined ? [] : [match[1].replaceAll("\\", "/")],
		),
	);
}

export async function runWebTestCli(
	args: readonly string[],
	root: string = ROOT,
	write: OutputWriter = console.log,
	errorWrite: OutputWriter = console.error,
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
	} finally {
		await rm(reportDirectory, { recursive: true, force: true });
	}

	if (outcome.spawnError !== null) {
		errorWrite(`Web test run failed to start: ${outcome.spawnError}`);
		write(`\nWeb tests: FAIL (${files.length} files)`);
		return 1;
	}

	// Which tests failed and where is already on screen above, printed by bun's
	// own reporter — re-deriving it from the report would only duplicate it. The
	// exit code is the verdict; the empty-file list is the part bun cannot tell us.
	const covered = filesWithTests(outcome.report);
	const empty = files.filter((file) => !covered.has(file));
	if (empty.length > 0) {
		errorWrite(`Web test files declaring zero tests (${empty.length}):\n${empty.join("\n")}`);
	}
	if (empty.length > 0 || outcome.exitCode !== 0) {
		write(`\nWeb tests: FAIL (${files.length} files)`);
		return 1;
	}
	write(`\nWeb tests: PASS (${files.length} files)`);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await runWebTestCli(process.argv.slice(2));
}
