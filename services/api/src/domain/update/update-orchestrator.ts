/**
 * UI-triggered self-update orchestrator.
 *
 * Wraps the existing updater pipeline (checkForUpdate → downloadAndSwap) with:
 *   - In-memory status state machine polled by the SPA during update
 *   - Verbose error capture (full stack + phase context) surfaced to the UI
 *   - Soft vs fatal failure distinction (install-untouched vs corrupted-state)
 *
 * After a successful swap the orchestrator sets phase to "done", holds the
 * process alive briefly so the SPA can poll that status, then stops serving
 * and exits for good. It does NOT relaunch itself — see shutdownAfterUpdate
 * for why the previous detached respawn was withdrawn.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	checkForUpdate,
	cleanupOldInstall,
	downloadAndSwap,
	fetchReleaseAssets,
	getCurrentVersion,
	IS_COMPILED,
	resolveInstallDir,
	SoftUpdateError,
	type UpdatePhase,
} from "../../server/updater.js";
import { resolveStandalonePaths } from "../../server/standalone-paths.js";
import { stopRuntimeServer } from "../../server/runtime-shutdown.js";
import { snapshotDatabase } from "./update-db-snapshot.js";

export type UpdateOrchestratorPhase =
	| "idle"
	| "checking"
	| UpdatePhase
	| "done"
	| "error";

export type UpdateFailureKind = "soft" | "fatal";

export interface UpdateFailureDetail {
	readonly kind: UpdateFailureKind;
	readonly message: string;
	readonly phase: UpdateOrchestratorPhase;
	readonly stack: string | null;
	readonly raw: string | null;
}

export interface UpdateStatus {
	readonly phase: UpdateOrchestratorPhase;
	readonly startedAt: number | null;
	readonly currentVersion: string;
	readonly targetVersion: string | null;
	readonly downloadProgress: { readonly receivedBytes: number; readonly totalBytes: number | null } | null;
	readonly error: UpdateFailureDetail | null;
}

const INITIAL_STATUS: UpdateStatus = {
	phase: "idle",
	startedAt: null,
	currentVersion: getCurrentVersion(),
	targetVersion: null,
	downloadProgress: null,
	error: null,
};

/**
 * How long the process stays alive after the swap so the SPA can poll the
 * final "done" status. The SPA polls every 500 ms.
 */
const EXIT_GRACE_MS = 1_500;

/**
 * Terminal step of a successful update: stop serving, then exit for good.
 *
 * The process deliberately does NOT relaunch itself. An earlier revision
 * spawned the replaced binary with `detached: true`; on POSIX that is setsid(),
 * so the new process left the shell's foreground process group and lost the
 * controlling terminal — Ctrl+C in the launching console no longer stopped Vibe
 * Tavern and the user needed `pkill` to find and kill an invisible orphan.
 * Windows `DETACHED_PROCESS` produces the same orphan without a console.
 *
 * Exiting is the one ending that behaves identically on both platforms and
 * leaves nothing behind. The modal tells the user to start Vibe Tavern again
 * and refuses to be dismissed, so the instruction cannot be missed.
 *
 * Exported for testing: `process.exit` cannot be exercised in-process.
 */
export async function shutdownAfterUpdate(
	stopServer: () => boolean | Promise<boolean>,
	exit: (code: number) => void,
): Promise<void> {
	try {
		if (!(await stopServer())) {
			console.warn("[update-orchestrator] no server was registered to stop.");
		}
	} catch (err) {
		// A server that refuses to stop must not keep the old build alive.
		console.error(
			"[update-orchestrator] could not stop the server cleanly:",
			err instanceof Error ? err.message : String(err),
		);
	}
	console.log("[update-orchestrator] update complete — start Vibe Tavern again to run the new version.");
	exit(0);
}

class UpdateOrchestrator {
	private status: UpdateStatus = INITIAL_STATUS;
	private running = false;
	/** Where this run's pre-update database snapshot landed, for the UI/logs. */
	private dbSnapshotPath: string | null = null;

	getStatus(): UpdateStatus {
		return this.status;
	}

	getDbSnapshotPath(): string | null {
		return this.dbSnapshotPath;
	}

	triggerUpdate(): { accepted: boolean; reason?: string } {
		if (this.running) {
			return { accepted: false, reason: "An update is already in progress." };
		}
		if (!IS_COMPILED) {
			return { accepted: false, reason: "Self-update is unavailable in dev builds." };
		}
		const installDir = resolveInstallDir();
		if (!installDir) {
			return { accepted: false, reason: "Could not resolve install directory." };
		}

		this.running = true;
		void this.runPipeline(installDir);
		return { accepted: true };
	}

	private async runPipeline(installDir: string): Promise<void> {
		this.status = {
			...INITIAL_STATUS,
			phase: "checking",
			startedAt: Date.now(),
			currentVersion: getCurrentVersion(),
		};

		try {
			await cleanupOldInstall(installDir);

			const check = await checkForUpdate();
			if (!check) {
				this.fail("soft", "Could not reach GitHub to look up the latest release.", "checking", null);
				return;
			}
			if (!check.updateAvailable) {
				this.fail("soft", "Already running the latest version.", "checking", null);
				return;
			}

			this.status = { ...this.status, targetVersion: check.latestVersion };

			const release = await fetchReleaseAssets(check.latestTag);
			if (!release) {
				this.fail("soft", "Could not fetch the release asset list from GitHub.", "checking", null);
				return;
			}

			// Recovery point before anything touches the install. Failing to take
			// one aborts rather than proceeding: an update with no way back is
			// exactly what this plan exists to prevent.
			const paths = await resolveStandalonePaths();
			const snapshot = await snapshotDatabase(paths.dbPath, paths.dataDir, check.latestVersion);
			if (!snapshot.ok) {
				this.fail("soft", snapshot.message ?? "Could not create a pre-update database backup.", "checking", null);
				return;
			}
			this.dbSnapshotPath = snapshot.path;
			console.log(`[update-orchestrator] pre-update database snapshot: ${snapshot.path}`);

			const newVersion = await downloadAndSwap(release, installDir, {
				onPhase: (phase) => {
					this.status = { ...this.status, phase, downloadProgress: null };
				},
				onDownloadProgress: (_url, receivedBytes, totalBytes) => {
					if (receivedBytes === undefined) return;
					this.status = {
						...this.status,
						downloadProgress: {
							receivedBytes,
							totalBytes: totalBytes ?? null,
						},
					};
				},
			});

			// Swap completed. Set phase to "done" so the SPA can show the
			// "Updated to X.X.X — Restart Vibe Tavern" screen, then exit.
			this.status = {
				...this.status,
				phase: "done",
				downloadProgress: null,
				targetVersion: newVersion,
			};

			this.finishAndExit();
		} catch (err) {
			const phase = this.status.phase;
			if (err instanceof SoftUpdateError) {
				// Pre-swap failure: install untouched, safe to retry.
				this.fail(
					"soft",
					err.message,
					phase,
					err.cause instanceof Error ? err.cause : err,
				);
				return;
			}
			// Swap failure or any other unexpected throw: the install may be in
			// a mixed old/new state. Treat as fatal — user must re-download.
			this.fail(
				"fatal",
				err instanceof Error ? err.message : String(err),
				phase,
				err,
			);
		}
	}

	private fail(
		kind: UpdateFailureKind,
		message: string,
		phase: UpdateOrchestratorPhase,
		cause: unknown,
	): void {
		const errObj = cause instanceof Error ? cause : null;
		this.status = {
			...this.status,
			phase: "error",
			error: {
				kind,
				message,
				phase,
				stack: errObj?.stack ?? null,
				raw: cause !== null && cause !== undefined ? String(cause) : null,
			},
			downloadProgress: null,
		};
		this.running = false;
		// Verbose server-side log for diagnosis — the UI gets the same payload.
		console.error(`[update-orchestrator] ${kind} failure at "${phase}":`, message);
		if (errObj?.stack) console.error(errObj.stack);
	}

	/**
	 * Let the SPA observe the terminal "done" status, then shut down.
	 *
	 * The grace period is longer than the SPA's 500 ms status poll so the happy
	 * path is deterministic rather than a race. Missing it is still safe: the
	 * SPA treats a dropped connection after "swapping" as a completed update.
	 */
	private finishAndExit(): void {
		setTimeout(() => {
			// shutdownAfterUpdate is async: it awaits the registered shutdown hook
			// (server stop + bridge close) before calling exit(0). The `void` keeps
			// the setTimeout callback synchronous; the awaited cleanup completes
			// before process.exit runs inside the function.
			void shutdownAfterUpdate(stopRuntimeServer, (code) => process.exit(code));
		}, EXIT_GRACE_MS);
	}

	reset(): void {
		if (this.running) return;
		this.status = INITIAL_STATUS;
	}
}

let singleton: UpdateOrchestrator | null = null;

export function getUpdateOrchestrator(): UpdateOrchestrator {
	if (!singleton) singleton = new UpdateOrchestrator();
	return singleton;
}

/**
 * Install-kind classification surfaced to the UI so the modal can fall back
 * to "Open release page" when self-update is not supported (Inno Setup,
 * Docker, dev builds).
 *
 * Docker MUST be checked before IS_COMPILED: the Docker image runs
 * `bun prod-server.js` (not a compiled binary), so IS_COMPILED is false —
 * checking IS_COMPILED first would mislabel Docker as "dev". The Dockerfile
 * sets VIBE_TAVERN_DOCKER=1 in the release stage.
 */
export type InstallKind = "standalone" | "inno-setup" | "docker" | "dev";

const INNO_MARKER_FILENAME = ".vibe-tavern-install";

/** Pure classifier — exported for unit testing (detection inputs are otherwise
 *  pinned at module load: IS_COMPILED, process.platform, process.execPath). */
export function classifyInstallKind(input: {
	dockerEnv: string | undefined;
	isCompiled: boolean;
	platform: string;
	execPath: string;
	hasInnoMarker: boolean;
}): InstallKind {
	if (input.dockerEnv === "1") return "docker";
	if (!input.isCompiled) return "dev";
	if (input.hasInnoMarker) return "inno-setup";
	if (input.platform === "win32" && /Program Files[\\/]/i.test(input.execPath)) {
		return "inno-setup";
	}
	return "standalone";
}

export function detectInstallKind(): InstallKind {
	return classifyInstallKind({
		dockerEnv: process.env.VIBE_TAVERN_DOCKER,
		isCompiled: IS_COMPILED,
		platform: process.platform,
		execPath: process.execPath,
		hasInnoMarker: existsSync(join(dirname(process.execPath), INNO_MARKER_FILENAME)),
	});
}

export function canSelfUpdate(): boolean {
	return detectInstallKind() === "standalone";
}
