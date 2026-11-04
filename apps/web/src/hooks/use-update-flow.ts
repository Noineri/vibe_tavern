import { useCallback, useSyncExternalStore } from "react";
import {
	fetchUpdateStatus,
	resetUpdate,
	triggerUpdate,
	type RuntimeUpdatePhase,
	type RuntimeUpdateStatus,
} from "../api/runtime-api.js";
import { getT } from "../i18n/locale-helpers.js";

export type UpdateModalState =
	| { kind: "idle" }
	| { kind: "confirming" }
	| { kind: "running"; phase: RuntimeUpdatePhase; progress: { receivedBytes: number; totalBytes: number | null } | null; targetVersion: string | null }
	| { kind: "complete"; newVersion: string }
	| { kind: "error"; failureKind: "soft" | "fatal"; message: string; phase: RuntimeUpdatePhase; stack: string | null; raw: string | null };

const INITIAL: UpdateModalState = { kind: "idle" };

const STATUS_POLL_INTERVAL_MS = 500;

// ── Module-scoped state machine (defect 2026-11-04) ─────────────────────────
//
// The update screen must survive the settings section REMOUNTING underneath
// it: crossing the desktop/mobile breakpoint swaps the modal's layout tree and
// unmounts every section, which used to reset this state to idle mid-download
// — progress vanished and closing became allowed again while the server kept
// swapping files. The state and the status poll therefore live at module
// scope; the hook below is a thin React binding. The poll is bounded: it ends
// on its own in the terminal states ("complete", "error") or on reset().

let current: UpdateModalState = INITIAL;
const listeners = new Set<() => void>();
let stopPolling = false;
let lastPhase: RuntimeUpdatePhase | null = null;
let expectedVersion: string | null = null;

function emit(next: UpdateModalState): void {
	current = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Drives the update state machine.
 *
 * `expectedVersion` is the version we EXPECT to see after the update, threaded
 * through the orchestrator's targetVersion and shown as the "Updated to X.X.X"
 * text.
 *
 * Once the swap succeeds the server exits for good — it does not relaunch
 * itself, because a self-respawned process detaches from the terminal and
 * becomes an orphan the user cannot stop with Ctrl+C. So the connection drops
 * BY DESIGN and never comes back in this page's lifetime: "complete" is a
 * terminal state whose only content is "start Vibe Tavern again".
 */
function watchStatus(): void {
	stopPolling = false;
	const resolvedTarget = () => expectedVersion;
	const poll = async () => {
		if (stopPolling) return;
		let status: RuntimeUpdateStatus;
		try {
			status = await fetchUpdateStatus();
		} catch {
			// Server process exited. If we got past "swapping", the
			// update completed successfully — the server is gone
			// because it exited on purpose. If we were still in an
			// early phase, something unexpected happened.
			const last = lastPhase;
			if (last === "swapping" || last === "done") {
				emit({ kind: "complete", newVersion: resolvedTarget() ?? "" });
			} else {
				emit({
					kind: "error",
					failureKind: "fatal",
					message: getT()("update_modal_runtime_error_server_exited"),
					phase: last ?? "idle",
					stack: null,
					raw: null,
				});
			}
			return;
		}
		if (stopPolling) return;
		lastPhase = status.phase;

		if (status.phase === "done") {
			// The swap succeeded and the server is about to exit. There is
			// nothing left to wait for — this page is done.
			emit({ kind: "complete", newVersion: status.targetVersion ?? resolvedTarget() ?? "" });
			return;
		}

		if (status.phase === "error") {
			const err = status.error;
			if (!err) {
				emit({
					kind: "error",
					failureKind: "fatal",
					message: getT()("update_modal_runtime_error_unknown"),
					phase: status.phase,
					stack: null,
					raw: null,
				});
				return;
			}
			emit({
				kind: "error",
				failureKind: err.kind,
				message: err.message,
				phase: err.phase,
				stack: err.stack,
				raw: err.raw,
			});
			return;
		}

		emit({
			kind: "running",
			phase: status.phase,
			progress: status.downloadProgress,
			targetVersion: status.targetVersion ?? resolvedTarget(),
		});
		setTimeout(poll, STATUS_POLL_INTERVAL_MS);
	};
	void poll();
}

async function resetFlow(): Promise<void> {
	stopPolling = true;
	lastPhase = null;
	try {
		await resetUpdate();
	} catch {
		// Best-effort — server may already be gone or unreachable.
	}
	emit(INITIAL);
}

async function startFlow(target: string | null): Promise<void> {
	expectedVersion = target;
	stopPolling = false;
	lastPhase = null;
	emit({ kind: "running", phase: "checking", progress: null, targetVersion: target });

	const result = await triggerUpdate();
	if (!result.accepted) {
		emit({
			kind: "error",
			failureKind: "soft",
			message: result.reason ?? getT()("update_modal_runtime_error_rejected"),
			phase: "idle",
			stack: null,
			raw: null,
		});
		return;
	}
	watchStatus();
}

/** Test seam — stop the poll and forget the state (production never calls). */
export function __resetUpdateFlowForTests(): void {
	stopPolling = true;
	lastPhase = null;
	expectedVersion = null;
	emit(INITIAL);
}

/**
 * React binding onto the module-scoped update state machine. The state
 * deliberately outlives any single component instance — remounts (viewport
 * changes inside the settings modal) keep the progress view and the
 * non-dismissable guard intact.
 */
export function useUpdateFlow(expectedVersion: string | null) {
	const state = useSyncExternalStore(subscribe, () => current);
	const start = useCallback(() => void startFlow(expectedVersion), [expectedVersion]);
	const reset = useCallback(() => void resetFlow(), []);
	const retry = useCallback(() => void resetFlow().then(() => startFlow(expectedVersion)), [expectedVersion]);
	return { state, start, retry, reset };
}
