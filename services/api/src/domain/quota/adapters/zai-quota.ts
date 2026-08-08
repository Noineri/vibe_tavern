/**
 * @module quota/adapters/zai
 *
 * Z.AI (GLM Coding plans) — `GET {origin}/api/monitor/usage/quota/limit`.
 *
 * The monitor API lives on the account host, NOT under the chat path: a profile
 * pointed at `https://api.z.ai/api/paas/v4` or `.../api/coding/paas/v4` both
 * resolve to `https://api.z.ai/api/monitor/...`. The origin is derived from the
 * profile endpoint (rather than hardcoded) so the mainland `open.bigmodel.cn`
 * host works from the same adapter.
 *
 * `data.limits[]` mixes two record types. TOKENS_LIMIT records are the real
 * budgets — the shortest is the rolling session window every GLM Coding user
 * watches, the longest is the weekly/monthly one. A TIME_LIMIT record is a
 * separate vendor-named window and lands in `extra`.
 */

import { z } from "zod";
import { PROVIDER_QUOTA_KIND, PROVIDER_QUOTA_WINDOW_KIND, type ProviderQuotaWindow } from "@vibe-tavern/domain";
import type { QuotaCapabilityAdapter, QuotaRequestResult } from "../quota-capability-types.js";
import {
	QuotaNormalizationError,
	assertAllowedOrigin,
	assignDistinctWindowKinds,
	clampPercent,
	originOf,
	toCanonicalInstant,
	toNumber,
	toUsedPercent,
	windowKindForMinutes,
} from "../quota-normalize.js";

const USAGE_REQUEST = "usage";

/** Z.AI's unit enum. Values outside this set are a schema change, not a window. */
const UNIT_MINUTES: Readonly<Record<number, number>> = {
	1: 60 * 24, // days
	3: 60, // hours
	5: 1, // minutes
	6: 60 * 24 * 7, // weeks
};

const numeric = z.union([z.number(), z.string()]);

/**
 * A limit record. Only `type`/`unit`/`number` are always present: the live API
 * sends TOKENS_LIMIT records carrying nothing but `percentage`, while
 * TIME_LIMIT records carry the full ceiling/consumed/remaining triple. Both are
 * normal, so the token counts are optional and `usedPercentOf` picks whichever
 * of the two the record actually provides.
 */
const limitSchema = z.object({
	type: z.string(),
	unit: z.number(),
	number: z.number(),
	/** The window's ceiling. Absent on TOKENS_LIMIT records. */
	usage: numeric.optional(),
	/** Consumed so far. Absent on TOKENS_LIMIT records. */
	currentValue: numeric.optional(),
	remaining: numeric.optional(),
	/** Percent of the window consumed, 0..100. The only usage figure on a TOKENS_LIMIT. */
	percentage: numeric.optional(),
	/** Epoch milliseconds. */
	nextResetTime: numeric.nullable().optional(),
}).passthrough();

const responseSchema = z.object({
	code: z.number().optional(),
	success: z.boolean().optional(),
	data: z.object({
		/** Absent on some accounts — an empty limit list is a state, not a parse failure. */
		limits: z.array(limitSchema).optional(),
		// Plan-name aliases, in CodexBar's precedence order.
		planName: z.string().optional(),
		plan: z.string().optional(),
		plan_type: z.string().optional(),
		packageName: z.string().optional(),
		level: z.string().optional(),
	}).passthrough(),
}).passthrough();

type ZaiLimit = z.infer<typeof limitSchema>;
type ZaiData = z.infer<typeof responseSchema>["data"];

/** First non-blank plan name the response offers, matching CodexBar's alias order. */
function planNameOf(data: ZaiData): string | null {
	for (const candidate of [data.planName, data.plan, data.plan_type, data.packageName, data.level]) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

/**
 * How much of the window is gone, or null when the record cannot say.
 *
 * Counted fields win when they are usable — they are exact, and they are what
 * TIME_LIMIT records provide. `remaining` and `currentValue` disagree on some
 * accounts (Z.AI omits or misreports quota fields), so the larger consumed
 * figure is taken, exactly as CodexBar's `computedUsedPercent` does. Live
 * TOKENS_LIMIT records carry ONLY `percentage`, which is already a 0..100
 * figure and can fall outside that range — hence the clamp.
 */
function usedPercentOf(limit: ZaiLimit): number | null {
	const total = limit.usage === undefined ? null : toNumber(limit.usage);
	if (total !== null && total > 0) {
		const currentValue = limit.currentValue === undefined ? null : toNumber(limit.currentValue);
		const remaining = limit.remaining === undefined ? null : toNumber(limit.remaining);

		const used = remaining !== null
			? Math.max(total - remaining, currentValue ?? total - remaining)
			: currentValue;
		if (used !== null) return toUsedPercent(Math.max(0, Math.min(total, used)), total);
	}

	if (limit.percentage !== undefined) return clampPercent(toNumber(limit.percentage));
	return null;
}

const TOKENS_LIMIT = "TOKENS_LIMIT";
const TIME_LIMIT = "TIME_LIMIT";

/**
 * Window length in minutes, or null for a unit enum Z.AI has added since.
 *
 * Null drops that ONE window rather than failing the whole poll: a vendor
 * introducing a sixth unit must not blank out the windows that still parse.
 */
function durationMinutes(unit: number, count: number): number | null {
	const minutes = UNIT_MINUTES[unit];
	if (minutes === undefined || count <= 0) return null;
	return minutes * count;
}

export const zaiQuotaAdapter: QuotaCapabilityAdapter = {
	id: "zai",
	version: 1,
	kind: PROVIDER_QUOTA_KIND.windowed,
	presetIds: ["zai", "zai-coding"],
	endpointOrigins: ["https://api.z.ai", "https://open.bigmodel.cn"],
	allowedRequestOrigins: ["https://api.z.ai", "https://open.bigmodel.cn"],
	pollIntervalMs: 300_000,
	requestTimeoutMs: 10_000,

	buildRequests(baseUrl, apiKey) {
		return [
			assertAllowedOrigin({
				id: USAGE_REQUEST,
				url: `${originOf(baseUrl)}/api/monitor/usage/quota/limit`,
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			}, this.allowedRequestOrigins),
		];
	},

	normalize(results: readonly QuotaRequestResult[]) {
		const result = results.find((entry) => entry.spec.id === USAGE_REQUEST);
		if (!result) throw new QuotaNormalizationError("Z.AI quota response missing");

		const parsed = responseSchema.parse(result.json);
		const limits = parsed.data.limits ?? [];
		const planName = planNameOf(parsed.data);

		// A record whose usage cannot be read is dropped rather than rendered as a
		// fabricated 0% — an empty gauge on an exhausted plan is the worst outcome.
		const readable = limits
			.map((limit) => ({ limit, usedPercent: usedPercentOf(limit) }))
			.filter((entry): entry is { limit: ZaiLimit; usedPercent: number } => entry.usedPercent !== null);

		const tokenLimits = readable
			.filter((entry) => entry.limit.type === TOKENS_LIMIT)
			.map((entry) => ({ entry, minutes: durationMinutes(entry.limit.unit, entry.limit.number) }))
			.filter((entry): entry is { entry: typeof readable[number]; minutes: number } => entry.minutes !== null)
			.sort((a, b) => a.minutes - b.minutes);

		const timeLimits = readable.filter((entry) => entry.limit.type === TIME_LIMIT);

		const candidates = [
			...tokenLimits.map((entry) => ({ preferred: windowKindForMinutes(entry.minutes), value: entry.entry })),
			...timeLimits.map((entry) => ({ preferred: PROVIDER_QUOTA_WINDOW_KIND.extra, value: entry })),
		];

		const windows: ProviderQuotaWindow[] = assignDistinctWindowKinds(candidates).map(({ kind, value }) => ({
			kind,
			label: planName ?? value.limit.type,
			usedPercent: value.usedPercent,
			resetsAt: value.limit.nextResetTime == null ? null : toCanonicalInstant(value.limit.nextResetTime),
		}));

		return { windows };
	},
};
