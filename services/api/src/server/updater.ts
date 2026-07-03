/**
 * Self-updater for compiled standalone distributions of Vibe Tavern.
 *
 * Three public entrypoints, dispatched by standalone-server.ts:
 *   - printVersion()        — `vibe-tavern --version` / `-v`
 *   - runCheckUpdate()      — `vibe-tavern check-update`
 *   - runUpdate()           — `vibe-tavern update`
 *
 * The launcher scripts (`scripts/dist-{linux,windows}/Vibe_Tavern.{sh,bat}`)
 * are now thin wrappers that invoke `vibe-tavern update` then `exec vibe-tavern`.
 *
 * Atomic swap strategy (works on Linux AND Windows, including the running
 * binary itself):
 *   1. Extract new release to a temp staging dir
 *   2. For each top-level entry in staging:
 *      a. Rename current entry → installDir/.old/<name>
 *         (Windows permits renaming the running .exe; only deletion is blocked)
 *      b. Rename staging/<name> → installDir/<name>
 *   3. .old/ is cleaned up best-effort on the next launch
 *
 * On any failure mid-swap, completed renames are rolled back from .old/.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

declare const VIBE_TAVERN_VERSION: string | undefined;

const CURRENT_VERSION: string =
	typeof VIBE_TAVERN_VERSION !== "undefined" ? VIBE_TAVERN_VERSION : "dev";

const IS_COMPILED = typeof VIBE_TAVERN_VERSION !== "undefined";
const IS_WINDOWS = process.platform === "win32";

const REPO_OWNER = "Noineri";
const REPO_NAME = "vibe_tavern";
const REPO_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const REPO_HTML_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

const ARCHIVE_SUFFIX = IS_WINDOWS ? "-windows.zip" : "-linux.tar.gz";
const SUMS_ASSET_NAME = "SHA256SUMS.txt";

/** Names that must never be touched during a swap. */
const PROTECTED_NAMES = new Set([".old", ".next", "data", "logs"]);

// ─── Types ──────────────────────────────────────────────────────────────────

interface GithubAsset {
	readonly name: string;
	readonly browser_download_url: string;
}

interface ParsedRelease {
	readonly tag: string;
	readonly version: string;
	readonly releaseNotes: string;
	readonly archiveAsset: GithubAsset;
	readonly sumsAsset: GithubAsset;
}

export interface UpdateCheckResult {
	readonly currentVersion: string;
	readonly latestVersion: string;
	readonly latestTag: string;
	readonly releaseNotes: string;
	readonly updateAvailable: boolean;
}

export interface UpdateOptions {
	/** Skip the Y/n prompt and proceed automatically when an update exists. */
	readonly yes?: boolean;
}

export interface UpdateResult {
	readonly outcome: "up-to-date" | "updated" | "declined" | "no-new-version";
	readonly newVersion?: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function getCurrentVersion(): string {
	return CURRENT_VERSION;
}

/**
 * Query GitHub for the latest release. Returns null if the network/API call
 * fails — the launcher treats this as non-fatal and proceeds to start the
 * server with the current version.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
	let response: Response;
	try {
		response = await fetch(REPO_API_URL, {
			headers: { "User-Agent": "vibe-tavern-updater", Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;

	const parsed = parseRelease(await response.json());
	if (!parsed) return null;

	const updateAvailable = compareVersions(CURRENT_VERSION, parsed.version) < 0;
	return {
		currentVersion: CURRENT_VERSION,
		latestVersion: parsed.version,
		latestTag: parsed.tag,
		releaseNotes: parsed.releaseNotes,
		updateAvailable,
	};
}

/** Print the current version. Compiles to `0.0.0-dev`-style fallback in dev. */
export function printVersion(): void {
	console.log(CURRENT_VERSION);
}

/**
 * Check for updates and print a human-readable status. Exits the process.
 * Exit code 0 in all cases (up-to-date, update-available, check-failed).
 */
export async function runCheckUpdate(): Promise<never> {
	console.log("Checking for updates...");
	const result = await checkForUpdate();
	if (!result) {
		console.log("Could not check for updates (offline or GitHub API unavailable).");
		console.log(`  ${REPO_HTML_URL}`);
		process.exit(0);
	}
	if (!result.updateAvailable) {
		console.log(`✓ Vibe Tavern v${result.currentVersion} is up to date.`);
		process.exit(0);
	}
	console.log("");
	console.log("↑ Update available");
	console.log(`  Current:   v${result.currentVersion}`);
	console.log(`  Latest:    v${result.latestVersion}`);
	console.log(`  Release:   ${REPO_HTML_URL}`);
	process.exit(0);
}

/**
 * Check, prompt, download, verify, extract, and swap. Exits the process.
 *
 * Outcome handling (exit codes):
 *   - up-to-date / declined / no-new-version / updated → 0 (never block startup)
 *   - swap failure (corrupt state) → non-zero (caller decides whether to retry)
 *
 * Download/verify/extract failures are reported but exit 0 so the launcher
 * proceeds to start the server with the current version.
 */
export async function runUpdate(options: UpdateOptions = {}): Promise<never> {
	if (!IS_COMPILED) {
		console.error("update: only available in compiled distributions (got 'dev' build).");
		process.exit(0);
	}

	const installDir = resolveInstallDir();
	if (!installDir) {
		console.error("update: could not resolve install directory.");
		process.exit(0);
	}

	// Best-effort cleanup of a previous interrupted update's leftover .old/.
	await cleanupOldInstall(installDir);

	console.log("Checking for updates...");
	const check = await checkForUpdate();
	if (!check) {
		console.log("Could not check for updates (offline or GitHub API unavailable).");
		console.log(`  ${REPO_HTML_URL}`);
		process.exit(0);
	}

	if (!check.updateAvailable) {
		console.log(`✓ Vibe Tavern v${check.currentVersion} is up to date.`);
		process.exit(0);
	}

	console.log("");
	console.log("↑ Update available");
	console.log(`  Current:   v${check.currentVersion}`);
	console.log(`  Latest:    v${check.latestVersion}`);
	console.log(`  Release:   ${REPO_HTML_URL}`);
	console.log("");

	if (!options.yes) {
		const answer = await promptUser("Download and install? [Y/n]: ");
		if (answer.toLowerCase() !== "y" && answer !== "") {
			console.log("Skipping update.");
			process.exit(0);
		}
	}

	const release = await fetchReleaseAssets(check.latestTag);
	if (!release) {
		console.error("Could not fetch release asset list. Aborting update.");
		process.exit(0);
	}

	try {
		const newVersion = await downloadAndSwap(release, installDir);
		console.log(`✓ Updated to v${newVersion}.`);
		console.log("Restarting via launcher...");
		process.exit(0);
	} catch (err) {
		if (err instanceof SoftUpdateError) {
			console.error("Update failed:", err.message);
			console.error("Current installation was not modified.");
			process.exit(0);
		}
		console.error("Update FAILED during install swap. Installation may be corrupted.");
		console.error("Error:", err instanceof Error ? err.message : String(err));
		console.error(`Manual recovery: see ${REPO_HTML_URL} to re-download.`);
		process.exit(1);
	}
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Resolve the install directory from the compiled binary's location.
 * Returns null if running from source (dev mode) or if the path can't be
 * resolved safely.
 */
function resolveInstallDir(): string | null {
	const execPath = process.execPath;
	if (!execPath) return null;
	// In a Bun-compiled binary, process.execPath is the standalone .exe / ELF.
	// The install dir is its containing directory.
	return dirname(execPath);
}

interface GithubReleaseShape {
	readonly tag_name?: unknown;
	readonly body?: unknown;
	readonly assets?: unknown;
}

interface GithubAssetShape {
	readonly name?: unknown;
	readonly browser_download_url?: unknown;
}

/** Narrow the untyped JSON into our domain shape, or return null on mismatch. */
function parseRelease(data: unknown): ParsedRelease | null {
	if (typeof data !== "object" || data === null) return null;
	const root = data as GithubReleaseShape;
	if (typeof root.tag_name !== "string") return null;

	const body = typeof root.body === "string" ? root.body : "";
	if (!Array.isArray(root.assets)) return null;

	const assets: GithubAsset[] = [];
	for (const raw of root.assets) {
		if (typeof raw !== "object" || raw === null) continue;
		const a = raw as GithubAssetShape;
		if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
		assets.push({ name: a.name, browser_download_url: a.browser_download_url });
	}

	const archiveAsset = assets.find((a) => a.name.endsWith(ARCHIVE_SUFFIX)) ?? null;
	const sumsAsset = assets.find((a) => a.name === SUMS_ASSET_NAME) ?? null;
	if (!archiveAsset || !sumsAsset) return null;

	const tag = root.tag_name;
	const version = tag.replace(/^v/, "");
	return { tag, version, releaseNotes: body, archiveAsset, sumsAsset };
}

/**
 * Dotted-numeric version compare. Returns negative if a < b, positive if a > b,
 * 0 if equal. Non-numeric segments are coerced to 0.
 */
function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(".").map((s) => Number.parseInt(s, 10) || 0);
	const pb = b.replace(/^v/, "").split(".").map((s) => Number.parseInt(s, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const va = pa[i] ?? 0;
		const vb = pb[i] ?? 0;
		if (va !== vb) return va - vb;
	}
	return 0;
}

async function promptUser(message: string): Promise<string> {
	process.stdout.write(message);
	return new Promise<string>((resolve) => {
		process.stdin.resume();
		process.stdin.once("data", (data: Buffer) => {
			process.stdin.pause();
			resolve(data.toString("utf8").trim());
		});
	});
}

/** Download a URL to a local file path. Throws on non-2xx or network error. */
async function downloadToPath(url: string, destPath: string): Promise<void> {
	const response = await fetch(url, {
		headers: { "User-Agent": "vibe-tavern-updater" },
		signal: AbortSignal.timeout(300_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
	}
	const buf = new Uint8Array(await response.arrayBuffer());
	await Bun.write(destPath, buf);
}

/** Verify a downloaded archive against SHA256SUMS.txt contents. */
async function verifyChecksum(archivePath: string, archiveName: string, sumsContent: string): Promise<void> {
	const expectedLine = sumsContent
	 .split("\n")
	 .map((l) => l.trim())
	 .find((l) => l.length > 0 && l.endsWith(archiveName));
	if (!expectedLine) {
		throw new Error(`No checksum entry for ${archiveName} in SHA256SUMS.txt`);
	}
	// Format: "<hexhash>  <filename>" or "<hexhash> <filename>" (one or two spaces)
	const parts = expectedLine.split(/\s+/);
	const expectedHash = parts[0]?.toLowerCase();
	if (!expectedHash || !/^[0-9a-f]{64}$/.test(expectedHash)) {
		throw new Error(`Malformed checksum line for ${archiveName}`);
	}

	const fileBytes = await Bun.file(archivePath).arrayBuffer();
	const actualHash = createHash("sha256").update(Buffer.from(fileBytes)).digest("hex").toLowerCase();
	if (actualHash !== expectedHash) {
		throw new Error(
			`Checksum mismatch for ${archiveName}\n  expected: ${expectedHash}\n  actual:   ${actualHash}`,
		);
	}
}

/**
 * Extract the release archive using the platform's native tool.
 *
 * Linux/macOS: `tar -xzf` for the .tar.gz archive.
 * Windows: PowerShell `Expand-Archive` for the .zip archive. PowerShell is
 * universally available on Windows (ships since Windows 7), whereas `tar.exe`
 * is only present on Windows 10 17063+ and is sometimes stripped from managed
 * systems — using it broke Windows installs in the wild.
 */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
	const cmd = IS_WINDOWS
		? [
				"powershell",
				"-NoProfile",
				"-Command",
				`Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
			]
		: ["tar", "-xzf", archivePath, "-C", destDir];

	const proc = Bun.spawn(cmd, {
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Extraction failed (${cmd[0]} exited with code ${exitCode}).`);
	}
}

async function pathExists(p: string): Promise<boolean> {
	return stat(p).then(() => true, () => false);
}

/**
 * Best-effort removal of `.old/` left over from a previous update.
 * On Windows, individual files inside .old/ may still be locked briefly
 * after the previous process exited; we ignore those failures and they'll
 * be retried on the next launch.
 */
async function cleanupOldInstall(installDir: string): Promise<void> {
	const oldDir = join(installDir, ".old");
	if (!(await pathExists(oldDir))) return;
	await rm(oldDir, { recursive: true, force: true }).catch(() => {
		/* Some files still locked — try again next launch. */
	});
}

interface SwapPlan {
	readonly fromStaging: string;
	readonly toInstall: string;
	readonly backupInOld: string;
}

/**
 * Move each top-level entry from `stagingDir` into `installDir`, backing up
 * the previous entry under `installDir/.old/`. Rolls back on failure.
 *
 * Protected entries (data/, logs/, .old/, .next/) are never touched.
 *
 * Renaming the currently-running binary works on both Linux (inode stays
 * alive) and Windows (MoveFile on running .exe is permitted; only DeleteFile
 * is blocked).
 */
async function performSwap(installDir: string, stagingDir: string): Promise<void> {
	const oldDir = join(installDir, ".old");

	// 1. Reset .old/ from any prior (failed) attempt.
	await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
	await mkdir(oldDir, { recursive: true });

	// 2. Plan: one SwapPlan per top-level entry in staging, excluding protected names.
	const stagingEntries = await readdir(stagingDir, { withFileTypes: true });
	const plan: SwapPlan[] = [];
	for (const entry of stagingEntries) {
		const name = entry.name;
		if (PROTECTED_NAMES.has(name)) continue;
		plan.push({
			fromStaging: join(stagingDir, name),
			toInstall: join(installDir, name),
			backupInOld: join(oldDir, name),
		});
	}

	// 3. Execute with rollback.
	const completed: SwapPlan[] = [];
	try {
		for (const swap of plan) {
			// Backup existing entry (skip if absent — new file in this release).
			try {
				await rename(swap.toInstall, swap.backupInOld);
			} catch (err) {
				if (!isNotFound(err)) throw err;
			}
			// Move new entry into place.
			await rename(swap.fromStaging, swap.toInstall);
			completed.push(swap);
		}
	} catch (err) {
		// Rollback all completed swaps in reverse order.
		console.error("Swap failed mid-flight, rolling back...");
		for (const done of [...completed].reverse()) {
			try {
				await rm(done.toInstall, { recursive: true, force: true });
				await rename(done.backupInOld, done.toInstall);
			} catch (rollbackErr) {
				console.error(
					"Rollback failed for",
					basename(done.toInstall),
					":",
					rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
				);
			}
		}
		throw err;
	}
}

function isNotFound(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { code?: unknown }).code;
	return code === "ENOENT";
}

/**
 * Full pipeline: download archive + sums, verify, extract, swap into install
 * dir. Returns the new version on success.
 *
 * Staging lives inside `installDir/.next/` — NOT in os.tmpdir() — because
 * the atomic swap relies on intra-filesystem `rename()`. Cross-device
 * renames fail with EXDEV on Linux (separate /tmp partition) and with
 * ERROR_NOT_SAME_VOLUME on Windows. Keeping staging on the same filesystem
 * as the install dir is the load-bearing constraint.
 *
 * Throws on download/verify/extract/swap failures — the caller (runUpdate)
 * catches these and exits 0 so the launcher proceeds with the current build,
 * UNLESS the swap itself failed (which surfaces a corrupted-state error and
 * exits non-zero).
 */
async function downloadAndSwap(release: ParsedRelease, installDir: string): Promise<string> {
	const stagingDir = join(installDir, ".next");
	const archivePath = join(stagingDir, `archive${ARCHIVE_SUFFIX}`);
	const sumsPath = join(stagingDir, SUMS_ASSET_NAME);
	const extractDir = join(stagingDir, "extract");

	// Reset any stale staging from an interrupted previous attempt.
	await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
	await mkdir(stagingDir, { recursive: true });

	let swapStarted = false;

	try {
		console.log("· Downloading release archive...");
		await downloadToPath(release.archiveAsset.browser_download_url, archivePath);

		console.log("· Downloading checksums...");
		await downloadToPath(release.sumsAsset.browser_download_url, sumsPath);
		const sumsContent = await Bun.file(sumsPath).text();

		console.log("· Verifying checksum...");
		const archiveName = basename(release.archiveAsset.browser_download_url);
		await verifyChecksum(archivePath, archiveName, sumsContent);

		console.log("· Extracting...");
		await mkdir(extractDir, { recursive: true });
		await extractArchive(archivePath, extractDir);

		console.log("· Installing...");
		swapStarted = true;
		await performSwap(installDir, extractDir);

		return release.version;
	} catch (err) {
		if (swapStarted) {
			// Swap failure is fatal — install may be in a mixed old/new state.
			throw err;
		}
		// Pre-swap failures (download/verify/extract) are non-fatal — the
		// install is untouched. Re-throw as a soft error for the caller to
		// catch and exit 0.
		throw new SoftUpdateError(err);
	} finally {
		await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Marks a failure that happened before the install was modified. */
class SoftUpdateError extends Error {
	constructor(cause: unknown) {
		const msg = cause instanceof Error ? cause.message : String(cause);
		super(msg);
		this.name = "SoftUpdateError";
		this.cause = cause;
	}
}

/**
 * Re-fetch the release for asset URLs. Used inside downloadAndSwap because
 * UpdateCheckResult (returned by checkForUpdate) intentionally hides asset
 * URLs to keep its public shape stable.
 */
async function fetchReleaseAssets(tag: string): Promise<ParsedRelease | null> {
	// Hit the tag-specific endpoint for stability (the /releases/latest route
	// could in theory return a different release if a newer one ships between
	// the initial check and this call).
	const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${encodeURIComponent(tag)}`;
	const response = await fetch(url, {
		headers: { "User-Agent": "vibe-tavern-updater", Accept: "application/vnd.github+json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) return null;
	return parseRelease(await response.json());
}
