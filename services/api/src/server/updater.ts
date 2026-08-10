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
import { checkFreeSpace } from "./update-preflight.js";

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

/** The human-facing releases page, for UI fallbacks and error messages. */
export function releasePageUrl(): string {
	return resolveHtmlUrl();
}

const SUMS_ASSET_NAME = "SHA256SUMS.txt";

/**
 * Which release archive, if any, this machine can install.
 *
 * The release publishes exactly `Vibe-Tavern-v<V>-linux.tar.gz` and
 * `Vibe-Tavern-v<V>-windows.zip`, and BOTH are x64-only — no architecture
 * appears anywhere in the filenames. The old `ARCHIVE_SUFFIX` keyed on
 * platform alone, so an arm64 Linux box (a VPS, a Raspberry Pi, the
 * proot-Android install) matched the x64 tarball and would happily download,
 * verify, extract and install a binary it cannot execute.
 *
 * The guard lives here, in asset selection, rather than in
 * classifyInstallKind: this rule covers every non-x64 environment without
 * naming any of them, and it keeps install-kind detection (owned by the
 * Android branch) untouched.
 *
 * `Vibe-Tavern-v<V>-android.apk` and `-windows-setup.exe` are never updater
 * archives and can never be selected — neither suffix is reachable from here.
 */
export type ArchiveSuffixResolution =
	| { readonly kind: "supported"; readonly suffix: string }
	| { readonly kind: "no-asset-for-platform" };

export function resolveArchiveSuffix(platform: string, arch: string): ArchiveSuffixResolution {
	if (arch !== "x64") return { kind: "no-asset-for-platform" };
	if (platform === "linux") return { kind: "supported", suffix: "-linux.tar.gz" };
	if (platform === "win32") return { kind: "supported", suffix: "-windows.zip" };
	return { kind: "no-asset-for-platform" };
}

/** The resolution for the machine this process is running on. */
export function currentArchiveSuffix(): ArchiveSuffixResolution {
	return resolveArchiveSuffix(process.platform, process.arch);
}

/** The archive extension of an asset name, for naming the staged download. */
function archiveExtension(assetName: string): string {
	const lower = assetName.toLowerCase();
	if (lower.endsWith(".tar.gz")) return ".tar.gz";
	if (lower.endsWith(".zip")) return ".zip";
	if (lower.endsWith(".tgz")) return ".tgz";
	// Unreachable for a release that passed asset resolution; keeping the raw
	// suffix means extraction fails loudly instead of silently mis-dispatching.
	return assetName.slice(assetName.lastIndexOf("."));
}

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

/**
 * Written into the install dir the moment a swap completes, and removed only
 * once the NEW build has answered a request. While it exists, the startup sweep
 * leaves backups alone — otherwise the first boot after an update would delete
 * the only way back at exactly the moment it might be needed.
 */
const UPDATE_PENDING_MARKER = ".update-pending";

/** True for `.old`, every `.old-<epoch>` backup, and the other reserved names. */
function isProtectedName(name: string): boolean {
	return PROTECTED_NAMES.has(name)
		|| name === UPDATE_PENDING_MARKER
		|| name.startsWith(OLD_BACKUP_PREFIX);
}

/** Record that a swap landed and its backup must be retained for now. */
async function markUpdatePending(installDir: string, backupDir: string): Promise<void> {
	const payload = JSON.stringify({ backupDir: basename(backupDir), at: new Date().toISOString() });
	await Bun.write(join(installDir, UPDATE_PENDING_MARKER), payload).catch((err: unknown) => {
		// Not fatal: worst case the backups are swept a boot earlier than ideal.
		console.error(
			"[updater] could not write the update marker:",
			err instanceof Error ? err.message : String(err),
		);
	});
}

/** True while an update is waiting for its first successful boot. */
export async function isUpdatePending(installDir: string): Promise<boolean> {
	return pathExists(join(installDir, UPDATE_PENDING_MARKER));
}

/**
 * Called once the updated build is confirmed to be serving: drop the marker and
 * sweep the backups it was protecting.
 */
export async function finalizeUpdatePending(installDir: string): Promise<void> {
	if (!(await isUpdatePending(installDir))) return;
	await rm(join(installDir, UPDATE_PENDING_MARKER), { force: true }).catch(() => undefined);
	await cleanupOldInstall(installDir);
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
	/** Bytes, as GitHub reports them. 0 when the field was absent or unusable. */
	readonly size: number;
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
export async function checkForUpdate(
	options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult | null> {
	const detailed = await checkForUpdateDetailed(options);
	return detailed.kind === "ok" ? detailed.result : null;
}

/**
 * The same check, but reporting WHY it could not produce a result.
 *
 * `no-asset-for-platform` still carries the version information: a machine with
 * no matching archive should be told "1.5.0 is out, but there is no build for
 * your architecture" — not that the network is down, and not nothing at all.
 */
export type UpdateCheckOutcome =
	| { readonly kind: "ok"; readonly result: UpdateCheckResult }
	| {
		readonly kind: "no-asset-for-platform";
		readonly latestVersion: string | null;
		readonly latestTag: string | null;
		readonly releaseNotes: string;
		readonly updateAvailable: boolean;
	}
	| { readonly kind: "offline" };

export interface UpdateCheckOptions {
	/**
	 * Whether a release only counts once it carries an archive for this
	 * platform. True (the default) for every channel that installs BY
	 * downloading that archive.
	 *
	 * The npm channel must pass false. It installs from the registry and never
	 * looks at release assets — and there is no archive at all for macOS or for
	 * any non-x64 machine, so requiring one would permanently hide every update
	 * from exactly the users this channel exists to serve.
	 */
	readonly requirePlatformAsset?: boolean;
}

export async function checkForUpdateDetailed(
	options: UpdateCheckOptions = {},
): Promise<UpdateCheckOutcome> {
	let response: Response;
	try {
		response = await fetch(`${resolveApiBase()}/releases/latest`, {
			headers: { "User-Agent": "vibe-tavern-updater", Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return { kind: "offline" };
	}
	if (!response.ok) return { kind: "offline" };

	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		console.error("[updater] malformed release JSON:", err instanceof Error ? err.message : String(err));
		return { kind: "offline" };
	}

	const resolved = resolveRelease(body);
	if (resolved.kind === "unparseable") return { kind: "offline" };

	if (resolved.kind === "no-asset-for-platform") {
		// Re-read the tag directly: there is no ParsedRelease to take it from,
		// but the user still deserves to know a release exists.
		const root = typeof body === "object" && body !== null ? (body as GithubReleaseShape) : null;
		const tag = typeof root?.tag_name === "string" ? root.tag_name : null;
		const version = tag === null ? null : tag.replace(/^v/, "");
		const releaseNotes = typeof root?.body === "string" ? root.body : "";
		const updateAvailable = version !== null && compareVersions(CURRENT_VERSION, version) < 0;

		// A caller that does not install from archives has a complete answer
		// here: the release parsed fine, only its asset list was irrelevant.
		if (options.requirePlatformAsset === false && version !== null && tag !== null) {
			return {
				kind: "ok",
				result: {
					currentVersion: CURRENT_VERSION,
					latestVersion: version,
					latestTag: tag,
					releaseNotes,
					updateAvailable,
				},
			};
		}

		return {
			kind: "no-asset-for-platform",
			latestVersion: version,
			latestTag: tag,
			releaseNotes,
			updateAvailable,
		};
	}

	const parsed = resolved.release;
	return {
		kind: "ok",
		result: {
			currentVersion: CURRENT_VERSION,
			latestVersion: parsed.version,
			latestTag: parsed.tag,
			releaseNotes: parsed.releaseNotes,
			updateAvailable: compareVersions(CURRENT_VERSION, parsed.version) < 0,
		},
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

/**
 * Restore the most recent update backup over the current install.
 *
 * This is the manual escape hatch for "the new version is broken": the newest
 * `.old-<epoch>/` holds the exact tree the last successful swap replaced, so
 * swapping it back is the same operation in reverse, journal and all.
 *
 * Exits 0 when there is nothing to roll back — that is an ordinary answer to a
 * reasonable question, not an error.
 */
export async function runRollback(): Promise<never> {
	const installDir = resolveInstallDir();
	if (!installDir) {
		console.error("rollback: could not resolve install directory.");
		process.exit(0);
	}

	const backups = await listBackupDirs(installDir);
	const newest = backups[0];
	if (newest === undefined) {
		console.log("Nothing to roll back — no previous version is stored next to this install.");
		console.log("Update backups are kept only until the updated build has started successfully.");
		process.exit(0);
	}

	console.log(`Rolling back to the version saved in ${basename(newest)}...`);
	try {
		// performSwap treats `newest` exactly as it would a freshly extracted
		// release: back up what is there now, then move the old tree into place.
		const backupOfCurrent = await performSwap(installDir, newest);
		console.log("✓ Previous version restored.");
		console.log(`  The version you rolled back FROM is now in ${basename(backupOfCurrent)}.`);
	} catch (err) {
		console.error("Rollback FAILED:", err instanceof Error ? err.message : String(err));
		console.error(`Manual recovery: see ${resolveHtmlUrl()} to re-download.`);
		process.exit(1);
	}

	// The database is never rolled back automatically — a newer schema may have
	// migrated it, and silently reverting a user's data is not ours to decide.
	const snapshots = await listDbSnapshots();
	if (snapshots.length > 0) {
		console.log("");
		console.log("Pre-update database backups (restore manually if needed):");
		for (const s of snapshots) console.log(`  ${s}`);
	}
	process.exit(0);
}

/** Newest-first pre-update database snapshots, or [] if none/unreadable. */
async function listDbSnapshots(): Promise<string[]> {
	const { resolveStandalonePaths } = await import("./standalone-paths.js");
	const paths = await resolveStandalonePaths();
	const backupsDir = join(paths.dataDir, "backups");
	const entries = await readdir(backupsDir).catch(() => []);
	return entries
		.filter((n) => n.startsWith("pre-update-") && n.endsWith(".db"))
		.sort()
		.reverse()
		.map((n) => join(backupsDir, n));
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
	readonly size?: unknown;
}

/**
 * Why a release could not be turned into something installable.
 *
 * "no-asset-for-platform" is deliberately distinct from "unparseable": telling
 * an arm64 user that GitHub is unreachable, or that the release is malformed,
 * sends them looking for a problem that does not exist.
 */
export type ReleaseResolution =
	| { readonly kind: "ok"; readonly release: ParsedRelease }
	| { readonly kind: "no-asset-for-platform" }
	| { readonly kind: "unparseable" };

/**
 * Narrow the untyped JSON into our domain shape, reporting WHY when it fails.
 * `suffix` defaults to this machine's resolution.
 */
export function resolveRelease(
	data: unknown,
	resolution: ArchiveSuffixResolution = currentArchiveSuffix(),
): ReleaseResolution {
	if (typeof data !== "object" || data === null) return { kind: "unparseable" };
	const root = data as GithubReleaseShape;
	if (typeof root.tag_name !== "string") return { kind: "unparseable" };

	const body = typeof root.body === "string" ? root.body : "";
	if (!Array.isArray(root.assets)) return { kind: "unparseable" };

	const assets: GithubAsset[] = [];
	for (const raw of root.assets) {
		if (typeof raw !== "object" || raw === null) continue;
		const a = raw as GithubAssetShape;
		if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
		const size = typeof a.size === "number" && Number.isFinite(a.size) && a.size > 0 ? a.size : 0;
		assets.push({ name: a.name, browser_download_url: a.browser_download_url, size });
	}

	const sumsAsset = assets.find((a) => a.name === SUMS_ASSET_NAME) ?? null;
	if (!sumsAsset) return { kind: "unparseable" };

	// The architecture guard: a machine with no matching archive gets a
	// specific answer, not a generic failure.
	if (resolution.kind === "no-asset-for-platform") return { kind: "no-asset-for-platform" };

	const archiveAsset = assets.find((a) => a.name.endsWith(resolution.suffix)) ?? null;
	if (!archiveAsset) return { kind: "no-asset-for-platform" };

	const tag = root.tag_name;
	const version = tag.replace(/^v/, "");
	return { kind: "ok", release: { tag, version, releaseNotes: body, archiveAsset, sumsAsset } };
}

/**
 * Narrow the untyped JSON into our domain shape, or return null on mismatch.
 * Thin wrapper over resolveRelease for callers that only need "did it work".
 */
export function parseRelease(data: unknown): ParsedRelease | null {
	const resolved = resolveRelease(data);
	return resolved.kind === "ok" ? resolved.release : null;
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

/** Exported so the npm channel's CLI asks its confirmation exactly the way the
 *  binary channel's does, instead of growing a second copy of this. */
export async function promptUser(message: string): Promise<string> {
	process.stdout.write(message);
	return new Promise<string>((resolve) => {
		process.stdin.resume();
		process.stdin.once("data", (data: Buffer) => {
			process.stdin.pause();
			resolve(data.toString("utf8").trim());
		});
	});
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

/**
 * Verify a downloaded archive against SHA256SUMS.txt contents.
 *
 * `actualHash` is produced during the download itself, so the archive is never
 * read back off disk to be hashed.
 */
export function verifyChecksum(actualHash: string, archiveName: string, sumsContent: string): void {
	const expectedHash = findExpectedHash(sumsContent, archiveName);
	if (expectedHash === null) {
		throw new Error(`No checksum entry for ${archiveName} in SHA256SUMS.txt`);
	}
	if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
		throw new Error(`Malformed checksum line for ${archiveName}`);
	}

	const actual = actualHash.toLowerCase();
	if (actual !== expectedHash) {
		throw new Error(
			`Checksum mismatch for ${archiveName}\n  expected: ${expectedHash}\n  actual:   ${actual}`,
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
	// Name the staged file after the asset so archive-extract dispatches on the
	// release's real extension rather than on an assumption about this platform.
	const archivePath = join(stagingDir, `archive${archiveExtension(release.archiveAsset.name)}`);
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
		// Refuse before spending the download if the volume cannot hold the
		// result. This is inside the try so it becomes a SoftUpdateError like
		// every other pre-swap failure.
		console.log("· Checking free space...");
		callbacks?.onPhase?.("preflight");
		const space = await checkFreeSpace(installDir, release.archiveAsset.size);
		if (!space.ok && space.message !== null) {
			throw new Error(space.message);
		}

		console.log("· Downloading release archive...");
		callbacks?.onPhase?.("downloading-archive");
		const archiveDownload = await downloadToPathWithProgress(
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
		// The digest came from the download pass, so the archive is not read
		// back off disk. The asset's own `name` is used — NOT
		// basename(browser_download_url), which a redirect or a query string
		// can silently reshape.
		verifyChecksum(archiveDownload.sha256, release.archiveAsset.name, sumsContent);

		console.log("· Extracting...");
		callbacks?.onPhase?.("extracting");
		await mkdir(extractDir, { recursive: true });
		await extractArchive(archivePath, extractDir);

		console.log("· Installing...");
		callbacks?.onPhase?.("swapping");
		const backupDir = await performSwap(installDir, extractDir, (modified) => {
			installModified = modified;
		});
		// Protect this backup until the new build proves it can start.
		await markUpdatePending(installDir, backupDir);

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

/**
 * Coarse-grained phases the orchestrator surfaces to the UI.
 *
 * `installing-package` belongs to the npm channel only, where the package
 * manager does the download/verify/extract/swap as one opaque step — there is
 * nothing finer to report, and no byte progress to report it with.
 */
export type UpdatePhase =
	| "preflight"
	| "downloading-archive"
	| "downloading-sums"
	| "verifying"
	| "extracting"
	| "swapping"
	| "installing-package";

/** What a completed download produced, so nothing has to re-read the file. */
export interface DownloadOutcome {
	/** Lowercase hex SHA-256 of everything written, computed during the download. */
	readonly sha256: string;
	readonly bytes: number;
}

/**
 * Download a URL to a local file path with optional progress reporting,
 * hashing the bytes in the same pass.
 *
 * Each chunk goes straight to a FileSink and into the digest, so peak memory
 * is one chunk regardless of archive size. The previous implementation
 * accumulated every chunk in an array, allocated a second full-size copy to
 * concatenate them for `Bun.write`, and then `verifyChecksum` read the whole
 * file back a third time — roughly 3× a 63–76 MB artifact resident at once.
 *
 * Throws on non-2xx or network error.
 */
export async function downloadToPathWithProgress(
	url: string,
	destPath: string,
	onProgress?: (receivedBytes: number | undefined, totalBytes: number | undefined) => void,
): Promise<DownloadOutcome> {
	const response = await fetch(url, {
		headers: { "User-Agent": "vibe-tavern-updater" },
		signal: AbortSignal.timeout(300_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
	}
	// Absent on chunked responses, and not guaranteed to be a number when
	// present — a NaN here would reach the UI's progress bar as a NaN width.
	const contentLengthHeader = response.headers.get("content-length");
	const parsedLength = contentLengthHeader === null ? Number.NaN : Number.parseInt(contentLengthHeader, 10);
	const total = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : undefined;

	const hash = createHash("sha256");
	const sink = Bun.file(destPath).writer();
	const reader = response.body.getReader();
	let received = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			hash.update(value);
			sink.write(value);
			// Await the flush so the sink's buffer cannot grow without bound if
			// the network outruns the disk.
			await sink.flush();
			received += value.byteLength;
			onProgress?.(received, total);
		}
		await sink.end();
	} catch (err) {
		// Discard whatever landed; the caller nukes the staging dir anyway, but
		// leaving the sink open would keep the fd around until GC. FileSink.end()
		// returns number | Promise<number>, so normalize before catching.
		await Promise.resolve(sink.end()).catch((endErr: unknown) => {
			console.error(
				"[updater] closing the partial download failed:",
				endErr instanceof Error ? endErr.message : String(endErr),
			);
		});
		throw err;
	}

	return { sha256: hash.digest("hex").toLowerCase(), bytes: received };
}
