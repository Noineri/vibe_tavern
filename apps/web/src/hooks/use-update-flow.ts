import { useCallback, useEffect, useRef, useState } from "react";
import {
	fetchRuntimeVersion,
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
	| { kind: "reconnecting"; newVersion: string }
	| { kind: "complete"; newVersion: string; reconnected: boolean }
	| { kind: "error"; failureKind: "soft" | "fatal"; message: string; phase: RuntimeUpdatePhase; stack: string | null; raw: string | null };

const INITIAL: UpdateModalState = { kind: "idle" };

const STATUS_POLL_INTERVAL_MS = 500;

/** How long to wait for the relaunched build to answer before giving up. */
const RECONNECT_TIMEOUT_MS = 45_000;
const RECONNECT_POLL_INTERVAL_MS = 750;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives the modal state machine.
 *
 * `expectedVersion` is the version we EXPECT to see after the update, threaded
 * through the orchestrator's targetVersion and shown as the "Updated to X.X.X"
 * text.
 *
 * Once the swap succeeds the server stops serving and relaunches the new build,
 * so the connection drops BY DESIGN. That is not an error: the flow moves to
 * "reconnecting" and polls /api/runtime/version until the new build answers.
 * Reaching "complete" with reconnected=true means a reload will land on a
 * working page; reconnected=false means the update succeeded but the app has to
 * be started by hand.
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

	/**
	 * Wait for the relaunched server to come back.
	 *
	 * The old build exits on purpose right after the swap, so connection errors
	 * here are expected and are not a failure — they are what "restarting"
	 * looks like from the browser. Only the timeout is a real answer, and even
	 * then the update itself succeeded; the user just has to start the app
	 * themselves.
	 */
	const awaitReconnect = useCallback(async (newVersion: string) => {
		setState({ kind: "reconnecting", newVersion });
		const deadline = Date.now() + RECONNECT_TIMEOUT_MS;

		while (Date.now() < deadline) {
			if (stopFlagRef.current) return;
			await sleep(RECONNECT_POLL_INTERVAL_MS);
			if (stopFlagRef.current) return;
			try {
				const info = await fetchRuntimeVersion();
				// Any answer means a server is serving again. Prefer to confirm
				// it is the NEW one, but do not hang on a version string that
				// might legitimately differ (e.g. a dev build).
				if (!newVersion || info.version === newVersion) {
					setState({ kind: "complete", newVersion: info.version || newVersion, reconnected: true });
					return;
				}
			} catch {
				// Server still down — that is the normal case while it restarts.
			}
		}

		setState({ kind: "complete", newVersion, reconnected: false });
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
					if (last === "swapping" || last === "done" || last === "spawning-restart" || last === "exiting") {
						// Expected: the old build stopped serving so the new one
						// could take the port. Wait for it rather than declaring
						// the flow over.
						void awaitReconnect(resolvedTarget() ?? "");
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

				if (status.phase === "done" || status.phase === "spawning-restart" || status.phase === "exiting") {
					// The swap succeeded. The server is about to hand over to the
					// new build, so start waiting for it to answer.
					void awaitReconnect(status.targetVersion ?? resolvedTarget() ?? "");
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
		[expectedVersion, t, awaitReconnect],
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
