/**
 * @module quota/adapters/openrouter
 *
 * OpenRouter — two requests:
 *   `GET {baseUrl}/key`     → the key's spend cap and spend so far
 *   `GET {baseUrl}/credits` → the account's remaining credits
 *
 * Classified WINDOWED rather than balance because the spend cap behaves like a
 * quota window in every way except one: it has no reset boundary, ever. That is
 * modelled honestly as `resetsAt: null`, which switches the state machine over
 * to hysteresis re-arming instead of reset detection.
 *
 * A key with no spend cap yields ZERO windows. That is a legitimate state, not
 * an error — the account simply has nothing to run out of, and the balance is
 * still reported.
 */

import { z } from "zod";
import {
	PROVIDER_BALANCE_KIND,
	PROVIDER_BALANCE_UNIT,
	PROVIDER_QUOTA_KIND,
	PROVIDER_QUOTA_WINDOW_KIND,
	type ProviderQuotaWindow,
} from "@vibe-tavern/domain";
import type { QuotaCapabilityAdapter, QuotaRequestResult } from "../quota-capability-types.js";
import {
	QuotaNormalizationError,
	assertAllowedOrigin,
	toCanonicalDecimal,
	toNumber,
	toUsedPercent,
	trimTrailingSlash,
} from "../quota-normalize.js";

const KEY_REQUEST = "key";
const CREDITS_REQUEST = "credits";
const numeric = z.union([z.number(), z.string()]);

const keySchema = z.object({
	data: z.object({
		label: z.string().optional(),
		limit: numeric.nullable().optional(),
		usage: numeric.optional(),
		limit_remaining: numeric.nullable().optional(),
		/** "daily" / "weekly" / "monthly" — names which usage bucket the cap is measured over. */
		limit_reset: z.string().nullable().optional(),
		usage_daily: numeric.nullable().optional(),
		usage_weekly: numeric.nullable().optional(),
		usage_monthly: numeric.nullable().optional(),
		is_free_tier: z.boolean().optional(),
	}).passthrough(),
}).passthrough();

type OpenRouterKeyData = z.infer<typeof keySchema>["data"];

const creditsSchema = z.object({
	data: z.object({
		total_credits: numeric,
		total_usage: numeric,
	}).passthrough(),
}).passthrough();

function optionalNumber(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const parsed = toNumber(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Spend against the key's cap, or null when the key has no usable cap.
 *
 * Mirrors CodexBar's `keyUsedPercent`: `limit_remaining` is authoritative when
 * the server sends it (and may go negative on an overspent key, which clamps to
 * a full bar rather than a nonsense one). Without it, the usage figure has to
 * match the cap's window — charging a daily cap with the account's cumulative
 * spend would read as permanently exhausted — so `limit_reset` selects the
 * bucket, and only a cap with no declared window falls back to `usage`.
 */
function keyUsedPercent(data: OpenRouterKeyData): number | null {
	const limit = optionalNumber(data.limit);
	if (limit === null || limit <= 0) return null;

	const remaining = optionalNumber(data.limit_remaining);
	if (remaining !== null) {
		return toUsedPercent(limit - Math.min(limit, Math.max(0, remaining)), limit);
	}

	const windowed = {
		daily: data.usage_daily,
		weekly: data.usage_weekly,
		monthly: data.usage_monthly,
	}[data.limit_reset?.trim().toLowerCase() ?? ""];

	const used = optionalNumber(windowed) ?? optionalNumber(data.usage);
	if (used === null || used < 0) return null;
	return toUsedPercent(Math.min(limit, used), limit);
}

export const openrouterQuotaAdapter: QuotaCapabilityAdapter = {
	id: "openrouter",
	version: 1,
	kind: PROVIDER_QUOTA_KIND.windowed,
	presetIds: ["openrouter"],
	endpointOrigins: ["https://openrouter.ai"],
	allowedRequestOrigins: ["https://openrouter.ai"],
	pollIntervalMs: 300_000,
	requestTimeoutMs: 10_000,

	buildRequests(baseUrl, apiKey) {
		const base = trimTrailingSlash(baseUrl);
		const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
		return [
			assertAllowedOrigin({ id: KEY_REQUEST, url: `${base}/key`, method: "GET", headers }, this.allowedRequestOrigins),
			assertAllowedOrigin({ id: CREDITS_REQUEST, url: `${base}/credits`, method: "GET", headers }, this.allowedRequestOrigins),
		];
	},

	normalize(results: readonly QuotaRequestResult[]) {
		const keyResult = results.find((entry) => entry.spec.id === KEY_REQUEST);
		if (!keyResult) throw new QuotaNormalizationError("OpenRouter key response missing");

		const key = keySchema.parse(keyResult.json);
		const windows: ProviderQuotaWindow[] = [];
		const usedPercent = keyUsedPercent(key.data);
		if (usedPercent !== null) {
			windows.push({
				kind: PROVIDER_QUOTA_WINDOW_KIND.spendLimit,
				label: key.data.label ?? "Key limit",
				usedPercent,
				resetsAt: null,
			});
		}

		const creditsResult = results.find((entry) => entry.spec.id === CREDITS_REQUEST);
		if (!creditsResult) return { windows };

		const credits = creditsSchema.parse(creditsResult.json);
		// Clamped at zero like CodexBar's `balance`: a negative "remaining credits"
		// is an overspent account, not money the user has.
		const remaining = Math.max(0, toNumber(credits.data.total_credits) - toNumber(credits.data.total_usage));
		return {
			windows,
			balances: [{
				kind: PROVIDER_BALANCE_KIND.credits,
				unit: PROVIDER_BALANCE_UNIT.credits,
				amount: toCanonicalDecimal(remaining),
				primary: true,
			}],
		};
	},
};
