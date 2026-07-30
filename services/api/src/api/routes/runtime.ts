import { Hono } from "hono";
import { getCurrentVersion } from "../../server/updater.js";
import {
	canSelfUpdate,
	detectInstallKind,
	getUpdateOrchestrator,
	type UpdateFailureKind,
	type UpdateOrchestratorPhase,
} from "../../domain/update/update-orchestrator.js";
import { currentLatestTag, getUpdateCheck } from "../../domain/update/update-check-service.js";
import type {
	RuntimeDownloadProgress,
	RuntimeInfo,
	RuntimeInstallKind,
	RuntimeTriggerResult,
	RuntimeUpdateFailure,
	RuntimeUpdateFailureKind,
	RuntimeUpdatePhase,
	RuntimeUpdateCheck,
	RuntimeUpdateStatus,
	RuntimeVersionInfo,
} from "@vibe-tavern/api-contracts";

const orchestrator = getUpdateOrchestrator();

function toWirePhase(phase: UpdateOrchestratorPhase): RuntimeUpdatePhase {
	return phase;
}

function toWireFailureKind(kind: UpdateFailureKind): RuntimeUpdateFailureKind {
	return kind;
}

export function createRuntimeRoutes() {
	return new Hono()
		.get("/api/runtime/info", (c) => {
			const installKind: RuntimeInstallKind = detectInstallKind();
			const info: RuntimeInfo = {
				currentVersion: getCurrentVersion(),
				canSelfUpdate: canSelfUpdate(),
				installKind,
			};
			return c.json(info);
		})
		.get("/api/runtime/version", (c) => {
			const payload: RuntimeVersionInfo = { version: getCurrentVersion() };
			return c.json(payload);
		})
		.get("/api/runtime/update/check", async (c) => {
			const payload: RuntimeUpdateCheck = await getUpdateCheck();
			return c.json(payload);
		})
		.post("/api/runtime/update", async (c) => {
			// The client sends the tag whose release notes it showed the user.
			// If the server has since resolved a different latest tag, refuse:
			// otherwise the modal displays the notes for one version while
			// installing another.
			const body = await c.req.json().catch(() => null);
			const requestedTag =
				typeof body === "object" && body !== null && typeof (body as { tag?: unknown }).tag === "string"
					? (body as { tag: string }).tag
					: null;

			if (requestedTag !== null) {
				const latestTag = await currentLatestTag();
				if (latestTag !== null && latestTag !== requestedTag) {
					const stale: RuntimeTriggerResult = {
						accepted: false,
						reason: `A newer release (${latestTag}) is now available. Reopen the update dialog to review it.`,
					};
					return c.json(stale, 409);
				}
			}

			const result = orchestrator.triggerUpdate();
			const payload: RuntimeTriggerResult = result;
			return c.json(payload, result.accepted ? 202 : 409);
		})
		.get("/api/runtime/update/status", (c) => {
			const s = orchestrator.getStatus();
			let downloadProgress: RuntimeDownloadProgress | null = null;
			if (s.downloadProgress) {
				downloadProgress = {
					receivedBytes: s.downloadProgress.receivedBytes,
					totalBytes: s.downloadProgress.totalBytes,
				};
			}
			let error: RuntimeUpdateFailure | null = null;
			if (s.error) {
				error = {
					kind: toWireFailureKind(s.error.kind),
					message: s.error.message,
					phase: toWirePhase(s.error.phase),
					stack: s.error.stack,
					raw: s.error.raw,
				};
			}
			const payload: RuntimeUpdateStatus = {
				phase: toWirePhase(s.phase),
				startedAt: s.startedAt,
				currentVersion: s.currentVersion,
				targetVersion: s.targetVersion,
				downloadProgress,
				error,
			};
			return c.json(payload);
		})
		.post("/api/runtime/update/reset", (c) => {
			orchestrator.reset();
			return c.json({ ok: true });
		});
}
