import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE_FILES = [
	"package.json",
	"apps/web/package.json",
	"packages/api-contracts/package.json",
	"packages/db/package.json",
	"packages/domain/package.json",
	"packages/import-export/package.json",
	"packages/prompt-pipeline/package.json",
	"services/api/package.json",
] as const;

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface GitFixture {
	readonly root: string;
	readonly remote: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(command: readonly string[], cwd: string): Promise<CommandResult> {
	const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
	const result = await run(["git", ...args], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return result;
}

async function createFixture(): Promise<GitFixture> {
	const root = await mkdtemp(join(tmpdir(), "vibe-tavern-bump-version-"));
	const remote = await mkdtemp(join(tmpdir(), "vibe-tavern-bump-version-remote-"));
	temporaryDirectories.push(root, remote);

	await mkdir(join(root, "scripts"), { recursive: true });
	await copyFile(join(import.meta.dir, "bump-version.ts"), join(root, "scripts", "bump-version.ts"));

	for (const [index, packageFile] of PACKAGE_FILES.entries()) {
		const path = join(root, packageFile);
		await mkdir(dirname(path), { recursive: true });
		const packageJson = packageFile === "package.json"
			? { name: "release-fixture", version: "1.0.0", private: true, workspaces: ["apps/*", "packages/*", "services/*"] }
			: { name: `@release-fixture/package-${index}`, version: "1.0.0", private: true };
		await Bun.write(path, `${JSON.stringify(packageJson, null, 2)}\n`);
	}

	await git(root, "init", "-b", "master");
	await git(root, "config", "user.name", "Release Test");
	await git(root, "config", "user.email", "release-test@example.com");
	await git(root, "add", ...PACKAGE_FILES, "scripts/bump-version.ts");
	await git(root, "commit", "-m", "initial");
	await git(remote, "init", "--bare");
	await git(root, "remote", "add", "origin", remote);
	await git(root, "push", "-u", "origin", "master");

	return { root, remote };
}

async function runBump(root: string): Promise<CommandResult> {
	return run(["bun", "scripts/bump-version.ts", "1.1.0"], root);
}

describe("bump-version release preconditions", () => {
	test("rejects release branches before changing files", async () => {
		// Given
		const fixture = await createFixture();
		await git(fixture.root, "switch", "-c", "release/hotfix");
		const before = (await git(fixture.root, "rev-parse", "HEAD")).stdout.trim();

		// When
		const result = await runBump(fixture.root);

		// Then
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('must be on master — currently on "release/hotfix"');
		expect((await git(fixture.root, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
	});

	test("rejects a local master that is ahead of origin", async () => {
		// Given
		const fixture = await createFixture();
		await Bun.write(join(fixture.root, "local-only.txt"), "not pushed\n");
		await git(fixture.root, "add", "local-only.txt");
		await git(fixture.root, "commit", "-m", "local only");
		const before = (await git(fixture.root, "rev-parse", "HEAD")).stdout.trim();

		// When
		const result = await runBump(fixture.root);

		// Then
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("local master must exactly match origin/master");
		expect((await git(fixture.root, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
	});

	test("rejects a tag that already exists on origin before committing", async () => {
		// Given
		const fixture = await createFixture();
		await git(fixture.root, "tag", "v1.1.0");
		await git(fixture.root, "push", "origin", "v1.1.0");
		await git(fixture.root, "tag", "-d", "v1.1.0");
		const before = (await git(fixture.root, "rev-parse", "HEAD")).stdout.trim();

		// When
		const result = await runBump(fixture.root);

		// Then
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("tag v1.1.0 already exists on origin");
		expect((await git(fixture.root, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
	});

	test("creates a workflow-eligible version commit and annotated tag", async () => {
		// Given
		const fixture = await createFixture();

		// When
		const result = await runBump(fixture.root);

		// Then
		expect(result.exitCode).toBe(0);
		expect((await git(fixture.root, "log", "-1", "--format=%s")).stdout.trim()).toBe("chore: bump to v1.1.0");
		expect((await git(fixture.root, "cat-file", "-t", "v1.1.0")).stdout.trim()).toBe("tag");
	});
});
