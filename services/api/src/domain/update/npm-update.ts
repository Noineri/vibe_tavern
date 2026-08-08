/**
 * Self-update for the npm channel (`bun install -g vibe-tavern`).
 *
 * The binary channels update by downloading a release archive and swapping
 * files next to the executable. None of that applies here: the install is a
 * package in the user's global bun store, and replacing it is `bun add -g`,
 * which the package manager does atomically and far better than we could.
 *
 * Two properties follow from delegating, and both are improvements over the
 * swap pipeline:
 *
 *   - Every failure is SOFT. `bun add -g` either completes and links the new
 *     version or fails and leaves the previous one installed. There is no
 *     half-swapped tree, so no fatal branch and no rollback machinery.
 *   - The bun that performs the install is `process.execPath` — the exact
 *     runtime executing this bundle. Resolving `bun` from PATH could pick a
 *     different installation than the one holding the package.
 *
 * Version discovery stays on GitHub releases (updater.ts) so every channel
 * agrees on what "latest" means. That creates one ordering hazard this module
 * has to handle: a GitHub release is visible the moment it is published, while
 * the npm publish job may still be running. Hence isVersionPublished() — an
 * update that would 404 is reported as "not on npm yet", not as a failure.
 */

import { checkForUpdate, promptUser, releasePageUrl } from "../../server/updater.js";

const NPM_PACKAGE_NAME = "vibe-tavern";
const DEFAULT_REGISTRY_BASE = "https://registry.npmjs.org";

/** How long `bun add -g` may run before it is killed. A hung package manager
 *  must not leave the UI spinning on "Installing" forever. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// TEST-ONLY OVERRIDE: point the registry probe at a local mock server.
// Mirrors VT_UPDATE_API_BASE in updater.ts, resolved per call for the same
// reason — tests set it after import.
function resolveRegistryBase(): string {
	return process.env.VT_NPM_REGISTRY_BASE ?? DEFAULT_REGISTRY_BASE;
}

export function packageSpec(version: string): string {
	return `${NPM_PACKAGE_NAME}@${version}`;
}

export type PublishLookup =
	| { readonly kind: "published" }
	| { readonly kind: "not-published" }
	| { readonly kind: "lookup-failed"; readonly detail: string };

/**
 * Is this version actually installable from npm right now?
 *
 * Deliberately three-valued. "The registry says 404" and "the registry did not
 * answer" lead to different messages: the first is a wait-a-few-minutes state
 * during a release rollout, the second is the user's network. Collapsing them
 * would tell someone offline that their release is missing.
 */
export async function isVersionPublished(version: string): Promise<PublishLookup> {
	const url = `${resolveRegistryBase()}/${NPM_PACKAGE_NAME}/${encodeURIComponent(version)}`;
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (response.ok) return { kind: "published" };
		if (response.status === 404) return { kind: "not-published" };
		return { kind: "lookup-failed", detail: `registry responded ${response.status}` };
	} catch (err) {
		return {
			kind: "lookup-failed",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

export class NpmInstallError extends Error {
	constructor(
		message: string,
		readonly output: string,
	) {
		super(message);
		this.name = "NpmInstallError";
	}
}

/**
 * Run `bun add -g vibe-tavern@<version>`.
 *
 * Output is captured rather than inherited so the failure reaches the UI —
 * a global install that fails on a permissions or disk-space problem says so
 * on stderr, and that text is the only useful diagnosis the user will get.
 */
export async function installPackageVersion(
	version: string,
	onOutput?: (line: string) => void,
): Promise<void> {
	const spec = packageSpec(version);
	const command = [process.execPath, "add", "-g", spec];
	console.log(`[npm-update] running: ${command.join(" ")}`);

	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, INSTALL_TIMEOUT_MS);

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const output = `${stdout}${stderr}`.trim();
		if (output.length > 0) onOutput?.(output);

		if (timedOut) {
			throw new NpmInstallError(
				`Installing ${spec} timed out after ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes. The previous version is still installed.`,
				output,
			);
		}
		if (exitCode !== 0) {
			throw new NpmInstallError(
				`bun add -g ${spec} exited with code ${exitCode}. The previous version is still installed.`,
				output,
			);
		}
	} finally {
		clearTimeout(timer);
	}
}

// ─── CLI entry points (`vibe-tavern check-update` / `vibe-tavern update`) ────

/** Report whether an update exists. Exit code 0 in every case — "no update"
 *  and "GitHub is unreachable" are both ordinary answers, not command errors. */
export async function runNpmCheckUpdate(): Promise<never> {
	console.log("Checking for updates...");
	const check = await checkForUpdate({ requirePlatformAsset: false });
	if (!check) {
		console.log("Could not check for updates (offline or GitHub API unavailable).");
		console.log(`  ${releasePageUrl()}`);
		process.exit(0);
	}
	if (!check.updateAvailable) {
		console.log(`✓ Vibe Tavern v${check.currentVersion} is up to date.`);
		process.exit(0);
	}

	console.log("");
	console.log("↑ Update available");
	console.log(`  Current: v${check.currentVersion}`);
	console.log(`  Latest:  v${check.latestVersion}`);
	console.log(`  Release: ${releasePageUrl()}`);

	const lookup = await isVersionPublished(check.latestVersion);
	if (lookup.kind === "not-published") {
		console.log("");
		console.log(`  Note: v${check.latestVersion} is not on npm yet — it usually appears within a few minutes.`);
	}

	console.log("");
	console.log("  Install it with: vibe-tavern update");
	process.exit(0);
}

/**
 * Update in place via the package manager.
 *
 * Exits non-zero when the install itself fails. That differs from the binary
 * channel, which exits 0 on a soft failure so its launcher can carry on
 * starting the old version — there is no launcher here, and someone running
 * `vibe-tavern update && vibe-tavern` deserves to see the failure.
 */
export async function runNpmUpdate(options: { readonly yes?: boolean }): Promise<never> {
	console.log("Checking for updates...");
	const check = await checkForUpdate({ requirePlatformAsset: false });
	if (!check) {
		console.log("Could not check for updates (offline or GitHub API unavailable).");
		console.log(`  ${releasePageUrl()}`);
		process.exit(0);
	}
	if (!check.updateAvailable) {
		console.log(`✓ Vibe Tavern v${check.currentVersion} is up to date.`);
		process.exit(0);
	}

	console.log("");
	console.log("↑ Update available");
	console.log(`  Current: v${check.currentVersion}`);
	console.log(`  Latest:  v${check.latestVersion}`);
	console.log(`  Release: ${releasePageUrl()}`);
	console.log("");

	const lookup = await isVersionPublished(check.latestVersion);
	if (lookup.kind === "not-published") {
		console.log(`v${check.latestVersion} has been released but is not on npm yet.`);
		console.log("It usually appears within a few minutes — try again shortly.");
		process.exit(0);
	}
	if (lookup.kind === "lookup-failed") {
		console.error(`Could not reach the npm registry (${lookup.detail}).`);
		process.exit(1);
	}

	if (options.yes !== true) {
		// Without a TTY nobody can answer, and stdin would never produce data —
		// the command would hang instead of doing anything.
		if (!process.stdin.isTTY) {
			console.log("Not running interactively — re-run with --yes to install without prompting.");
			process.exit(0);
		}
		const answer = await promptUser(`Install ${packageSpec(check.latestVersion)}? [Y/n]: `);
		if (answer.toLowerCase() !== "y" && answer !== "") {
			console.log("Skipping update.");
			process.exit(0);
		}
	}

	try {
		await installPackageVersion(check.latestVersion, (output) => console.log(output));
		console.log(`✓ Updated to v${check.latestVersion}. Start Vibe Tavern again to run it.`);
		process.exit(0);
	} catch (err) {
		console.error("Update failed:", err instanceof Error ? err.message : String(err));
		console.error(`Current installation was not modified. Manual command: bun add -g ${packageSpec(check.latestVersion)}`);
		process.exit(1);
	}
}
