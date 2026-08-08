/**
 * @module quota/adapters/moonshot
 *
 * Moonshot — `GET {baseUrl}/users/me/balance`.
 *
 * Balance-only: Moonshot exposes no window and no reset boundary to a plain
 * key, so this profile can never produce a threshold notification. That is
 * enforced by the capability kind, not by a runtime check.
 *
 * The envelope reports failure IN a 200 response (`code` ≠ 0 / `status` false),
 * so the gate is on the body, not the HTTP status.
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
	originOf,
	toCanonicalDecimal,
	trimTrailingSlash,
} from "../quota-normalize.js";

const BALANCE_REQUEST = "balance";
const numeric = z.union([z.number(), z.string()]);

/**
 * Which currency the account is denominated in.
 *
 * Moonshot runs two platforms off two hosts (CodexBar's `MoonshotRegion`): the
 * China console settles in yuan, the international one in dollars. The host is
 * the only thing in the response that tells them apart — the balance payload
 * carries no currency field at all.
 */
function unitForEndpoint(baseUrl: string): ProviderBalanceUnit {
	return originOf(baseUrl).endsWith(".cn") ? PROVIDER_BALANCE_UNIT.cny : PROVIDER_BALANCE_UNIT.usd;
}

const responseSchema = z.object({
	code: z.number(),
	status: z.boolean(),
	data: z.object({
		available_balance: numeric,
		voucher_balance: numeric.optional(),
		cash_balance: numeric.optional(),
	}).passthrough(),
	scode: z.string().optional(),
	status_msg: z.string().optional(),
}).passthrough();

export const moonshotQuotaAdapter: QuotaCapabilityAdapter = {
	id: "moonshot",
	version: 1,
	kind: PROVIDER_QUOTA_KIND.balance,
	presetIds: ["moonshot"],
	endpointOrigins: ["https://api.moonshot.ai", "https://api.moonshot.cn"],
	allowedRequestOrigins: ["https://api.moonshot.ai", "https://api.moonshot.cn"],
	pollIntervalMs: 300_000,
	requestTimeoutMs: 10_000,

	buildRequests(baseUrl, apiKey) {
		return [
			assertAllowedOrigin({
				id: BALANCE_REQUEST,
				url: `${trimTrailingSlash(baseUrl)}/users/me/balance`,
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			}, this.allowedRequestOrigins),
		];
	},

	normalize(results: readonly QuotaRequestResult[]) {
		const result = results.find((entry) => entry.spec.id === BALANCE_REQUEST);
		if (!result) throw new QuotaNormalizationError("Moonshot balance response missing");

		const parsed = responseSchema.parse(result.json);
		if (parsed.code !== 0 || parsed.status !== true) {
			throw new QuotaNormalizationError(
				`Moonshot balance request reported failure (code ${parsed.code}${parsed.scode ? `, scode ${parsed.scode}` : ""})`,
			);
		}

		// The request URL is the only record of which platform answered.
		const unit = unitForEndpoint(result.spec.url);

		const balances: ProviderBalanceAmount[] = [{
			kind: PROVIDER_BALANCE_KIND.available,
			unit,
			amount: toCanonicalDecimal(parsed.data.available_balance),
			primary: true,
		}];
		if (parsed.data.voucher_balance !== undefined) {
			balances.push({
				kind: PROVIDER_BALANCE_KIND.voucher,
				unit,
				amount: toCanonicalDecimal(parsed.data.voucher_balance),
				primary: false,
			});
		}
		if (parsed.data.cash_balance !== undefined) {
			balances.push({
				kind: PROVIDER_BALANCE_KIND.cash,
				unit,
				amount: toCanonicalDecimal(parsed.data.cash_balance),
				primary: false,
			});
		}

		return { balances };
	},
};
