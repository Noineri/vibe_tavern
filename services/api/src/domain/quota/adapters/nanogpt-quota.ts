/**
 * @module quota/adapters/nanogpt
 *
 * NanoGPT — the only adapter that needs TWO requests:
 *   `GET  https://nano-gpt.com/api/subscription/v1/usage`  → daily + monthly windows
 *   `POST https://nano-gpt.com/api/check-balance`          → USD balance
 *
 * Both live off the account host, not under the OpenAI-compatible `/api/v1`
 * chat path, so the URLs are fixed rather than derived. The balance is folded
 * into the WINDOWED snapshot's optional `balances` — NanoGPT users have both a
 * subscription and a wallet, and hiding one of them would be a lie.
 *
 * `percentUsed` is a fraction (0..1), not a percentage.
 */

import { z } from "zod";
import {
	PROVIDER_BALANCE_KIND,
	PROVIDER_BALANCE_UNIT,
	PROVIDER_QUOTA_KIND,
	PROVIDER_QUOTA_WINDOW_KIND,
	type ProviderBalanceAmount,
	type ProviderQuotaWindow,
	type ProviderQuotaWindowKind,
} from "@vibe-tavern/domain";
import type { QuotaCapabilityAdapter, QuotaRequestResult } from "../quota-capability-types.js";
import {
	QuotaNormalizationError,
	assertAllowedOrigin,
	assignDistinctWindowKinds,
	clampPercent,
	toCanonicalDecimal,
	toCanonicalInstant,
	toNumber,
} from "../quota-normalize.js";

const USAGE_REQUEST = "usage";
const BALANCE_REQUEST = "balance";
const ORIGIN = "https://nano-gpt.com";

const numeric = z.union([z.number(), z.string()]);

const windowSchema = z.object({
	used: numeric.optional(),
	remaining: numeric.optional(),
	/** Fraction of the window consumed, 0..1. */
	percentUsed: numeric,
	/** Epoch milliseconds. */
	resetAt: z.union([z.number(), z.string()]).nullable().optional(),
}).passthrough();

/**
 * The subscription response names each window after what it meters, and sends
 * `null` for the ones the account's plan does not have (a weekly-token plan
 * reports `dailyInputTokens: null`). A pay-as-you-go key has no windows at all
 * and only a wallet — which is a complete answer, not a failure.
 */
const usageSchema = z.object({
	dailyInputTokens: windowSchema.nullish(),
	weeklyInputTokens: windowSchema.nullish(),
	dailyImages: windowSchema.nullish(),
}).passthrough();

const balanceSchema = z.object({
	usd_balance: numeric.optional(),
	nano_balance: numeric.optional(),
}).passthrough();

type NanoWindow = z.infer<typeof windowSchema>;

/** A window plus the vendor-facing name it is known by, carried through kind assignment. */
interface LabelledWindow {
	readonly label: string;
	readonly raw: NanoWindow;
}

function toWindow(kind: ProviderQuotaWindowKind, label: string, raw: NanoWindow): ProviderQuotaWindow {
	return {
		kind,
		label,
		usedPercent: clampPercent(toNumber(raw.percentUsed) * 100),
		resetsAt: raw.resetAt == null ? null : toCanonicalInstant(raw.resetAt),
	};
}

export const nanogptQuotaAdapter: QuotaCapabilityAdapter = {
	id: "nanogpt",
	version: 1,
	kind: PROVIDER_QUOTA_KIND.windowed,
	presetIds: ["nanogpt"],
	endpointOrigins: [ORIGIN],
	allowedRequestOrigins: [ORIGIN],
	pollIntervalMs: 300_000,
	requestTimeoutMs: 10_000,

	buildRequests(_baseUrl, apiKey) {
		return [
			assertAllowedOrigin({
				id: USAGE_REQUEST,
				url: `${ORIGIN}/api/subscription/v1/usage`,
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			}, this.allowedRequestOrigins),
			assertAllowedOrigin({
				id: BALANCE_REQUEST,
				url: `${ORIGIN}/api/check-balance`,
				method: "POST",
				headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
				body: "{}",
			}, this.allowedRequestOrigins),
		];
	},

	normalize(results: readonly QuotaRequestResult[]) {
		const usageResult = results.find((entry) => entry.spec.id === USAGE_REQUEST);
		if (!usageResult) throw new QuotaNormalizationError("NanoGPT usage response missing");

		const usage = usageSchema.parse(usageResult.json);
		const candidates: { preferred: ProviderQuotaWindowKind; value: LabelledWindow }[] = [];
		if (usage.dailyInputTokens) {
			candidates.push({
				preferred: PROVIDER_QUOTA_WINDOW_KIND.daily,
				value: { label: "Daily input tokens", raw: usage.dailyInputTokens },
			});
		}
		if (usage.weeklyInputTokens) {
			candidates.push({
				preferred: PROVIDER_QUOTA_WINDOW_KIND.weekly,
				value: { label: "Weekly input tokens", raw: usage.weeklyInputTokens },
			});
		}
		// Images share the daily boundary with the token window; when both exist the
		// collision resolver files this one under `extra`.
		if (usage.dailyImages) {
			candidates.push({
				preferred: PROVIDER_QUOTA_WINDOW_KIND.daily,
				value: { label: "Daily images", raw: usage.dailyImages },
			});
		}

		const windows: ProviderQuotaWindow[] = assignDistinctWindowKinds(candidates)
			.map(({ kind, value }) => toWindow(kind, value.label, value.raw));

		const balanceResult = results.find((entry) => entry.spec.id === BALANCE_REQUEST);
		const balances: ProviderBalanceAmount[] = [];
		if (balanceResult) {
			const parsed = balanceSchema.parse(balanceResult.json);
			if (parsed.usd_balance !== undefined) {
				balances.push({
					kind: PROVIDER_BALANCE_KIND.available,
					unit: PROVIDER_BALANCE_UNIT.usd,
					amount: toCanonicalDecimal(parsed.usd_balance),
					primary: true,
				});
			}
		}

		// A key with no subscription windows AND no wallet told us nothing — that is
		// a schema surprise. Either one alone is a complete, displayable answer.
		if (windows.length === 0 && balances.length === 0) {
			throw new QuotaNormalizationError("NanoGPT reported neither a usage window nor a balance");
		}

		return balances.length > 0 ? { windows, balances } : { windows };
	},
};
