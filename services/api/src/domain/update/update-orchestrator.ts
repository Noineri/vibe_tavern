/**
 * UI-triggered self-update orchestrator.
 *
 * Wraps the existing updater pipeline (checkForUpdate → downloadAndSwap) with:
 *   - In-memory status state machine polled by the SPA during update
 *   - Verbose error capture (full stack + phase context) surfaced to the UI
 *   - Soft vs fatal failure distinction (install-untouched vs corrupted-state)
 *
 * After a successful swap the orchestrator sets phase to "done", holds the
 * process alive briefly so the SPA can poll the final status, then exits
 * cleanly via process.exit(0). The user restarts Vibe Tavern manually.
 */

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

	getStatus(): UpdateStatus {
		return this.status;
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

	private finishAndExit(): void {
		setTimeout(() => {
			process.exit(0);
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
 */
export type InstallKind = "standalone" | "inno-setup" | "docker" | "dev";

export function detectInstallKind(): InstallKind {
	if (!IS_COMPILED) return "dev";
	if (process.env.VIBE_TAVERN_DOCKER === "1") return "docker";
	// Inno Setup default install path on Windows: C:\Program Files\Vibe Tavern\...
	if (process.platform === "win32" && /Program Files[\\/]/i.test(process.execPath)) {
		return "inno-setup";
	}
	return "standalone";
}

export function canSelfUpdate(): boolean {
	return detectInstallKind() === "standalone";
}
