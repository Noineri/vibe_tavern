/**
 * @module providers/probe-helpers
 *
 * Shared probe-response interpreter extracted from `protocol-registry.ts`.
 * The OpenAI-compatible / Google / Anthropic probes differ only in the JSON
 * shape (where the model list lives) and which statuses count as auth
 * failures (Google also treats 400 as auth-rejected), so they share this one
 * interpreter.
 */

import type { ProviderProbeResult } from "./provider-transport.js";

/**
 * Interpret a probe /models response into a {@link ProviderProbeResult}.
 * Shared by the OpenAI-compatible / Google / Anthropic probes, which differ
 * only in the JSON shape (where the model list lives) and which statuses count
 * as auth failures (Google also treats 400 as auth-rejected).
 */
export async function interpretProbeResponse(
	response: Response,
	readModelCount: (payload: unknown) => number | undefined,
	authStatuses: number[] = [401, 403],
): Promise<ProviderProbeResult> {
	if (response.ok) {
		let modelCount: number | undefined;
		try {
			modelCount = readModelCount(await response.json());
		} catch {
			modelCount = undefined;
		}
		return { success: true, modelCount };
	}
	if (authStatuses.includes(response.status)) {
		return {
			success: false,
			error: `Authentication rejected (${response.status} ${response.statusText}).`,
		};
	}
	if (response.status === 404) {
		return { success: false, error: "Provider does not expose a /models endpoint." };
	}
	return { success: false, error: `Probe failed: ${response.status} ${response.statusText}` };
}
