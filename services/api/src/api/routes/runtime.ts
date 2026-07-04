import { Hono } from "hono";
import { getCurrentVersion } from "../../server/updater.js";
import {
	canSelfUpdate,
	detectInstallKind,
	getUpdateOrchestrator,
	type UpdateFailureKind,
	type UpdateOrchestratorPhase,
} from "../../domain/update/update-orchestrator.js";
import type {
	RuntimeDownloadProgress,
	RuntimeInfo,
	RuntimeInstallKind,
	RuntimeTriggerResult,
	RuntimeUpdateFailure,
	RuntimeUpdateFailureKind,
	RuntimeUpdatePhase,
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
		.post("/api/runtime/update", (c) => {
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
