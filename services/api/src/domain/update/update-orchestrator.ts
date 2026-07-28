/**
 * UI-triggered self-update orchestrator.
 *
 * Wraps the existing updater pipeline (checkForUpdate → downloadAndSwap) with:
 *   - In-memory status state machine polled by the SPA during update
 *   - Verbose error capture (full stack + phase context) surfaced to the UI
 *   - Soft vs fatal failure distinction (install-untouched vs corrupted-state)
 *
 * After a successful swap the orchestrator sets phase to "done", holds the
 * process alive briefly so the SPA can poll that status, then stops serving,
 * relaunches the replaced executable detached, and exits. If the relaunch
 * throws it degrades to the previous behavior — exit and let the user start
 * Vibe Tavern again — because a failed respawn is not a failed update.
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
	| "spawning-restart"
	| "exiting"
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

			this.finishAndExit(installDir);
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
	 * Hand over to the new build: stop serving, relaunch the replaced
	 * executable detached, then exit.
	 *
	 * The delay before exiting exists so the SPA can poll one last status and
	 * see "spawning-restart" rather than a dropped connection it has to guess
	 * about.
	 *
	 * A failed respawn is NOT a failed update — the swap already succeeded, so
	 * the fallback is the old behavior: exit and let the user relaunch.
	 */
	private finishAndExit(installDir: string): void {
		setTimeout(() => {
			this.status = { ...this.status, phase: "spawning-restart" };

			let respawned = false;
			try {
				// Release the port first, or the new process races us for it
				// and loses.
				if (!stopRuntimeServer()) {
					console.warn("[update-orchestrator] no server to stop; continuing to respawn.");
				}
				Bun.spawn([process.execPath], {
					cwd: installDir,
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				}).unref();
				respawned = true;
			} catch (err) {
				console.error(
					"[update-orchestrator] could not relaunch after update:",
					err instanceof Error ? err.message : String(err),
				);
				console.error("[update-orchestrator] the update itself succeeded — start Vibe Tavern manually.");
			}

			this.status = { ...this.status, phase: respawned ? "exiting" : "done" };
			setTimeout(() => process.exit(0), respawned ? 250 : 500);
		}, 500);
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
