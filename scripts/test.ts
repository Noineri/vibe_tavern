import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatTestReport, type TestSuiteResult } from "./test-report.js";

export { formatTestReport, type TestSuiteResult } from "./test-report.js";

export interface TestSuite {
	readonly name: string;
	readonly cwd: string;
	readonly command: readonly string[];
}

export type TestSuiteStartHandler = (suite: TestSuite, index: number, total: number) => void;
export type TestOutputWriter = (message: string) => void;

const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath;

const TEST_SUITES = [
	{
		name: "scripts",
		cwd: ROOT,
		command: [BUN, "test", "--only-failures", "scripts"],
	},
	{
		name: "domain",
		cwd: join(ROOT, "packages", "domain"),
		command: [BUN, "test", "--only-failures"],
	},
	{
		name: "api-contracts",
		cwd: join(ROOT, "packages", "api-contracts"),
		command: [BUN, "test", "--only-failures"],
	},
	{
		name: "prompt-pipeline",
		cwd: join(ROOT, "packages", "prompt-pipeline"),
		command: [BUN, "test", "--only-failures"],
	},
	{
		name: "import-export",
		cwd: join(ROOT, "packages", "import-export"),
		command: [BUN, "test", "--only-failures"],
	},
	{
		name: "db",
		cwd: join(ROOT, "packages", "db"),
		command: [BUN, "test", "--only-failures"],
	},
	{
		name: "api",
		cwd: join(ROOT, "services", "api"),
		command: [BUN, "test", "--only-failures"],
	},
	{
		name: "web",
		cwd: join(ROOT, "apps", "web"),
		command: [BUN, "run", "test", "--", "--reporter=minimal"],
	},
] as const satisfies readonly TestSuite[];

async function runTestSuite(suite: TestSuite): Promise<TestSuiteResult> {
	const startedAt = performance.now();
	try {
		const process = Bun.spawn([...suite.command], {
			cwd: suite.cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...Bun.env, FORCE_COLOR: "0", NO_COLOR: "1" },
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

export async function runTestSuites(
	suites: readonly TestSuite[],
	onStart?: TestSuiteStartHandler,
): Promise<readonly TestSuiteResult[]> {
	const results: TestSuiteResult[] = [];
	for (const [index, suite] of suites.entries()) {
		onStart?.(suite, index, suites.length);
		results.push(await runTestSuite(suite));
	}
	return results;
}

type TestSuiteSelection =
	| { readonly kind: "selected"; readonly suites: readonly TestSuite[] }
	| { readonly kind: "error"; readonly message: string };

function selectTestSuites(suites: readonly TestSuite[], args: readonly string[]): TestSuiteSelection {
	if (args.length === 0) {
		return { kind: "selected", suites };
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
): Promise<number> {
	const selection = selectTestSuites(suites, args);
	switch (selection.kind) {
		case "error":
			write(selection.message);
			return 1;
		case "selected": {
			write(`Running ${selection.suites.length} isolated test suites...`);
			const results = await runTestSuites(selection.suites, (suite, index, total) => {
				write(`[${index + 1}/${total}] ${suite.name}`);
			});
			write(`\n${formatTestReport(results)}`);
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
