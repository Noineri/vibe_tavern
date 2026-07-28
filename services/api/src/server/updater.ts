/**
 * Self-updater for compiled standalone distributions of Vibe Tavern.
 *
 * Three public entrypoints, dispatched by standalone-server.ts:
 *   - printVersion()        — `vibe-tavern --version` / `-v`
 *   - runCheckUpdate()      — `vibe-tavern check-update`
 *   - runUpdate()           — `vibe-tavern update`
 *
 * Archive extraction is done in-process by archive-extract.ts. Nothing in the
 * update path spawns an external tool: the updater cannot assume anything is
 * installed on the user's machine.
 *
 * Atomic swap strategy (works on Linux AND Windows, including the running
 * binary itself):
 *   1. Extract new release to a temp staging dir
 *   2. For each top-level entry in staging:
 *      a. Rename current entry → installDir/.old-<epoch>/<name>
 *         (Windows permits renaming the running .exe; only deletion is blocked)
 *      b. Rename staging/<name> → installDir/<name>
 *   3. Backup directories are swept best-effort on the next launch
 *
 * On any failure mid-swap, completed renames are rolled back from the backup
 * directory. A rollback that restores everything is reported as a SOFT failure:
 * "fatal" is reserved for an install left in a mixed old/new state.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractArchive } from "./archive-extract.js";

declare const VIBE_TAVERN_VERSION: string | undefined;

const CURRENT_VERSION: string =
	typeof VIBE_TAVERN_VERSION !== "undefined" ? VIBE_TAVERN_VERSION : "dev";

export const IS_COMPILED = typeof VIBE_TAVERN_VERSION !== "undefined";
const IS_WINDOWS = process.platform === "win32";

const REPO_OWNER = "Noineri";
const REPO_NAME = "vibe_tavern";
const DEFAULT_API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const DEFAULT_HTML_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

// TEST-ONLY OVERRIDE (do not ship with this set in production):
// VT_UPDATE_API_BASE points the updater at a mock release API (e.g. a local
// static server) so we can verify the full update flow against a build that
// contains the very code under test. VT_UPDATE_HTML_URL likewise overrides
// the "release page" URL used in error messages. Both default to GitHub.
// Resolved per call rather than captured at module load: tests need to point
// the updater at a local mock server after import, and Wave 7 gates these
// overrides on IS_COMPILED in one place.
function resolveApiBase(): string {
	return process.env.VT_UPDATE_API_BASE ?? DEFAULT_API_BASE;
}

function resolveHtmlUrl(): string {
	return process.env.VT_UPDATE_HTML_URL ?? DEFAULT_HTML_URL;
}

const ARCHIVE_SUFFIX = IS_WINDOWS ? "-windows.zip" : "-linux.tar.gz";
const SUMS_ASSET_NAME = "SHA256SUMS.txt";

/** Names that must never be touched during a swap. */
const PROTECTED_NAMES = new Set([".old", ".next", "data", "logs"]);

/**
 * Every swap attempt backs up into its OWN `.old-<epoch>/` directory.
 *
 * The previous design reused a single `.old/`, which meant a backup left
 * undeletable by an earlier update (a Windows lock on the old .exe is the
 * common case) either aborted the next update outright or, worse, let it
 * rename into a directory that was not empty. A fresh directory per attempt
 * cannot collide with anything.
 */
const OLD_BACKUP_PREFIX = ".old-";

/** True for `.old`, every `.old-<epoch>` backup, and the other reserved names. */
function isProtectedName(name: string): boolean {
	return PROTECTED_NAMES.has(name) || name.startsWith(OLD_BACKUP_PREFIX);
}

/** Allocate an unused `installDir/.old-<epoch>/` and create it. */
async function createBackupDir(installDir: string): Promise<string> {
	const stamp = Date.now();
	for (let attempt = 0; ; attempt++) {
		const name = attempt === 0
			? `${OLD_BACKUP_PREFIX}${stamp}`
			: `${OLD_BACKUP_PREFIX}${stamp}-${attempt}`;
		const candidate = join(installDir, name);
		if (await pathExists(candidate)) continue;
		await mkdir(candidate, { recursive: true });
		return candidate;
	}
}

/** Newest-first list of backup directories sitting next to the executable. */
export async function listBackupDirs(installDir: string): Promise<string[]> {
	const entries = await readdir(installDir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((e) => e.isDirectory() && e.name.startsWith(OLD_BACKUP_PREFIX))
		.map((e) => e.name)
		.sort()
		.reverse()
		.map((name) => join(installDir, name));
}

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

export type { ParsedRelease };
export type { GithubAsset };

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
		response = await fetch(`${resolveApiBase()}/releases/latest`, {
			headers: { "User-Agent": "vibe-tavern-updater", Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;

	const parsed = await parseReleaseBody(response);
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
		console.log(`  ${resolveHtmlUrl()}`);
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
	console.log(`  Release:   ${resolveHtmlUrl()}`);
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

	// Imported lazily: update-orchestrator.ts imports this module, so a static
	// import here would form a cycle and evaluate its module body (which reads
	// CURRENT_VERSION) before this module's own body has run.
	const { detectInstallKind } = await import("../domain/update/update-orchestrator.js");
	const installKind = detectInstallKind();
	if (installKind !== "standalone") {
		console.error(`update: not supported for this installation type (${installKind}).`);
		console.error(
			installKind === "inno-setup"
				? "  Re-run the Windows installer from the release page to update:"
				: "  Update the image or package you installed from:",
		);
		console.error(`  ${resolveHtmlUrl()}`);
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
		console.log(`  ${resolveHtmlUrl()}`);
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
	console.log(`  Release:   ${resolveHtmlUrl()}`);
	console.log("");

	if (!options.yes) {
		// Without a terminal there is nobody to answer the prompt, and
		// process.stdin.once("data") would simply never fire — the launcher
		// would hang forever instead of starting the server.
		if (!process.stdin.isTTY) {
			console.log("Not running interactively — re-run with --yes to install without prompting.");
			process.exit(0);
		}
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
		console.error(`Manual recovery: see ${resolveHtmlUrl()} to re-download.`);
		process.exit(1);
	}
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Resolve the install directory from the compiled binary's location.
 * Returns null if running from source (dev mode) or if the path can't be
 * resolved safely.
 */
export function resolveInstallDir(): string | null {
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
export function parseRelease(data: unknown): ParsedRelease | null {
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
export function compareVersions(a: string, b: string): number {
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

async function downloadToPath(url: string, destPath: string): Promise<void> {
	await downloadToPathWithProgress(url, destPath);
}

/**
 * Look up an archive's expected digest in SHA256SUMS.txt contents.
 *
 * The filename is matched by EXACT equality on the line's filename column, not
 * by `endsWith` on the whole line: our own release ships
 * `Vibe-Tavern-v1.0.0-windows.zip` alongside `Vibe-Tavern-v1.0.0-windows-setup.exe`,
 * and any asset whose name is a suffix of another would otherwise cross-match
 * and verify the wrong file's digest.
 *
 * Accepts the `sha256sum` output format: `<hash>  <name>` (text mode) and
 * `<hash> *<name>` (binary mode).
 */
function findExpectedHash(sumsContent: string, archiveName: string): string | null {
	for (const raw of sumsContent.split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const parts = line.split(/\s+/);
		const hash = parts[0];
		if (hash === undefined || parts.length < 2) continue;
		// Re-join so filenames containing spaces still compare correctly, and
		// drop the binary-mode marker.
		const name = parts.slice(1).join(" ").replace(/^\*/, "");
		if (name !== archiveName) continue;
		return hash.toLowerCase();
	}
	return null;
}

/** Verify a downloaded archive against SHA256SUMS.txt contents. */
export async function verifyChecksum(archivePath: string, archiveName: string, sumsContent: string): Promise<void> {
	const expectedHash = findExpectedHash(sumsContent, archiveName);
	if (expectedHash === null) {
		throw new Error(`No checksum entry for ${archiveName} in SHA256SUMS.txt`);
	}
	if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
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

async function pathExists(p: string): Promise<boolean> {
	return stat(p).then(() => true, () => false);
}

/**
 * Best-effort removal of update backups left over from previous updates —
 * the legacy single `.old/` and every timestamped `.old-<epoch>/`.
 *
 * On Windows, individual files inside a backup may still be locked briefly
 * after the previous process exited; we ignore those failures and they'll
 * be retried on the next launch. One locked backup must never stop the
 * others from being swept.
 */
export async function cleanupOldInstall(installDir: string): Promise<void> {
	const targets = [join(installDir, ".old"), ...(await listBackupDirs(installDir))];
	for (const dir of targets) {
		if (!(await pathExists(dir))) continue;
		await rm(dir, { recursive: true, force: true }).catch(() => {
			/* Some files still locked — try again next launch. */
		});
	}
}

interface SwapPlan {
	readonly fromStaging: string;
	readonly toInstall: string;
	readonly backupInOld: string;
}

/**
 * Reports whether the install directory currently differs from its pre-swap
 * state. Called with `true` the moment the first rename lands, and with `false`
 * again if a rollback afterwards restores every entry successfully.
 *
 * This is what separates a soft failure from a fatal one: `fatal` must mean
 * "files on disk are in a mixed old/new state", never merely "something went
 * wrong during the swap phase".
 */
export type InstallModifiedListener = (modified: boolean) => void;

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
export async function performSwap(
	installDir: string,
	stagingDir: string,
	onInstallModified?: InstallModifiedListener,
): Promise<string> {
	// 1. Allocate a backup dir unique to this attempt. Never reuse or delete an
	//    older one here — a leftover backup may be the user's only way back.
	const oldDir = await createBackupDir(installDir);

	// 2. Plan: one SwapPlan per top-level entry in staging, excluding protected names.
	const stagingEntries = await readdir(stagingDir, { withFileTypes: true });
	const plan: SwapPlan[] = [];
	for (const entry of stagingEntries) {
		const name = entry.name;
		if (isProtectedName(name)) continue;
		plan.push({
			fromStaging: join(stagingDir, name),
			toInstall: join(installDir, name),
			backupInOld: join(oldDir, name),
		});
	}

	// 3. Execute with rollback.
	const completed: SwapPlan[] = [];
	let modified = false;
	const noteModified = (): void => {
		if (modified) return;
		modified = true;
		onInstallModified?.(true);
	};

	// An entry whose backup landed but whose replacement did NOT is the one
	// case the install can end up simply missing a file: it never reaches
	// `completed`, so the reverse-order loop below would skip it.
	let orphanedBackup: SwapPlan | null = null;

	try {
		for (const swap of plan) {
			orphanedBackup = null;
			// Backup existing entry (skip if absent — new file in this release).
			try {
				await rename(swap.toInstall, swap.backupInOld);
				// The install directory now differs from its pre-swap state:
				// everything from here on is potentially-fatal territory.
				noteModified();
				orphanedBackup = swap;
			} catch (err) {
				if (!isNotFound(err)) throw err;
			}
			// Move new entry into place.
			await rename(swap.fromStaging, swap.toInstall);
			noteModified();
			orphanedBackup = null;
			completed.push(swap);
		}
		return oldDir;
	} catch (err) {
		// Rollback all completed swaps in reverse order.
		console.error("Swap failed mid-flight, rolling back...");
		let fullyRestored = true;
		const restore = async (done: SwapPlan): Promise<void> => {
			try {
				await rm(done.toInstall, { recursive: true, force: true });
				await rename(done.backupInOld, done.toInstall);
			} catch (rollbackErr) {
				fullyRestored = false;
				console.error(
					"Rollback failed for",
					basename(done.toInstall),
					":",
					rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
				);
			}
		};

		// Put the half-swapped entry back first — it is the newest mutation.
		if (orphanedBackup) await restore(orphanedBackup);
		for (const done of [...completed].reverse()) {
			await restore(done);
		}
		// A rollback that restored every completed move puts the install back
		// exactly where it started, so the caller must not call this fatal.
		if (modified && fullyRestored) {
			modified = false;
			onInstallModified?.(false);
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
export async function downloadAndSwap(
	release: ParsedRelease,
	installDir: string,
	callbacks?: UpdateProgressCallbacks,
): Promise<string> {
	const stagingDir = join(installDir, ".next");
	const archivePath = join(stagingDir, `archive${ARCHIVE_SUFFIX}`);
	const sumsPath = join(stagingDir, SUMS_ASSET_NAME);
	const extractDir = join(stagingDir, "extract");

	// Reset any stale staging from an interrupted previous attempt.
	await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
	await mkdir(stagingDir, { recursive: true });

	// Set only once a rename has actually landed on disk (and cleared again if
	// a rollback fully undoes it). Anything that fails while this is false left
	// the install byte-for-byte untouched and is therefore retryable.
	let installModified = false;

	try {
		console.log("· Downloading release archive...");
		callbacks?.onPhase?.("downloading-archive");
		await downloadToPathWithProgress(
			release.archiveAsset.browser_download_url,
			archivePath,
			(received, total) => callbacks?.onDownloadProgress?.(release.archiveAsset.browser_download_url, received, total),
		);

		console.log("· Downloading checksums...");
		callbacks?.onPhase?.("downloading-sums");
		await downloadToPathWithProgress(
			release.sumsAsset.browser_download_url,
			sumsPath,
		);
		const sumsContent = await Bun.file(sumsPath).text();

		console.log("· Verifying checksum...");
		callbacks?.onPhase?.("verifying");
		// The asset's own `name` — NOT basename(browser_download_url), which a
		// redirect or a query string can silently reshape.
		await verifyChecksum(archivePath, release.archiveAsset.name, sumsContent);

		console.log("· Extracting...");
		callbacks?.onPhase?.("extracting");
		await mkdir(extractDir, { recursive: true });
		await extractArchive(archivePath, extractDir);

		console.log("· Installing...");
		callbacks?.onPhase?.("swapping");
		await performSwap(installDir, extractDir, (modified) => {
			installModified = modified;
		});

		return release.version;
	} catch (err) {
		if (installModified) {
			// A rename landed and was not fully rolled back: the install may be
			// in a mixed old/new state. This is the only genuinely fatal case.
			throw err;
		}
		// Everything else — download, checksum, extraction, and any swap
		// failure that rolled back cleanly — left the install untouched.
		// Re-throw as a soft error so the caller can offer Retry.
		throw new SoftUpdateError(err);
	} finally {
		await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Marks a failure that happened before the install was modified. */
export class SoftUpdateError extends Error {
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
export async function fetchReleaseAssets(tag: string): Promise<ParsedRelease | null> {
	// Hit the tag-specific endpoint for stability (the /releases/latest route
	// could in theory return a different release if a newer one ships between
	// the initial check and this call).
	const url = `${resolveApiBase()}/releases/tags/${encodeURIComponent(tag)}`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { "User-Agent": "vibe-tavern-updater", Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		// DNS failure, connection reset, timeout. Returning null keeps this a
		// SOFT failure at the call site; letting it throw would escape
		// downloadAndSwap's try and be reported as a corrupted install.
		console.error("[updater] release asset lookup failed:", err instanceof Error ? err.message : String(err));
		return null;
	}
	if (!response.ok) return null;
	return parseReleaseBody(response);
}

/** Parse a GitHub release response, treating a malformed body as "no release". */
async function parseReleaseBody(response: Response): Promise<ParsedRelease | null> {
	try {
		return parseRelease(await response.json());
	} catch (err) {
		console.error("[updater] malformed release JSON:", err instanceof Error ? err.message : String(err));
		return null;
	}
}

/**
 * Progress callbacks invoked by downloadAndSwapWithProgress at each phase.
 * `receivedBytes`/`totalBytes` are passed during download when the server
 * reports a Content-Length header (otherwise undefined).
 */
export interface UpdateProgressCallbacks {
	readonly onPhase?: (phase: UpdatePhase) => void;
	readonly onDownloadProgress?: (url: string, receivedBytes: number | undefined, totalBytes: number | undefined) => void;
}

/** Coarse-grained phases the orchestrator surfaces to the UI. */
export type UpdatePhase =
	| "downloading-archive"
	| "downloading-sums"
	| "verifying"
	| "extracting"
	| "swapping";

/**
 * Download a URL to a local file path with optional progress reporting.
 * Throws on non-2xx or network error.
 */
async function downloadToPathWithProgress(
	url: string,
	destPath: string,
	onProgress?: (receivedBytes: number | undefined, totalBytes: number | undefined) => void,
): Promise<void> {
	const response = await fetch(url, {
		headers: { "User-Agent": "vibe-tavern-updater" },
		signal: AbortSignal.timeout(300_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
	}
	const contentLengthHeader = response.headers.get("content-length");
	const total = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined;

	// Stream the response body to disk so we can report incremental progress
	// without buffering the whole archive into memory.
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			received += value.byteLength;
			onProgress?.(received, total);
		}
	}
	// Concat into a single buffer for Bun.write (matches the original behavior
	// of writing the full payload atomically).
	let totalBytes = 0;
	for (const c of chunks) totalBytes += c.byteLength;
	const buf = new Uint8Array(totalBytes);
	let offset = 0;
	for (const c of chunks) {
		buf.set(c, offset);
		offset += c.byteLength;
	}
	await Bun.write(destPath, buf);
}
