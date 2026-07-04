/**
 * scripts/bump-version.ts
 *
 * Bump the monorepo version, commit, and tag in one command.
 *
 * Usage:
 *   bun run bump-version <version> [--push]
 *
 * Examples:
 *   bun run bump-version 1.0.2          # bump, commit, tag locally
 *   bun run bump-version 1.0.2 --push   # also push branch + tag to origin
 *
 * What it does (in order):
 *   1. Validates the target version (semver shape, differs from current)
 *   2. Verifies git tree is clean and on master/main or release/*
 *   3. Rewrites `.version` + all `@vibe-tavern/*` dep entries in the 8
 *      workspace package.json files (explicit allowlist — no `find`)
 *   4. Runs `bun install` to sync `bun.lock`
 *   5. Commits with `chore: bump to vX.X.X [skip ci]`
 *   6. Creates an annotated tag `vX.X.X` (annotated, not lightweight —
 *      gives a signed/dated marker that survives `git fetch --tags`)
 *   7. With `--push`: pushes both the branch and the tag to origin
 *
 * What it does NOT touch:
 *   - `mobile/android/app/build.gradle.kts` — `versionCode`/`versionName`
 *     are injected at BUILD TIME by `release.yml` (`sed` inline) and the
 *     committed file intentionally keeps defaults (`1` / `"0.0.0"`).
 *
 * Safety: default is local-only. Use `--push` to publish. The script never
 * force-pushes anything; it creates one new commit and one new tag, both
 * fast-forwardable.
 */

import { $, file } from "bun";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// Explicit allowlist — `find . -name package.json` would catch mobile/android,
// out/, test fixtures, etc. Keep this in sync with the workspace layout.
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

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

interface ParsedSemver {
	major: number;
	minor: number;
	patch: number;
	prerelease: string | null;
}

function parseSemver(v: string): ParsedSemver | null {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/);
	if (!m) return null;
	return {
		major: parseInt(m[1], 10),
		minor: parseInt(m[2], 10),
		patch: parseInt(m[3], 10),
		prerelease: m[4] ?? null,
	};
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	// Release > prerelease (per semver spec).
	if (a.prerelease === null && b.prerelease !== null) return 1;
	if (a.prerelease !== null && b.prerelease === null) return -1;
	if (a.prerelease && b.prerelease) {
		return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
	}
	return 0;
}

interface PackageJson {
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	[key: string]: unknown;
}

async function bumpPackageFile(relPath: string, version: string): Promise<void> {
	const absPath = join(ROOT, relPath);
	const pkgFile = file(absPath);
	if (!(await pkgFile.exists())) {
		throw new Error(`Package file not found: ${relPath}`);
	}
	const pkg = (await pkgFile.json()) as PackageJson;

	pkg.version = version;

	const bumpDeps = (deps: Record<string, string> | undefined): void => {
		if (!deps) return;
		for (const key of Object.keys(deps)) {
			if (key.startsWith("@vibe-tavern/")) {
				deps[key] = version;
			}
		}
	};

	bumpDeps(pkg.dependencies);
	bumpDeps(pkg.devDependencies);
	bumpDeps(pkg.peerDependencies);

	// 2-space indent + trailing newline matches the existing file style.
	await Bun.write(absPath, JSON.stringify(pkg, null, 2) + "\n");
}

function fail(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const shouldPush = args.includes("--push");
	const targetVersion = args.find((a) => !a.startsWith("--"));

	if (!targetVersion) {
		console.error("Usage: bun run bump-version <version> [--push]");
		console.error("Example: bun run bump-version 1.0.2");
		process.exit(1);
	}

	if (!SEMVER_RE.test(targetVersion)) {
		fail(`invalid semver: "${targetVersion}". Expected X.Y.Z or X.Y.Z-prerelease`);
	}

	const target = parseSemver(targetVersion);
	if (!target) fail(`could not parse version: "${targetVersion}"`);

	// --- git preconditions ---

	const status = (await $`git status --porcelain`.cwd(ROOT).text()).trim();
	if (status) {
		fail("git tree is dirty — commit or stash first:\n" + status);
	}

	const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(ROOT).text()).trim();
	const isTrunk = branch === "master" || branch === "main";
	const isReleaseBranch = branch.startsWith("release/");
	if (!isTrunk && !isReleaseBranch) {
		fail(`must be on master/main or release/* — currently on "${branch}"`);
	}

	// --- version preconditions ---

	const rootPkg = (await file(join(ROOT, "package.json")).json()) as PackageJson;
	const currentVersion = rootPkg.version;
	if (!currentVersion) fail("root package.json has no .version field");

	const current = parseSemver(currentVersion);
	if (!current) fail(`current package.json version is not semver: "${currentVersion}"`);

	if (currentVersion === targetVersion) {
		fail(`already at v${targetVersion} — nothing to do`);
	}

	const cmp = compareSemver(target, current);
	if (cmp < 0) {
		console.error(`warning: this is a downgrade (v${currentVersion} → v${targetVersion}).`);
		console.error("         Aborting. To override, edit scripts/bump-version.ts.");
		process.exit(1);
	}

	console.log(`Bumping v${currentVersion} → v${targetVersion} on ${branch}\n`);

	// --- bump files ---

	for (const relPath of PACKAGE_FILES) {
		await bumpPackageFile(relPath, targetVersion);
		console.log(`  bumped  ${relPath}`);
	}

	// --- sync lockfile ---

	console.log("\nSyncing bun.lock...");
	await $`bun install`.cwd(ROOT);
	console.log("  synced  bun.lock");

	// --- commit ---

	const commitMsg = `chore: bump to v${targetVersion} [skip ci]`;
	const commitPaths = [...PACKAGE_FILES, "bun.lock"];
	await $`git add ${commitPaths}`.cwd(ROOT);
	await $`git commit -m ${commitMsg}`.cwd(ROOT);
	const newSha = (await $`git rev-parse HEAD`.cwd(ROOT).text()).trim();
	console.log(`\n  committed  ${newSha.slice(0, 8)}  ${commitMsg}`);

	// --- annotated tag ---

	const tagName = `v${targetVersion}`;
	await $`git tag -a ${tagName} -m ${tagName}`.cwd(ROOT);
	console.log(`  tagged     ${tagName} (annotated)`);

	// --- push (opt-in) ---

	if (shouldPush) {
		console.log("\nPushing to origin...");
		await $`git push origin ${branch}`.cwd(ROOT);
		await $`git push origin ${tagName}`.cwd(ROOT);
		console.log(`\nDone. ${tagName} pushed — release workflow will trigger.`);
	} else {
		console.log(`\nDone locally. To publish:`);
		console.log(`  git push origin ${branch} && git push origin ${tagName}`);
		console.log(`\nOr re-run with --push to do it automatically next time.`);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
