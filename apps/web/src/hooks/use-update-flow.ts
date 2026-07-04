import { useCallback, useEffect, useRef, useState } from "react";
import {
	fetchUpdateStatus,
	resetUpdate,
	triggerUpdate,
	type RuntimeUpdatePhase,
	type RuntimeUpdateStatus,
} from "../api/runtime-api.js";

export type UpdateModalState =
	| { kind: "idle" }
	| { kind: "confirming" }
	| { kind: "running"; phase: RuntimeUpdatePhase; progress: { receivedBytes: number; totalBytes: number | null } | null; targetVersion: string | null }
	| { kind: "complete"; newVersion: string }
	| { kind: "error"; failureKind: "soft" | "fatal"; message: string; phase: RuntimeUpdatePhase; stack: string | null; raw: string | null };

const INITIAL: UpdateModalState = { kind: "idle" };

const STATUS_POLL_INTERVAL_MS = 500;

/**
 * Drives the modal state machine.
 *
 * `expectedVersion` is the version we EXPECT to see after the update — sourced
 * from the GitHub release info (version-check.ts) and threaded through the
 * orchestrator's targetVersion. We display this as the "Updated to X.X.X"
 * text without fetching /api/runtime/version post-restart, because the parent
 * process exits after the swap and there is no server to query.
 *
 * After the swap completes the orchestrator sets phase="done", holds for 500ms
 * so we can poll the final status, then calls process.exit(0). The user
 * restarts Vibe Tavern manually.
 */
export function useUpdateFlow(expectedVersion: string | null) {
	const [state, setState] = useState<UpdateModalState>(INITIAL);
	const stopFlagRef = useRef(false);
	const lastPhaseRef = useRef<RuntimeUpdatePhase | null>(null);

	const reset = useCallback(async () => {
		stopFlagRef.current = true;
		lastPhaseRef.current = null;
		try {
			await resetUpdate();
		} catch {
			// Best-effort — server may already be gone or unreachable.
		}
		setState(INITIAL);
	}, []);

	const watchStatus = useCallback(
		(targetVersion: string | null) => {
			stopFlagRef.current = false;
			const resolvedTarget = () => targetVersion ?? expectedVersion;
			const poll = async () => {
				if (stopFlagRef.current) return;
				let status: RuntimeUpdateStatus;
				try {
					status = await fetchUpdateStatus();
				} catch {
					// Parent process exited. If we got past "swapping", the
					// update completed successfully — the server is gone
					// because it exited on purpose. If we were still in an
					// early phase, something unexpected happened.
					const last = lastPhaseRef.current;
					if (last === "swapping" || last === "done") {
						setState({ kind: "complete", newVersion: resolvedTarget() ?? "" });
					} else {
						setState({
							kind: "error",
							failureKind: "fatal",
							message: "The server process exited unexpectedly during the update.",
							phase: last ?? "idle",
							stack: null,
							raw: null,
						});
					}
					return;
				}
				if (stopFlagRef.current) return;
				lastPhaseRef.current = status.phase;

				if (status.phase === "done") {
					setState({ kind: "complete", newVersion: status.targetVersion ?? resolvedTarget() ?? "" });
					return;
				}

				if (status.phase === "error") {
					const err = status.error;
					if (!err) {
						setState({
							kind: "error",
							failureKind: "fatal",
							message: "Update failed for an unknown reason (no error detail surfaced).",
							phase: status.phase,
							stack: null,
							raw: null,
						});
						return;
					}
					setState({
						kind: "error",
						failureKind: err.kind,
						message: err.message,
						phase: err.phase,
						stack: err.stack,
						raw: err.raw,
					});
					return;
				}

				setState({
					kind: "running",
					phase: status.phase,
					progress: status.downloadProgress,
					targetVersion: status.targetVersion ?? resolvedTarget(),
				});
				setTimeout(poll, STATUS_POLL_INTERVAL_MS);
			};
			void poll();
		},
		[expectedVersion],
	);

	const start = useCallback(async () => {
		stopFlagRef.current = false;
		lastPhaseRef.current = null;
		setState({ kind: "running", phase: "checking", progress: null, targetVersion: expectedVersion });

		const result = await triggerUpdate();
		if (!result.accepted) {
			setState({
				kind: "error",
				failureKind: "soft",
				message: result.reason ?? "Update rejected by the server.",
				phase: "idle",
				stack: null,
				raw: null,
			});
			return;
		}
		watchStatus(expectedVersion);
	}, [watchStatus, expectedVersion]);

	const retry = useCallback(async () => {
		await reset();
		await start();
	}, [reset, start]);

	useEffect(() => {
		return () => {
			stopFlagRef.current = true;
		};
	}, []);

	return { state, start, retry, reset };
}
