/**
 * @module quota/adapters/deepseek
 *
 * DeepSeek — `GET {baseUrl}/user/balance`.
 *
 * Balance-only. The response carries one entry per currency; the first is used
 * (accounts in practice have exactly one) because a snapshot holds at most one
 * `total` / `granted` / `topped_up` row and mixing currencies into those slots
 * would produce a number that means nothing.
 *
 * Every amount is a STRING in the vendor response — deliberately, so nobody
 * rounds it. They stay strings all the way to the wire.
 */

import { z } from "zod";
import {
	PROVIDER_BALANCE_KIND,
	PROVIDER_BALANCE_UNIT,
	PROVIDER_QUOTA_KIND,
	type ProviderBalanceAmount,
	type ProviderBalanceUnit,
} from "@vibe-tavern/domain";
import type { QuotaCapabilityAdapter, QuotaRequestResult } from "../quota-capability-types.js";
import {
	QuotaNormalizationError,
	assertAllowedOrigin,
	toCanonicalDecimal,
	trimTrailingSlash,
} from "../quota-normalize.js";

const BALANCE_REQUEST = "balance";
const numeric = z.union([z.number(), z.string()]);

const responseSchema = z.object({
	is_available: z.boolean().optional(),
	balance_infos: z.array(z.object({
		currency: z.string(),
		total_balance: numeric,
		granted_balance: numeric.optional(),
		topped_up_balance: numeric.optional(),
	}).passthrough()).min(1),
}).passthrough();

function unitOf(currency: string): ProviderBalanceUnit {
	const normalized = currency.trim().toUpperCase();
	if (normalized === "CNY") return PROVIDER_BALANCE_UNIT.cny;
	if (normalized === "USD") return PROVIDER_BALANCE_UNIT.usd;
	throw new QuotaNormalizationError(`Unknown DeepSeek balance currency ${currency}`);
}

export const deepseekQuotaAdapter: QuotaCapabilityAdapter = {
	id: "deepseek",
	version: 1,
	kind: PROVIDER_QUOTA_KIND.balance,
	presetIds: ["deepseek"],
	endpointOrigins: ["https://api.deepseek.com"],
	allowedRequestOrigins: ["https://api.deepseek.com"],
	pollIntervalMs: 300_000,
	requestTimeoutMs: 10_000,

	buildRequests(baseUrl, apiKey) {
		return [
			assertAllowedOrigin({
				id: BALANCE_REQUEST,
				url: `${trimTrailingSlash(baseUrl)}/user/balance`,
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			}, this.allowedRequestOrigins),
		];
	},

	normalize(results: readonly QuotaRequestResult[]) {
		const result = results.find((entry) => entry.spec.id === BALANCE_REQUEST);
		if (!result) throw new QuotaNormalizationError("DeepSeek balance response missing");

		const parsed = responseSchema.parse(result.json);
		const info = parsed.balance_infos[0]!;
		const unit = unitOf(info.currency);

		const balances: ProviderBalanceAmount[] = [{
			kind: PROVIDER_BALANCE_KIND.total,
			unit,
			amount: toCanonicalDecimal(info.total_balance),
			primary: true,
		}];
		if (info.granted_balance !== undefined) {
			balances.push({
				kind: PROVIDER_BALANCE_KIND.granted,
				unit,
				amount: toCanonicalDecimal(info.granted_balance),
				primary: false,
			});
		}
		if (info.topped_up_balance !== undefined) {
			balances.push({
				kind: PROVIDER_BALANCE_KIND.toppedUp,
				unit,
				amount: toCanonicalDecimal(info.topped_up_balance),
				primary: false,
			});
		}

		return { balances };
	},
};
