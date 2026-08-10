/**
 * @module quota-normalize
 *
 * Shared conversions every adapter needs: vendor numbers → canonical decimal
 * strings, vendor timestamps → canonical UTC instants, window durations →
 * window kinds, and the origin allowlist assertion that guards every built URL.
 *
 * All of these throw on garbage rather than returning a plausible zero. A quota
 * display that silently reads 0% used is worse than no display at all: the
 * polling service catches the throw, records a `schema` error, and the user can
 * see that something is wrong.
 */

import { PROVIDER_QUOTA_WINDOW_KIND, type ProviderQuotaWindowKind } from "@vibe-tavern/domain";
import type { QuotaRequestSpec } from "./quota-capability-types.js";

/** Above this a double can no longer represent whole units exactly — refuse rather than lie. */
const MAX_SAFE_MONEY = 1e15;
const CANONICAL_DECIMAL = /^-?(0|[1-9]\d*)(\.\d{1,8})?$/;

export class QuotaNormalizationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QuotaNormalizationError";
	}
}

/**
 * Vendor money → canonical decimal string.
 *
 * Strings pass through when already canonical (DeepSeek and Kimi send strings
 * precisely so nobody rounds them). Numbers are rendered at 8 fractional digits
 * and trimmed, which is what erases float artifacts: a `total_credits -
 * total_usage` subtraction landing on `0.30000000000000004` becomes `"0.3"`.
 */
export function toCanonicalDecimal(value: string | number): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		const normalized = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
		if (CANONICAL_DECIMAL.test(normalized)) return stripNegativeZero(normalized);
		// Vendors do send "0100.50" and ".5" — reparse rather than reject.
		const asNumber = Number(normalized);
		if (normalized === "" || !Number.isFinite(asNumber)) {
			throw new QuotaNormalizationError(`Not a decimal amount: ${JSON.stringify(value)}`);
		}
		return toCanonicalDecimal(asNumber);
	}

	if (!Number.isFinite(value) || Math.abs(value) >= MAX_SAFE_MONEY) {
		throw new QuotaNormalizationError(`Amount out of representable range: ${value}`);
	}
	const fixed = value.toFixed(8);
	const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
	return stripNegativeZero(trimmed);
}

function stripNegativeZero(value: string): string {
	return /^-0(\.0+)?$/.test(value) ? "0" : value;
}

/**
 * Vendor timestamp → canonical UTC ISO-8601 with millisecond precision.
 *
 * Accepts epoch milliseconds (Z.AI `nextResetTime`, NanoGPT `resetAt`), epoch
 * seconds, and ISO-8601 with or without fractional seconds or an offset (Kimi
 * `resetTime`). Everything funnels through `Date` so the emitted string is
 * always exactly what `toISOString()` produces.
 */
export function toCanonicalInstant(value: string | number): string {
	const date = typeof value === "number" ? new Date(fromEpoch(value)) : parseInstantString(value);
	if (Number.isNaN(date.getTime())) {
		throw new QuotaNormalizationError(`Not a timestamp: ${JSON.stringify(value)}`);
	}
	return date.toISOString();
}

function parseInstantString(value: string): Date {
	const trimmed = value.trim();
	if (/^-?\d+$/.test(trimmed)) return new Date(fromEpoch(Number(trimmed)));
	return new Date(trimmed);
}

/** Epoch seconds and epoch milliseconds are told apart by magnitude, as everywhere else. */
function fromEpoch(value: number): number {
	return Math.abs(value) < 1e11 ? value * 1000 : value;
}

/**
 * Vendor usage → 0..100, clamped. A vendor reporting 103% is at its limit, not broken.
 *
 * Scaling BEFORE dividing keeps whole-number ratios whole: `55/100*100` lands on
 * 55.00000000000001 in binary floating point, `55*100/100` on 55. The values end
 * up in event payloads and deterministic event ids, so the artifact is not only
 * ugly — it is a difference that would print.
 */
export function toUsedPercent(used: number, limit: number): number {
	if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
		throw new QuotaNormalizationError(`Cannot derive a percentage from used=${used} limit=${limit}`);
	}
	return clampPercent((used * 100) / limit);
}

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		throw new QuotaNormalizationError(`Not a percentage: ${value}`);
	}
	return Math.min(100, Math.max(0, value));
}

/** Vendor numeric-as-string → number, rejecting the empty strings vendors love to send. */
export function toNumber(value: string | number): number {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new QuotaNormalizationError(`Not a number: ${value}`);
		return value;
	}
	const trimmed = value.trim();
	const parsed = Number(trimmed);
	if (trimmed === "" || !Number.isFinite(parsed)) {
		throw new QuotaNormalizationError(`Not a number: ${JSON.stringify(value)}`);
	}
	return parsed;
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * Window duration → the closed set of window kinds.
 *
 * Vendors describe their windows in their own units (Z.AI's unit enum, Kimi's
 * duration + TIME_UNIT); everything below a day is the "session" window users
 * think of as their short rolling budget.
 */
export function windowKindForMinutes(minutes: number): ProviderQuotaWindowKind {
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new QuotaNormalizationError(`Not a window duration: ${minutes}`);
	}
	if (minutes < MINUTES_PER_DAY) return PROVIDER_QUOTA_WINDOW_KIND.session;
	if (minutes <= MINUTES_PER_DAY * 2) return PROVIDER_QUOTA_WINDOW_KIND.daily;
	if (minutes <= MINUTES_PER_DAY * 10) return PROVIDER_QUOTA_WINDOW_KIND.weekly;
	if (minutes <= MINUTES_PER_DAY * 45) return PROVIDER_QUOTA_WINDOW_KIND.monthly;
	return PROVIDER_QUOTA_WINDOW_KIND.extra;
}

/**
 * Resolve collisions so a snapshot never carries two windows of the same kind.
 *
 * The preferred kind wins for the first claimant (shortest window first, which
 * is the one users watch); a later claimant falls back to `extra`, and anything
 * still colliding is dropped rather than corrupting the snapshot.
 */
export function assignDistinctWindowKinds<T>(
	candidates: readonly { preferred: ProviderQuotaWindowKind; value: T }[],
): { kind: ProviderQuotaWindowKind; value: T }[] {
	const taken = new Set<ProviderQuotaWindowKind>();
	const assigned: { kind: ProviderQuotaWindowKind; value: T }[] = [];
	for (const candidate of candidates) {
		const kind = taken.has(candidate.preferred) ? PROVIDER_QUOTA_WINDOW_KIND.extra : candidate.preferred;
		if (taken.has(kind)) continue;
		taken.add(kind);
		assigned.push({ kind, value: candidate.value });
	}
	return assigned;
}

/**
 * Assert every built request stays on a host the adapter vouches for.
 *
 * The threat is concrete: profile endpoints are user-editable, and an adapter
 * that derives its URL from the endpoint would happily send the profile's API
 * key wherever that endpoint points. Resolution by origin means a hostile URL
 * would not even match an adapter — but a hostile *preset+endpoint combination*
 * (preset `zai`, endpoint `https://evil.example`) would, so the check lives
 * here, at the last point before the URL is used.
 */
export function assertAllowedOrigin(spec: QuotaRequestSpec, allowedOrigins: readonly string[]): QuotaRequestSpec {
	let origin: string;
	try {
		origin = new URL(spec.url).origin;
	} catch {
		throw new QuotaNormalizationError(`Quota request URL is not a URL: ${spec.url}`);
	}
	if (!allowedOrigins.includes(origin)) {
		throw new QuotaNormalizationError(
			`Quota request origin ${origin} is not allowed for this adapter (allowed: ${allowedOrigins.join(", ")})`,
		);
	}
	return spec;
}

/** `https://api.z.ai/api/paas/v4` → `https://api.z.ai`. */
export function originOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		throw new QuotaNormalizationError(`Provider endpoint is not a URL: ${baseUrl}`);
	}
}

/** `https://api.deepseek.com/` → `https://api.deepseek.com` (vendors' trailing slashes vary). */
export function trimTrailingSlash(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}
