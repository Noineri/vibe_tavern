import { useCallback, useEffect, useRef, useState } from "react";
import {
	fetchUpdateStatus,
	resetUpdate,
	triggerUpdate,
	type RuntimeUpdatePhase,
	type RuntimeUpdateStatus,
} from "../api/runtime-api.js";
import { useT } from "../i18n/context.js";

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
export function useUpdateFlow(expectedVersion: string | null) {
	const { t } = useT();
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
					// Server process exited. If we got past "swapping", the
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
						message: t("update_modal_runtime_error_server_exited"),
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
					// The swap succeeded and the server is about to exit. There
					// is nothing left to wait for — this page is done.
					setState({ kind: "complete", newVersion: status.targetVersion ?? resolvedTarget() ?? "" });
					return;
				}

				if (status.phase === "error") {
					const err = status.error;
					if (!err) {
					setState({
						kind: "error",
						failureKind: "fatal",
						message: t("update_modal_runtime_error_unknown"),
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
		[expectedVersion, t],
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
				message: result.reason ?? t("update_modal_runtime_error_rejected"),
				phase: "idle",
				stack: null,
				raw: null,
			});
			return;
		}
		watchStatus(expectedVersion);
	}, [watchStatus, expectedVersion, t]);

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
