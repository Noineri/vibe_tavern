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
 *   1. Validates the target version (strict X.Y.Z, differs from current)
 *   2. Verifies git tree is clean, on master, exactly matches origin/master,
 *      and that origin/dev has actually been merged in
 *   3. Verifies the target tag does not already exist locally or on origin
 *   4. Rewrites `.version` in the 8 workspace package.json files
 *      (explicit allowlist — no `find`)
 *   5. Verifies `bun.lock` still satisfies the bumped manifests, and that the
 *      bump touched nothing outside the allowlist
 *   6. Commits with `chore: bump to vX.X.X [skip ci]`
 *   7. Creates an annotated tag `vX.X.X` (annotated, not lightweight —
 *      gives a signed/dated marker that survives `git fetch --tags`)
 *   8. With `--push`: pushes master and the tag to origin atomically
 *
 * Why no prereleases: the in-app updater (services/api/src/server/updater.ts)
 * polls /releases/latest and the Docker `latest` tag tracks the newest
 * release, so a `1.1.0-beta.1` tag would ship itself to every installed user.
 * `release.yml` rejects non-X.Y.Z tags too, in case one is pushed by hand.
 *
 * Why `[skip ci]`: ci.yml already verified the parent commit. The bump commit
 * only changes version strings, and release.yml re-runs the full gate
 * (typecheck + tests on Linux AND Windows) on the tagged commit before any
 * artifact is built — so letting ci.yml race the release run only duplicates
 * the same work.
 *
 * Why internal deps are not rewritten: workspace packages depend on each other
 * through `workspace:*`, which carries no version number. Nothing to sync.
 *
 * What it does NOT touch:
 *   - `bun.lock` — bun does not record a workspace's own version in a way
 *     that a version bump invalidates; the lockfile is verified, not rewritten.
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
import { parseArgs } from "node:util";

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

// Strict X.Y.Z — no prerelease suffix. See the header for why.
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

interface ParsedSemver {
	major: number;
	minor: number;
	patch: number;
}

function parseSemver(v: string): ParsedSemver | null {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return null;
	return {
		major: parseInt(m[1], 10),
		minor: parseInt(m[2], 10),
		patch: parseInt(m[3], 10),
	};
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

interface PackageJson {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	[key: string]: unknown;
}

interface LoadedManifest {
	readonly relPath: string;
	readonly absPath: string;
	readonly pkg: PackageJson;
}

/** Read every allowlisted manifest up front so nothing is written until all of them validate. */
async function loadManifests(): Promise<LoadedManifest[]> {
	const loaded: LoadedManifest[] = [];
	for (const relPath of PACKAGE_FILES) {
		const absPath = join(ROOT, relPath);
		const pkgFile = file(absPath);
		if (!(await pkgFile.exists())) {
			fail(`package file not found: ${relPath} — the allowlist is out of sync with the workspace layout`);
		}
		loaded.push({ relPath, absPath, pkg: (await pkgFile.json()) as PackageJson });
	}
	return loaded;
}

/**
 * Internal packages must reference each other through `workspace:*`, never a
 * version number. A numeric range only resolves to the local package while
 * every manifest agrees; the moment one drifts, bun stops resolving locally
 * and reaches for the public npm registry — where these names do not exist.
 * Fail the release rather than let that reach a build.
 *
 * The set of internal names comes from the manifests themselves rather than a
 * hardcoded scope, so renaming or adding a scope cannot silently disable this.
 */
function assertWorkspaceDeps(manifests: readonly LoadedManifest[]): void {
	const internalNames = new Set(
		manifests.flatMap(({ pkg }) => (pkg.name === undefined ? [] : [pkg.name])),
	);

	for (const { relPath, pkg } of manifests) {
		const groups: readonly (readonly [string, Record<string, string> | undefined])[] = [
			["dependencies", pkg.dependencies],
			["devDependencies", pkg.devDependencies],
			["peerDependencies", pkg.peerDependencies],
		];
		for (const [groupName, deps] of groups) {
			if (!deps) continue;
			for (const [name, range] of Object.entries(deps)) {
				if (internalNames.has(name) && range !== "workspace:*") {
					fail(
						`${relPath} → ${groupName}.${name} is "${range}", expected "workspace:*".\n`
						+ "Internal packages must not be pinned by version.",
					);
				}
			}
		}
	}
}

function fail(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);
	const options = {
		push: { type: "boolean" },
	} as const;
	const initial = parseArgs({
		args: rawArgs,
		options,
		strict: false,
		allowPositionals: true,
		tokens: true,
	});
	const args = [...new Set(initial.tokens.flatMap((token) =>
		token.kind === "option-terminator" ? [] : [token.index]
	))].flatMap((index) => {
		const arg = rawArgs[index];
		return arg === undefined ? [] : [arg];
	});
	const { values, tokens } = parseArgs({
		args,
		options,
		strict: false,
		allowPositionals: true,
		tokens: true,
	});
	const shouldPush = values.push === true;
	const targetToken = tokens.find((token) =>
		token.kind === "positional"
		|| (token.kind === "option" && token.name !== "push" && /^-[^-]/.test(token.rawName))
	);
	const targetVersion = targetToken === undefined ? undefined : args[targetToken.index];

	if (!targetVersion) {
		console.error("Usage: bun run bump-version <version> [--push]");
		console.error("Example: bun run bump-version 1.0.2");
		process.exit(1);
	}

	if (!SEMVER_RE.test(targetVersion)) {
		fail(
			`invalid release version: "${targetVersion}". Expected X.Y.Z.\n`
			+ "Prereleases are not supported — the in-app updater and the Docker\n"
			+ "`latest` tag both track the newest release, so a prerelease would\n"
			+ "ship itself to every installed user.",
		);
	}

	const target = parseSemver(targetVersion);
	if (!target) fail(`could not parse version: "${targetVersion}"`);
	const tagName = `v${targetVersion}`;

	// --- git preconditions ---

	const status = (await $`git status --porcelain`.cwd(ROOT).text()).trim();
	if (status) {
		fail("git tree is dirty — commit or stash first:\n" + status);
	}

	const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(ROOT).text()).trim();
	if (branch !== "master") {
		fail(`must be on master — currently on "${branch}"`);
	}

	const fetchResult = await $`git fetch --quiet --no-tags origin master dev`.cwd(ROOT).nothrow();
	if (fetchResult.exitCode !== 0) {
		fail("could not fetch origin master/dev — verify the origin remote and network connection");
	}

	const localSha = (await $`git rev-parse HEAD`.cwd(ROOT).text()).trim();
	const remoteSha = (await $`git rev-parse refs/remotes/origin/master`.cwd(ROOT).text()).trim();
	if (localSha !== remoteSha) {
		fail("local master must exactly match origin/master — push or pull master, wait for CI, then retry");
	}

	// Releases are cut from master, but development happens on dev. If the
	// merge was forgotten, master is a stale snapshot and the release would
	// ship last release's code under a new version number.
	const devMerged = await $`git merge-base --is-ancestor refs/remotes/origin/dev HEAD`.cwd(ROOT).nothrow();
	if (devMerged.exitCode !== 0) {
		const behind = (await $`git rev-list --count HEAD..refs/remotes/origin/dev`.cwd(ROOT).text()).trim();
		fail(
			`master is missing ${behind} commit(s) from origin/dev — merge dev into master first:\n`
			+ "  git merge --no-ff origin/dev",
		);
	}

	const localTag = (await $`git tag --list ${tagName}`.cwd(ROOT).text()).trim();
	if (localTag) {
		fail(`tag ${tagName} already exists locally`);
	}

	const remoteTag = (await $`git ls-remote --tags origin refs/tags/${tagName}`.cwd(ROOT).text()).trim();
	if (remoteTag) {
		fail(`tag ${tagName} already exists on origin`);
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

	// --- verify the lockfile describes the tree we are about to release ---
	//
	// Runs BEFORE the bump, against the exact committed state that CI verified,
	// so it is a pure validation with nothing in flight.
	//
	// `--frozen-lockfile --dry-run` is the whole point: it answers "does this
	// lockfile still satisfy these manifests" and writes NOTHING — no
	// node_modules, no lockfile rewrite. A plain `bun install` would be actively
	// harmful: it does not sync a workspace version bump anyway, but it IS free
	// to re-resolve every other range, silently dragging unrelated dependency
	// upgrades into the release commit. Verification must not mutate the tree it
	// is about to tag.

	console.log("Verifying bun.lock...");
	const verify = await $`bun install --frozen-lockfile --dry-run`.cwd(ROOT).nothrow().quiet();
	if (verify.exitCode !== 0) {
		fail(
			"bun.lock does not satisfy the committed manifests:\n"
			+ verify.stderr.toString().trim()
			+ "\nCommit a synchronized lockfile on master first.",
		);
	}
	console.log("  verified  bun.lock\n");

	console.log(`Bumping v${currentVersion} → v${targetVersion} on ${branch}\n`);

	// --- bump files ---

	// Load and validate every manifest BEFORE writing any of them — a failure
	// halfway through the list would otherwise leave a half-bumped tree behind.
	const manifests = await loadManifests();
	assertWorkspaceDeps(manifests);

	for (const { relPath, absPath, pkg } of manifests) {
		pkg.version = targetVersion;
		// 2-space indent + trailing newline matches the existing file style.
		await Bun.write(absPath, JSON.stringify(pkg, null, 2) + "\n");
		console.log(`  bumped  ${relPath}`);
	}

	// The bump must touch the allowlist and nothing else. This catches a stray
	// lockfile rewrite, a generated file, or an editor artifact riding along
	// into a commit that is about to become an immutable release tag.
	//
	// `-z` gives NUL-separated, unquoted, newline-agnostic records — porcelain
	// v1 quotes paths containing spaces and is line-ending sensitive, which
	// makes text parsing of it wrong on some platforms.
	const allowedPaths = new Set<string>(PACKAGE_FILES);
	const rawStatus = await $`git status --porcelain -z`.cwd(ROOT).text();
	const dirty = rawStatus
		.split("\0")
		.filter((record) => record.length > 3)
		// Each record is `XY <path>`; the two status columns are fixed-width.
		.map((record) => record.slice(3));
	const unexpected = dirty.filter((path) => !allowedPaths.has(path));
	if (unexpected.length > 0) {
		const changed = await $`git diff --stat -- ${unexpected}`.cwd(ROOT).nothrow().quiet();
		fail(
			"the bump changed files outside the allowlist:\n"
			+ unexpected.map((path) => `  ${path}`).join("\n")
			+ "\n\ngit diff --stat:\n" + changed.stdout.toString().trim()
			+ "\n\nRefusing to tag a release commit with unrelated changes.",
		);
	}

	// --- commit ---

	const commitMsg = `chore: bump to v${targetVersion} [skip ci]`;
	await $`git add ${PACKAGE_FILES}`.cwd(ROOT);
	await $`git commit -m ${commitMsg}`.cwd(ROOT);
	const newSha = (await $`git rev-parse HEAD`.cwd(ROOT).text()).trim();
	console.log(`\n  committed  ${newSha.slice(0, 8)}  ${commitMsg}`);

	// --- annotated tag ---

	await $`git tag -a ${tagName} -m ${tagName}`.cwd(ROOT);
	console.log(`  tagged     ${tagName} (annotated)`);

	// --- push (opt-in) ---

	if (shouldPush) {
		console.log("\nPushing to origin...");
		// --atomic: branch and tag land together or not at all. Two separate
		// pushes can interleave with someone else's push and leave the tag
		// pointing at a commit that is not on master.
		await $`git push --atomic origin ${branch} ${tagName}`.cwd(ROOT);
		console.log(`\nDone. ${tagName} pushed — release workflow will trigger.`);
		console.log("It builds and attaches every artifact, then leaves a DRAFT release.");
		console.log("Review the notes and press 'Publish release' to ship it to users.");
	} else {
		console.log(`\nDone locally. To publish:`);
		console.log(`  git push --atomic origin ${branch} ${tagName}`);
		console.log(`\nOr re-run with --push to do it automatically next time.`);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
