import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Every case exercises the real process/filesystem boundary: it installs a
// disposable workspace, creates two git repositories, and runs the release
// script. Windows CI can legitimately exceed Bun's 5-second per-test default.
setDefaultTimeout(30_000);

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

/**
 * A disposable monorepo shaped like the real one: an explicit workspace
 * allowlist, internal packages wired together with `workspace:*`, a committed
 * lockfile (the script verifies it with `--frozen-lockfile`), and an
 * `origin/dev` that is already merged into master.
 */
async function createFixture(): Promise<GitFixture> {
	// `realpath` is load-bearing, not tidiness. `tmpdir()` hands back a path
	// that is not the canonical one — an 8.3 short name on Windows CI
	// (`RUNNER~1` for `runneradmin`), `/var` for `/private/var` on macOS. bun
	// canonicalises it while resolving workspaces, then records each member as
	// a path relative to the non-canonical root, producing garbage like
	// `..\..\..\..\..\runneradmin\...` that it cannot symlink. Resolving the
	// path up front keeps every later path computation on one spelling.
	const root = await realpath(await mkdtemp(join(tmpdir(), "vibe-tavern-bump-version-")));
	const remote = await realpath(await mkdtemp(join(tmpdir(), "vibe-tavern-bump-version-remote-")));
	temporaryDirectories.push(root, remote);

	await mkdir(join(root, "scripts"), { recursive: true });
	await copyFile(join(import.meta.dir, "bump-version.ts"), join(root, "scripts", "bump-version.ts"));

	for (const [index, packageFile] of PACKAGE_FILES.entries()) {
		const path = join(root, packageFile);
		await mkdir(dirname(path), { recursive: true });
		const packageJson = packageFile === "package.json"
			? { name: "release-fixture", version: "1.0.0", private: true, workspaces: ["apps/*", "packages/*", "services/*"] }
			// Package 1 depends on package 2 the way the real workspaces do, so
			// the happy path actually exercises the `workspace:*` assertion.
			: {
				name: `@release-fixture/package-${index}`,
				version: "1.0.0",
				private: true,
				...(index === 1 ? { dependencies: { "@release-fixture/package-2": "workspace:*" } } : {}),
			};
		await Bun.write(path, `${JSON.stringify(packageJson, null, 2)}\n`);
	}

	// Belt and braces against the allowlist guard tripping on install output.
	// Mirrors the real repo's .gitignore.
	await Bun.write(join(root, ".gitignore"), "node_modules/\n**/node_modules/\n");

	// A full `bun install` on purpose, NOT `--lockfile-only`: on Windows the
	// lockfile that `--lockfile-only` writes is one that `--frozen-lockfile`
	// then rejects ("lockfile had changes"), so the fixture would fail the
	// script's verification for a reason that has nothing to do with the
	// behaviour under test. Only a real install produces a lockfile bun agrees
	// with on every platform.
	const install = await run(["bun", "install"], root);
	if (install.exitCode !== 0) {
		throw new Error(`fixture setup: bun install failed:\n${install.stderr}`);
	}

	await git(root, "init", "-b", "master");
	await git(root, "config", "user.name", "Release Test");
	await git(root, "config", "user.email", "release-test@example.com");
	await git(root, "add", ...PACKAGE_FILES, "scripts/bump-version.ts", ".gitignore", "bun.lock");
	await git(root, "commit", "-m", "initial");
	await git(remote, "init", "--bare");
	await git(root, "remote", "add", "origin", remote);
	await git(root, "push", "-u", "origin", "master");
	// Releases are cut from master but the script requires dev to be merged in.
	await git(root, "push", "origin", "master:dev");

	return { root, remote };
}

/** Add a commit to origin/dev that master does not have. */
async function advanceRemoteDev(root: string): Promise<void> {
	await git(root, "switch", "-c", "dev-work");
	await Bun.write(join(root, "feature.txt"), "shipped on dev\n");
	await git(root, "add", "feature.txt");
	await git(root, "commit", "-m", "feat: something released-worthy");
	await git(root, "push", "origin", "dev-work:dev");
	await git(root, "switch", "master");
}

async function runBump(root: string, args: readonly string[] = ["1.1.0"]): Promise<CommandResult> {
	return run(["bun", "scripts/bump-version.ts", ...args], root);
}

/**
 * Assert a clean run, surfacing the script's own output when it is not.
 * A bare `expect(exitCode).toBe(0)` reports "expected 0, received 1" and hides
 * which guard fired — useless when the only failing platform is a CI runner.
 */
function expectSuccess(result: CommandResult): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`bump-version exited ${result.exitCode}\n`
			+ `--- stdout ---\n${result.stdout}\n`
			+ `--- stderr ---\n${result.stderr}`,
		);
	}
}

/**
 * Skipped on Windows. Every case installs a disposable workspace, creates two
 * git repositories and shells out to `git` and `bun` — process creation is the
 * most expensive syscall there, and the release script it covers only ever runs
 * on the Linux release job. Together with cli-args.test.ts this is most of why
 * the `scripts` suite costs 28.8s on Windows against 6.7s on Linux.
 */
describe.skipIf(process.platform === "win32")("bump-version release preconditions", () => {
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
		expectSuccess(result);
		// The subject is what ci.yml matches to skip this commit, and it must
		// carry NO GitHub skip directive: those are evaluated per push event,
		// so one here would also drop the tag push and release.yml would never
		// run (regression: v1.1.0 was tagged with `[skip ci]` and never built).
		const subject = (await git(fixture.root, "log", "-1", "--format=%s")).stdout.trim();
		expect(subject).toBe("chore: bump to v1.1.0");
		for (const directive of ["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"]) {
			expect(subject).not.toContain(directive);
		}
		expect((await git(fixture.root, "cat-file", "-t", "v1.1.0")).stdout.trim()).toBe("tag");
	});

	test("bumps every workspace version without touching the lockfile", async () => {
		// Given
		const fixture = await createFixture();

		// When
		const result = await runBump(fixture.root);

		// Then
		expectSuccess(result);
		const changed = (await git(fixture.root, "show", "--name-only", "--format=", "HEAD")).stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.sort();
		expect(changed).toEqual([...PACKAGE_FILES].sort());
		for (const packageFile of PACKAGE_FILES) {
			const pkg = await Bun.file(join(fixture.root, packageFile)).json();
			expect(pkg.version).toBe("1.1.0");
		}
	});

	test("keeps internal dependencies on the workspace protocol", async () => {
		// Given
		const fixture = await createFixture();

		// When
		await runBump(fixture.root);

		// Then: the dependency range must survive the bump unversioned.
		const pkg = await Bun.file(join(fixture.root, PACKAGE_FILES[1])).json();
		expect(pkg.dependencies["@release-fixture/package-2"]).toBe("workspace:*");
	});

	test("refuses to release an internal dependency pinned by version", async () => {
		// Given
		const fixture = await createFixture();
		const pinned = join(fixture.root, PACKAGE_FILES[1]);
		const pkg = await Bun.file(pinned).json();
		pkg.dependencies["@release-fixture/package-2"] = "1.0.0";
		await Bun.write(pinned, `${JSON.stringify(pkg, null, 2)}\n`);
		await git(fixture.root, "commit", "-am", "pin internal dep");
		await git(fixture.root, "push", "origin", "master");
		const before = (await git(fixture.root, "rev-parse", "HEAD")).stdout.trim();

		// When
		const result = await runBump(fixture.root);

		// Then
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('is "1.0.0", expected "workspace:*"');
		expect((await git(fixture.root, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
	});

	test("rejects a prerelease version before changing files", async () => {
		// Given
		const fixture = await createFixture();
		const before = (await git(fixture.root, "rev-parse", "HEAD")).stdout.trim();

		// When
		const result = await runBump(fixture.root, ["1.1.0-beta.1"]);

		// Then: a prerelease would become /releases/latest and reach every user.
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('invalid release version: "1.1.0-beta.1"');
		expect((await git(fixture.root, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
	});

	test("rejects a master that is missing commits from origin/dev", async () => {
		// Given
		const fixture = await createFixture();
		await advanceRemoteDev(fixture.root);
		const before = (await git(fixture.root, "rev-parse", "HEAD")).stdout.trim();

		// When
		const result = await runBump(fixture.root);

		// Then: releasing here would ship the previous code under a new version.
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("master is missing 1 commit(s) from origin/dev");
		expect((await git(fixture.root, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
	});

	test("rejects missing required versions before inspecting the disposable repository", async () => {
		// Given
		const fixture = await createFixture();
		const before = (await git(fixture.root, "rev-parse", "HEAD")).stdout.trim();

		// When
		const result = await runBump(fixture.root, []);

		// Then
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Usage: bun run bump-version <version> [--push]");
		expect((await git(fixture.root, "rev-parse", "HEAD")).stdout.trim()).toBe(before);
	});

	test("does not provide a short push alias", async () => {
		// Given
		const fixture = await createFixture();

		// When: observed parser only excludes values starting with two dashes.
		const result = await runBump(fixture.root, ["-p"]);

		// Then
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('invalid release version: "-p"');
	});

	test("silently ignores unknown long options while accepting the first non-option positional", async () => {
		// Given
		const fixture = await createFixture();

		// When
		const result = await runBump(fixture.root, ["--not-a-real-option", "1.1.0"]);

		// Then
		expectSuccess(result);
		expect(result.stdout).toContain("Done locally.");
		expect((await git(fixture.root, "tag", "--list", "v1.1.0")).stdout.trim()).toBe("v1.1.0");
	});

	test("recognises --push after Bun's separator", async () => {
		// Given
		const fixture = await createFixture();

		// When: Bun consumes `--`, so the script receives `1.1.0 --push`.
		const result = await runBump(fixture.root, ["1.1.0", "--", "--push"]);

		// Then
		expectSuccess(result);
		expect(result.stdout).toContain("Pushing to origin...");
		expect((await git(fixture.remote, "show-ref", "--verify", "refs/tags/v1.1.0")).exitCode).toBe(0);
	});
});
