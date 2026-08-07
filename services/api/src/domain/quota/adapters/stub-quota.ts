/**
 * @module quota/adapters/stub
 *
 * Development-only adapter serving the end-to-end smoke test: it points at a
 * local fixture server on 127.0.0.1:8799 and parses the Z.AI response shape,
 * so the full poll → persist → transition → SSE → toast chain can be exercised
 * against a script instead of a paid account.
 *
 * Registered ONLY when `VIBE_TAVERN_QUOTA_STUB=1`. It can never resolve in a
 * production build: nothing references it unless that env var is set, and its
 * allowed origin is loopback.
 */

import { PROVIDER_QUOTA_KIND } from "@vibe-tavern/domain";
import type { QuotaCapabilityAdapter } from "../quota-capability-types.js";
import { zaiQuotaAdapter } from "./zai-quota.js";
import { assertAllowedOrigin, originOf } from "../quota-normalize.js";

export const QUOTA_STUB_ADAPTER_ID = "__quota_stub__";
const STUB_ORIGIN = "http://127.0.0.1:8799";

export const stubQuotaAdapter: QuotaCapabilityAdapter = {
	id: QUOTA_STUB_ADAPTER_ID,
	version: 1,
	kind: PROVIDER_QUOTA_KIND.windowed,
	presetIds: [],
	endpointOrigins: [STUB_ORIGIN],
	allowedRequestOrigins: [STUB_ORIGIN],
	// Short enough that a smoke test does not sit waiting five minutes.
	pollIntervalMs: 60_000,
	requestTimeoutMs: 5_000,

	buildRequests(baseUrl, apiKey) {
		return [
			assertAllowedOrigin({
				id: "usage",
				url: `${originOf(baseUrl)}/api/monitor/usage/quota/limit`,
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			}, this.allowedRequestOrigins),
		];
	},

	normalize: zaiQuotaAdapter.normalize,
};

/** Whether this process should register the stub. Read once, at registry build time. */
export function isQuotaStubEnabled(): boolean {
	return Bun.env.VIBE_TAVERN_QUOTA_STUB === "1";
}
