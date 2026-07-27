import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const source = join(repoRoot, "services", "api", "src", "server", "standalone-server.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(command: readonly string[], cwd: string): Promise<CommandResult> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function createFixture(): Promise<{ readonly root: string; readonly script: string }> {
	const root = await mkdtemp(join(tmpdir(), "vibe-tavern-standalone-cli-"));
	temporaryDirectories.push(root);
	const serverDir = join(root, "server");
	const script = join(serverDir, "standalone-server.ts");
	await mkdir(serverDir, { recursive: true });
	await copyFile(source, script);
	await Bun.write(join(serverDir, "standalone-paths.ts"), `
export async function resolveStandalonePaths() {
	console.log("stub:resolve-paths");
	return { dataDir: "data", assetsDir: "assets", webDir: "web", webEnabled: false, port: 9999, logsDir: "logs", traceDir: "traces" };
}
`);
	await Bun.write(join(serverDir, "server-runtime.ts"), `
export async function startServerRuntime(config: { readonly mode: string; readonly host: string; readonly port: number }) {
	console.log(\`stub:runtime \${config.mode} \${config.host}:\${config.port}\`);
}
`);
	await Bun.write(join(serverDir, "embedded-web-manifest.ts"), "export const embeddedWebFiles: Record<string, string> = {};\n");
	await Bun.write(join(serverDir, "updater.ts"), `
export function getCurrentVersion(): string { return "fixture-version"; }
export function printVersion(): void { console.log("stub:version"); }
export async function runCheckUpdate(): Promise<void> { console.log("stub:check-update"); }
export async function runUpdate(options: { readonly yes: boolean }): Promise<void> { console.log(\`stub:update yes=\${options.yes}\`); }
`);
	return { root, script };
}

test("version flags exit before path resolution or runtime creation", async () => {
	// Given
	const fixture = await createFixture();

	// When
	const [longResult, aliasResult, separatedResult] = await Promise.all([
		run(["bun", fixture.script, "--version"], fixture.root),
		run(["bun", fixture.script, "-v"], fixture.root),
		run(["bun", fixture.script, "--", "--version"], fixture.root),
	]);

	// Then
	for (const result of [longResult, aliasResult, separatedResult]) {
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stub:version");
		expect(result.stdout).not.toContain("stub:resolve-paths");
		expect(result.stdout).not.toContain("stub:runtime");
		expect(result.stderr).toBe("");
	}
});

test("version takes precedence over a subcommand", async () => {
	// Given
	const fixture = await createFixture();

	// When
	const result = await run(["bun", fixture.script, "check-update", "--version"], fixture.root);

	// Then
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("stub:version");
	expect(result.stdout).not.toContain("stub:check-update");
	expect(result.stdout).not.toContain("stub:runtime");
});

test("check-update and update consume only their documented subcommand arguments", async () => {
	// Given
	const fixture = await createFixture();

	// When
	const [checkResult, longYesResult, aliasYesResult, unknownResult] = await Promise.all([
		run(["bun", fixture.script, "check-update", "--ignored"], fixture.root),
		run(["bun", fixture.script, "update", "--yes"], fixture.root),
		run(["bun", fixture.script, "update", "-y"], fixture.root),
		run(["bun", fixture.script, "update", "--ignored"], fixture.root),
	]);

	// Then
	expect(checkResult.stdout).toContain("stub:check-update");
	expect(checkResult.stdout).not.toContain("stub:runtime");
	expect(longYesResult.stdout).toContain("stub:update yes=true");
	expect(aliasYesResult.stdout).toContain("stub:update yes=true");
	expect(unknownResult.stdout).toContain("stub:update yes=false");
});

test("default, help, and unknown arguments all start the standalone runtime", async () => {
	// Given
	const fixture = await createFixture();

	// When
	const [defaultResult, helpResult, unknownResult] = await Promise.all([
		run(["bun", fixture.script], fixture.root),
		run(["bun", fixture.script, "--help"], fixture.root),
		run(["bun", fixture.script, "not-a-subcommand"], fixture.root),
	]);

	// Then: observed behavior differs from conventional CLIs; these are not early exits.
	for (const result of [defaultResult, helpResult, unknownResult]) {
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stub:resolve-paths");
		expect(result.stdout).toContain("stub:runtime standalone 0.0.0.0:9999");
	}
});
