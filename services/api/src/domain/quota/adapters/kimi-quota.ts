/**
 * @module quota/adapters/kimi
 *
 * Kimi coding API — `GET {baseUrl}/usages` with the plain API key.
 *
 * Only the code API is supported; Kimi's web mode authenticates with a session
 * cookie, which is a different credential class and explicitly out of scope.
 *
 * Shape, verified against a live response and against CodexBar's `KimiModels` /
 * `KimiUsageSnapshot`:
 *
 *   { usage:  { limit, used?, remaining?, resetTime? },      ← the WEEKLY quota
 *     limits: [{ window: { duration, timeUnit }, detail }] } ← rate windows
 *
 * Two traps live here. The top-level `usage` object IS the weekly quota (it has
 * no declared window, so the duration is supplied) — reading only `limits[]`
 * loses the number the user actually cares about. And `used` is OPTIONAL: a
 * fresh rate window arrives as `{ limit, remaining }` with no `used` at all, so
 * the consumed amount has to be derived from whichever pair is present.
 */

import { z } from "zod";
import { PROVIDER_QUOTA_KIND, type ProviderQuotaWindow, type ProviderQuotaWindowKind } from "@vibe-tavern/domain";
import type { QuotaCapabilityAdapter, QuotaRequestResult } from "../quota-capability-types.js";
import {
	QuotaNormalizationError,
	assertAllowedOrigin,
	assignDistinctWindowKinds,
	toCanonicalInstant,
	toNumber,
	toUsedPercent,
	trimTrailingSlash,
	windowKindForMinutes,
} from "../quota-normalize.js";

const USAGE_REQUEST = "usages";

const TIME_UNIT_MINUTES: Readonly<Record<string, number>> = {
	TIME_UNIT_MINUTE: 1,
	TIME_UNIT_HOUR: 60,
	TIME_UNIT_DAY: 60 * 24,
	TIME_UNIT_WEEK: 60 * 24 * 7,
	TIME_UNIT_MONTH: 60 * 24 * 30,
};

/** The window the undeclared top-level `usage` object describes (CodexBar: `weeklyWindowMinutes`). */
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
/** Fallback for a rate window whose `timeUnit` we do not recognize (CodexBar: `sessionWindowMinutes`). */
const SESSION_WINDOW_MINUTES = 5 * 60;

const numeric = z.union([z.number(), z.string()]);
const instant = z.union([z.number(), z.string()]).nullable().optional();

const detailSchema = z.object({
	limit: numeric,
	/** Absent on a window that has not been touched yet — derive it from `remaining`. */
	used: numeric.optional(),
	remaining: numeric.optional(),
	// The same field under every spelling Kimi has been seen to use.
	resetTime: instant,
	resetAt: instant,
	reset_time: instant,
	reset_at: instant,
}).passthrough();

const rateLimitSchema = z.object({
	window: z.object({
		duration: numeric,
		timeUnit: z.string(),
	}).passthrough(),
	detail: detailSchema,
	name: z.string().optional(),
}).passthrough();

const responseSchema = z.object({
	/** The weekly quota. Present on both Kimi usage endpoints. */
	usage: detailSchema.optional(),
	limits: z.array(rateLimitSchema).optional(),
}).passthrough();

type KimiDetail = z.infer<typeof detailSchema>;
type KimiRateLimit = z.infer<typeof rateLimitSchema>;

function resetOf(detail: KimiDetail): string | null {
	const raw = detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at;
	return raw == null ? null : toCanonicalInstant(raw);
}

/**
 * How much of a window is consumed, or null when the vendor's counters cannot
 * say. `used` is authoritative (it may exceed the limit during overage);
 * otherwise `remaining` gives it, but only when it describes a valid balance —
 * a `remaining` outside `0..limit` is a vendor bug, and inventing 0% from it
 * would render a full gauge for an exhausted window.
 */
function usedPercentOf(detail: KimiDetail): number | null {
	const limit = toNumber(detail.limit);
	if (!(limit > 0)) return null;

	if (detail.used !== undefined) {
		const used = toNumber(detail.used);
		if (used >= 0) return toUsedPercent(used, limit);
	}
	if (detail.remaining !== undefined) {
		const remaining = toNumber(detail.remaining);
		if (remaining >= 0 && remaining <= limit) return toUsedPercent(limit - remaining, limit);
	}
	return null;
}

/** Declared window length in minutes, falling back to the session window for an unknown unit. */
function durationMinutes(limit: KimiRateLimit): number {
	const perUnit = TIME_UNIT_MINUTES[limit.window.timeUnit];
	if (perUnit === undefined) return SESSION_WINDOW_MINUTES;
	const minutes = perUnit * toNumber(limit.window.duration);
	return minutes > 0 ? minutes : SESSION_WINDOW_MINUTES;
}

function labelOf(minutes: number, name?: string): string {
	if (name) return name;
	if (minutes < 60) return `${minutes} min`;
	const hours = minutes / 60;
	if (hours < 24) return `${hours} h`;
	return `${minutes / (60 * 24)} d`;
}

interface KimiCandidate {
	readonly detail: KimiDetail;
	readonly label: string;
	readonly minutes: number;
}

export const kimiQuotaAdapter: QuotaCapabilityAdapter = {
	id: "kimi",
	version: 2,
	kind: PROVIDER_QUOTA_KIND.windowed,
	presetIds: ["kimi"],
	endpointOrigins: ["https://api.kimi.com"],
	allowedRequestOrigins: ["https://api.kimi.com"],
	pollIntervalMs: 300_000,
	requestTimeoutMs: 10_000,

	buildRequests(baseUrl, apiKey) {
		return [
			assertAllowedOrigin({
				id: USAGE_REQUEST,
				url: `${trimTrailingSlash(baseUrl)}/usages`,
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			}, this.allowedRequestOrigins),
		];
	},

	normalize(results: readonly QuotaRequestResult[]) {
		const result = results.find((entry) => entry.spec.id === USAGE_REQUEST);
		if (!result) throw new QuotaNormalizationError("Kimi usage response missing");

		const parsed = responseSchema.parse(result.json);

		const candidates: KimiCandidate[] = [];
		if (parsed.usage) {
			candidates.push({ detail: parsed.usage, label: "Weekly", minutes: WEEKLY_WINDOW_MINUTES });
		}
		for (const limit of parsed.limits ?? []) {
			const minutes = durationMinutes(limit);
			candidates.push({ detail: limit.detail, label: labelOf(minutes, limit.name), minutes });
		}
		if (candidates.length === 0) {
			throw new QuotaNormalizationError("Kimi usage response carried neither a usage quota nor a rate window");
		}

		// Shortest first, so the window a user watches minute to minute claims its
		// preferred kind before a longer one can collide with it.
		const usable = candidates
			.map((candidate) => ({ candidate, usedPercent: usedPercentOf(candidate.detail) }))
			.filter((entry): entry is { candidate: KimiCandidate; usedPercent: number } => entry.usedPercent !== null)
			.sort((a, b) => a.candidate.minutes - b.candidate.minutes);

		if (usable.length === 0) {
			throw new QuotaNormalizationError("No Kimi window reported a usable limit/used pair");
		}

		const assigned: { kind: ProviderQuotaWindowKind; value: typeof usable[number] }[] = assignDistinctWindowKinds(
			usable.map((entry) => ({ preferred: windowKindForMinutes(entry.candidate.minutes), value: entry })),
		);

		const windows: ProviderQuotaWindow[] = assigned.map(({ kind, value }) => ({
			kind,
			label: value.candidate.label,
			usedPercent: value.usedPercent,
			resetsAt: resetOf(value.candidate.detail),
		}));

		return { windows };
	},
};
