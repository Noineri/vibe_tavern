import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { windowsTimeoutArgs } from "./test.js";

interface TestFileResult {
	readonly file: string;
	readonly exitCode: number | null;
	readonly testCount: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface ParsedCli {
	readonly files: readonly string[];
	readonly reverse: boolean;
}

type OutputWriter = (message: string) => void;

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_PATTERN = "apps/web/src/**/*.test.{ts,tsx}";
const TOOLING_PATTERN = "apps/web/test/*.test.{ts,tsx}";
const HARNESS_FILE = "apps/web/test/harness.smoke.test.tsx";
const CONCURRENCY = 8;
const MAX_FAILURE_STDERR_LINES = 40;

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
			options: { reverse: { type: "boolean" } },
			strict: true,
			allowPositionals: true,
		});
		return { files: positionals, reverse: values.reverse ?? false };
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

/** Per-file `bun test` invocation. Windows headroom: see scripts/test.ts. */
export function createWebTestFileCommand(
	file: string,
	reportPath: string,
	platform: NodeJS.Platform = process.platform,
): readonly string[] {
	return [
		process.execPath,
		"test",
		...windowsTimeoutArgs(platform),
		file,
		"--reporter=junit",
		"--reporter-outfile",
		reportPath,
	];
}

async function runTestFile(root: string, file: string, reportPath: string): Promise<TestFileResult> {
	try {
		const child = Bun.spawn(
			[...createWebTestFileCommand(file, reportPath)],
			{
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...Bun.env, FORCE_COLOR: "0", NO_COLOR: "1" },
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const report = await Bun.file(reportPath).exists() ? await Bun.file(reportPath).text() : "";
		return {
			file,
			exitCode,
			testCount: report.match(/<testcase(?:\s|>)/g)?.length ?? 0,
			stdout,
			stderr,
		};
	} catch (error) {
		return {
			file,
			exitCode: null,
			testCount: 0,
			stdout: "",
			stderr: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
		};
	}
}

async function runTestFiles(root: string, files: readonly string[]): Promise<readonly TestFileResult[]> {
	const reportDirectory = await mkdtemp(join(tmpdir(), "vibe-tavern-test-web-reports-"));
	const results: Array<TestFileResult | undefined> = Array.from({ length: files.length });
	try {
		const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, async (_, workerIndex) => {
			for (let index = workerIndex; index < files.length; index += CONCURRENCY) {
				const file = files[index];
				if (file !== undefined) {
					results[index] = await runTestFile(root, file, join(reportDirectory, `${index}.xml`));
				}
			}
		});
		await Promise.all(workers);
		return results.flatMap((result) => (result === undefined ? [] : [result]));
	} finally {
		await rm(reportDirectory, { recursive: true, force: true });
	}
}

function writeResults(results: readonly TestFileResult[], write: OutputWriter): boolean {
	let passed = true;
	for (const [index, result] of results.entries()) {
		write(`\n[${index + 1}/${results.length}] ${result.file}`);
		if (result.stdout.trim().length > 0) write(result.stdout.trimEnd());
		if (result.stderr.trim().length > 0) write(result.stderr.trimEnd());
		if (result.exitCode === 0 && result.testCount > 0) {
			write(`PASS ${result.file} (${result.testCount} tests)`);
		} else {
			passed = false;
			const reason = result.testCount === 0 ? "zero tests" : `exit ${result.exitCode ?? "spawn error"}`;
			write(`FAIL ${result.file} (${reason})`);
		}
	}
	return passed;
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

	if (parsed.reverse) files = [...files].reverse();
	if (!(await validateFiles(root, files, write))) return 1;

	write(`Running ${files.length} isolated web test files (${parsed.reverse ? "reverse" : "sorted"}, max ${CONCURRENCY})...`);
	const results = await runTestFiles(root, files);
	if (results.length !== files.length) {
		write(`Web test orchestration failed: expected ${files.length} results, received ${results.length}`);
		return 1;
	}
	const passed = writeResults(results, write);
	if (!passed) {
		const failures = results.filter((result) => result.exitCode !== 0 || result.testCount === 0);
		const lines = failures.map((result) => {
			const reason = result.testCount === 0 ? "zero tests" : `exit ${result.exitCode ?? "spawn error"}`;
			const stderrTail = result.stderr.trim().split("\n").slice(-MAX_FAILURE_STDERR_LINES).join("\n");
			return stderrTail === "" ? `${result.file} (${reason})` : `${result.file} (${reason})\n${stderrTail}`;
		});
		errorWrite(`Failing web test files (${failures.length}):\n${lines.join("\n")}`);
	}
	write(`\nWeb tests: ${passed ? "PASS" : "FAIL"} (${results.length} files)`);
	return passed ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await runWebTestCli(process.argv.slice(2));
}
