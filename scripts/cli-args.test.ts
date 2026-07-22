import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface ScriptFixture {
	readonly root: string;
	readonly script: string;
}

const repoRoot = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(root);
	return root;
}

async function run(command: readonly string[], cwd: string): Promise<CommandResult> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function runScript(relativePath: string, args: readonly string[], cwd: string): Promise<CommandResult> {
	return run(["bun", join(repoRoot, relativePath), ...args], cwd);
}

async function copyScript(relativePath: string): Promise<ScriptFixture> {
	const root = await tempRoot("vibe-tavern-cli-");
	const script = join(root, relativePath);
	await mkdir(dirname(script), { recursive: true });
	await copyFile(join(repoRoot, relativePath), script);
	return { root, script };
}

function createRepairDb(dbPath: string): void {
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE message_variants (id TEXT PRIMARY KEY, content TEXT, reasoning TEXT, message_id TEXT, is_selected INTEGER);
		CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, updated_at TEXT);
	`);
	db.close();
}

test("build defaults to api-stack and treats every first argument as its target", async () => {
	// Given
	const fixture = await copyScript("scripts/build.ts");

	// When
	const [defaultResult, positionalResult, unknownResult] = await Promise.all([
		run(["bun", fixture.script], fixture.root),
		run(["bun", fixture.script, "--", "domain"], fixture.root),
		run(["bun", fixture.script, "--not-a-target"], fixture.root),
	]);

	// Then: the copied script confines failed Bun.build output to the temp root.
	expect(defaultResult.exitCode).toBe(1);
	expect(defaultResult.stdout).toContain("target: api-stack");
	expect(positionalResult.exitCode).toBe(1);
	expect(positionalResult.stdout).toContain("target: domain");
	expect(unknownResult.exitCode).toBe(1);
	expect(unknownResult.stderr).toContain("Unknown target: --not-a-target");
});

test("db-verify requires its positional mode and operands, while ignoring surplus operands", async () => {
	// Given
	const root = await tempRoot("vibe-tavern-db-verify-");
	const dbPath = join(root, "fixture.db");
	const db = new Database(dbPath);
	db.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO widgets (name) VALUES ('pinned');");
	db.close();

	// When
	const [missingResult, unknownModeResult, dumpResult] = await Promise.all([
		runScript("scripts/db-verify.ts", [], root),
		runScript("scripts/db-verify.ts", ["--not-a-mode"], root),
		runScript("scripts/db-verify.ts", ["--", "dump", dbPath, "--ignored"], root),
	]);

	// Then
	expect(missingResult.exitCode).toBe(64);
	expect(missingResult.stderr).toContain("Usage:");
	expect(unknownModeResult.exitCode).toBe(64);
	expect(unknownModeResult.stderr).toContain("Usage:");
	expect(dumpResult.exitCode).toBe(0);
	expect(dumpResult.stdout).toContain('"widgets"');
	expect(dumpResult.stderr).toContain("snapshotted 1 tables, 1 rows");
});

test("type-gate enforces by default and rejects unknown arguments with exit 2", async () => {
	// Given
	const root = await tempRoot("vibe-tavern-type-gate-");

	// When
	const [defaultResult, unknownResult, separatedUnknownResult] = await Promise.all([
		runScript("scripts/type-gate.ts", [], root),
		runScript("scripts/type-gate.ts", ["--not-a-real-flag"], root),
		runScript("scripts/type-gate.ts", ["--", "--not-a-real-flag"], root),
	]);

	// Then: Bun strips the separator before the script receives its arguments.
	expect(defaultResult.exitCode).toBe(0);
	expect(defaultResult.stdout).toContain("type-gate: clean");
	expect(unknownResult.exitCode).toBe(2);
	expect(unknownResult.stderr).toContain("unknown argument(s): --not-a-real-flag");
	expect(separatedUnknownResult.exitCode).toBe(2);
	expect(separatedUnknownResult.stderr).toContain("unknown argument(s): --not-a-real-flag");
});

test("generate-embedded-web-manifest defaults to generation and silently ignores unknown options", async () => {
	// Given
	const fixture = await copyScript("scripts/generate-embedded-web-manifest.ts");
	await mkdir(join(fixture.root, "out", "apps", "web", "assets"), { recursive: true });
	await mkdir(join(fixture.root, "services", "api", "src", "server"), { recursive: true });
	await Bun.write(join(fixture.root, "out", "apps", "web", "index.html"), "<main>fixture</main>");
	await Bun.write(join(fixture.root, "out", "apps", "web", "assets", "app.js"), "export {};");
	const manifest = join(fixture.root, "services", "api", "src", "server", "embedded-web-manifest.ts");

	// When
	const defaultResult = await run(["bun", fixture.script], fixture.root);
	const unknownResult = await run(["bun", fixture.script, "--unknown"], fixture.root);
	const stubResult = await run(["bun", fixture.script, "--", "--stub"], fixture.root);

	// Then: observed parser uses includes("--stub") and has no unknown-option validation.
	expect(defaultResult.exitCode).toBe(0);
	expect(defaultResult.stdout).toContain("Embedded 2 file(s)");
	expect(unknownResult.exitCode).toBe(0);
	expect(stubResult.exitCode).toBe(0);
	expect(stubResult.stdout).toContain("Restored embedded-web-manifest.ts stub.");
	expect(await Bun.file(manifest).text()).toContain("embeddedWebFiles: Record<string, string> = {}");
});

test("migrate-to-readable-folders uses temp-CWD default data and ignores unknown flags", async () => {
	// Given
	const root = await tempRoot("vibe-tavern-readable-folders-");
	const customDb = join(root, "custom.db");

	// When
	const [defaultResult, dryRunResult] = await Promise.all([
		runScript("scripts/migrate-to-readable-folders.ts", [], root),
		runScript("scripts/migrate-to-readable-folders.ts", ["--dry-run", "--", "--no-archive", "--ignored", customDb], root),
	]);

	// Then
	expect(defaultResult.exitCode).toBe(0);
	expect(defaultResult.stdout).toContain("=== Readable-folder migration ===");
	expect(defaultResult.stdout).toContain(resolve(root, "data", "vibe-tavern.db"));
	expect(dryRunResult.exitCode).toBe(0);
	expect(dryRunResult.stdout).toContain("[DRY RUN]");
	expect(dryRunResult.stdout).toContain(`DB:      ${resolve(customDb)}`);
	expect(dryRunResult.stdout).toContain("Archive: disabled");
});

test("migrate-cards-to-vtf defaults to the CWD data database and ignores unknown flags", async () => {
	// Given
	const root = await tempRoot("vibe-tavern-vtf-");
	const customDb = join(root, "custom.db");

	// When
	const [defaultResult, dryRunResult] = await Promise.all([
		runScript("scripts/migrate-cards-to-vtf.ts", [], root),
		runScript("scripts/migrate-cards-to-vtf.ts", ["--dry-run", "--", "--ignored", customDb], root),
	]);

	// Then
	expect(defaultResult.exitCode).toBe(0);
	expect(defaultResult.stdout).toContain("=== VTF migration ===");
	expect(defaultResult.stdout).toContain(resolve(root, "data", "vibe-tavern.db"));
	expect(dryRunResult.exitCode).toBe(0);
	expect(dryRunResult.stdout).toContain("=== VTF migration [DRY RUN] (no writes) ===");
	expect(dryRunResult.stdout).toContain(`DB:      ${resolve(customDb)}`);
});

test("repair-thinking-tags uses argv[2] directly, including option-looking paths", async () => {
	// Given
	const root = await tempRoot("vibe-tavern-repair-");
	const defaultDb = join(root, "data", "vibe-tavern.db");
	await mkdir(dirname(defaultDb), { recursive: true });
	createRepairDb(defaultDb);

	// When
	const [defaultResult, optionResult] = await Promise.all([
		runScript("scripts/repair-thinking-tags.ts", [], root),
		runScript("scripts/repair-thinking-tags.ts", ["--", "--not-an-option"], root),
	]);

	// Then
	expect(defaultResult.exitCode).toBe(0);
	expect(defaultResult.stdout).toContain("Phase 1: Found 0 variants");
	expect(optionResult.exitCode).not.toBe(0);
	expect(await Bun.file(join(root, "--not-an-option")).exists()).toBe(true);
});

test("serve-static captures default and positional port values without binding a port", async () => {
	// Given
	const root = await tempRoot("vibe-tavern-serve-static-");
	const wrapper = join(root, "capture-serve.ts");
	await Bun.write(wrapper, `
Object.defineProperty(Bun, "serve", {
	value(options: { readonly port: number }) {
		console.log(\`captured-port=\${options.port}\`);
	},
});
await import(${JSON.stringify(join(repoRoot, "scripts", "serve-static.ts"))});
`);

	// When
	const [defaultResult, positionalResult] = await Promise.all([
		run(["bun", wrapper], root),
		run(["bun", wrapper, "--", "public", "--not-a-number"], root),
	]);

	// Then
	expect(defaultResult.exitCode).toBe(0);
	expect(defaultResult.stdout).toContain("captured-port=3000");
	expect(defaultResult.stdout).toContain("Serving dist");
	expect(positionalResult.exitCode).toBe(0);
	expect(positionalResult.stdout).toContain("captured-port=NaN");
	expect(positionalResult.stdout).toContain("Serving public on http://0.0.0.0:NaN");
});

test("generate-small-mock defaults to its Windows-shaped relative output and accepts a first positional", async () => {
	// Given
	const root = await tempRoot("vibe-tavern-small-mock-");
	const custom = "--custom-mock";

	// When
	const [defaultResult, positionalResult] = await Promise.all([
		runScript("scripts/bench/generate-small-mock.ts", [], root),
		runScript("scripts/bench/generate-small-mock.ts", ["--", custom], root),
	]);

	// Then
	expect(defaultResult.exitCode).toBe(0);
	expect(defaultResult.stdout).toContain("Small mock generated at N:/mock-small");
	expect(await Bun.file(join(root, "N:", "mock-small", "characters", "Mock1.json")).exists()).toBe(true);
	expect(positionalResult.exitCode).toBe(0);
	expect(positionalResult.stdout).toContain(`Small mock generated at ${custom}`);
	expect(await Bun.file(join(root, custom, "settings.json")).exists()).toBe(true);
});
