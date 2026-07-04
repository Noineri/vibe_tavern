import type {
	RuntimeDownloadProgress,
	RuntimeInfo,
	RuntimeTriggerResult,
	RuntimeUpdateFailure,
	RuntimeUpdatePhase,
	RuntimeUpdateStatus,
	RuntimeVersionInfo,
} from "@vibe-tavern/api-contracts";
import { getGatewayBaseUrl, getMobileToken } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

function url(path: string): string {
	return appendTokenQuery(`${getGatewayBaseUrl()}${path}`);
}

function authHeaders(): HeadersInit | undefined {
	const token = getMobileToken();
	return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export interface RuntimeInfoWithUi extends RuntimeInfo {}
export interface RuntimeUpdateStatusWithUi extends RuntimeUpdateStatus {}
export interface RuntimeVersionInfoWithUi extends RuntimeVersionInfo {}
export interface RuntimeTriggerResultWithUi extends RuntimeTriggerResult {}

export type {
	RuntimeDownloadProgress,
	RuntimeInfo,
	RuntimeTriggerResult,
	RuntimeUpdateFailure,
	RuntimeUpdatePhase,
	RuntimeUpdateStatus,
	RuntimeVersionInfo,
};

export async function fetchRuntimeInfo(): Promise<RuntimeInfo> {
	const resp = await fetch(url("/api/runtime/info"), { headers: authHeaders() });
	if (!resp.ok) throw new Error(`runtime/info: HTTP ${resp.status}`);
	return (await resp.json()) as RuntimeInfo;
}

export async function fetchRuntimeVersion(): Promise<RuntimeVersionInfo> {
	const resp = await fetch(url("/api/runtime/version"), { headers: authHeaders() });
	if (!resp.ok) throw new Error(`runtime/version: HTTP ${resp.status}`);
	return (await resp.json()) as RuntimeVersionInfo;
}

export async function triggerUpdate(): Promise<RuntimeTriggerResult> {
	const resp = await fetch(url("/api/runtime/update"), {
		method: "POST",
		headers: { ...authHeaders() },
	});
	if (!resp.ok && resp.status !== 409) {
		throw new Error(`runtime/update: HTTP ${resp.status}`);
	}
	return (await resp.json()) as RuntimeTriggerResult;
}

export async function resetUpdate(): Promise<void> {
	const resp = await fetch(url("/api/runtime/update/reset"), {
		method: "POST",
		headers: { ...authHeaders() },
	});
	if (!resp.ok) throw new Error(`runtime/update/reset: HTTP ${resp.status}`);
}

export async function fetchUpdateStatus(): Promise<RuntimeUpdateStatus> {
	const resp = await fetch(url("/api/runtime/update/status"), { headers: authHeaders() });
	if (!resp.ok) throw new Error(`runtime/update/status: HTTP ${resp.status}`);
	return (await resp.json()) as RuntimeUpdateStatus;
}

