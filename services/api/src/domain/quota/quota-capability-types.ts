/**
 * @module quota-capability-types
 *
 * The contract every quota adapter implements, mirroring the `vendor-registry`
 * idiom: one small typed module per vendor owning everything vendor-specific,
 * so adding a provider is one module + one registry entry + one fixture test —
 * never an edit to the polling service.
 *
 * A declarative JSON-path descriptor DSL was considered and rejected: the six
 * verified vendor responses disagree on nesting, on numeric type (string vs
 * number), on timestamp encoding (epoch ms vs ISO), on how many requests are
 * needed, and on whether a window has a reset at all. Any DSL general enough
 * would just be code with worse types.
 */

import {
	PROVIDER_QUOTA_KIND,
	type ProviderBalanceAmount,
	type ProviderQuotaKind,
	type ProviderQuotaNoneReason,
	type ProviderQuotaWindow,
} from "@vibe-tavern/domain";

/**
 * Exactly what `JSON.parse` can produce. This is the honest type of a vendor
 * body before its adapter's Zod schema has looked at it — precise enough to
 * index and narrow, unlike an escape hatch.
 */
export type QuotaResponseJson =
	| string
	| number
	| boolean
	| null
	| QuotaResponseJson[]
	| { [key: string]: QuotaResponseJson };

/** One outbound HTTP request an adapter needs. Built fresh per poll. */
export interface QuotaRequestSpec {
	/** Stable within an adapter — `normalize` uses it to tell its results apart. */
	readonly id: string;
	readonly url: string;
	readonly method: "GET" | "POST";
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
}

export interface QuotaRequestResult {
	readonly spec: QuotaRequestSpec;
	readonly json: QuotaResponseJson;
}

/** What an adapter produces from a complete set of responses. */
export interface QuotaNormalizedReading {
	/**
	 * Present for windowed adapters. MAY be empty — an OpenRouter key with no
	 * spend cap configured genuinely has no window, and that is not an error.
	 */
	readonly windows?: readonly ProviderQuotaWindow[];
	readonly balances?: readonly ProviderBalanceAmount[];
}

/** The kinds an adapter can have. `none` is data, not an adapter. */
export type PollableQuotaKind =
	| typeof PROVIDER_QUOTA_KIND.windowed
	| typeof PROVIDER_QUOTA_KIND.balance;

/** A vendor we can actually poll. */
export interface QuotaCapabilityAdapter {
	readonly id: string;
	/** Bump when normalization changes — the state machine re-baselines on a version change. */
	readonly version: number;
	readonly kind: PollableQuotaKind;
	/** Preset ids this adapter serves. First resolution key. */
	readonly presetIds: readonly string[];
	/** Origins that identify this vendor when the preset is custom. Second resolution key. */
	readonly endpointOrigins: readonly string[];
	/**
	 * Origins a built request is allowed to target. `buildRequests` asserts every
	 * URL against this list, so a profile whose endpoint was edited to point at
	 * an attacker's host cannot make us send the user's API key there.
	 */
	readonly allowedRequestOrigins: readonly string[];
	readonly pollIntervalMs: number;
	readonly requestTimeoutMs: number;
	buildRequests(baseUrl: string, apiKey: string): QuotaRequestSpec[];
	normalize(results: readonly QuotaRequestResult[]): QuotaNormalizedReading;
}

/** A provider we deliberately do not poll. Pure data — no endpoint, no timer. */
export interface QuotaCapabilityNone {
	readonly kind: typeof PROVIDER_QUOTA_KIND.none;
	readonly reason: ProviderQuotaNoneReason;
	/** Maintainer note explaining the classification. Never sent on the wire. */
	readonly note: string;
}

export type QuotaCapability = QuotaCapabilityAdapter | QuotaCapabilityNone;

export function isPollableCapability(capability: QuotaCapability): capability is QuotaCapabilityAdapter {
	return capability.kind !== PROVIDER_QUOTA_KIND.none;
}

/** The wire-facing kind of any capability. */
export function capabilityKindOf(capability: QuotaCapability): ProviderQuotaKind {
	return capability.kind;
}
