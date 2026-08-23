/**
 * @module quota-registry
 *
 * Exhaustive classification of every remote provider preset: an adapter for the
 * six vendors that expose quota or balance to a plain API key, and an explicit
 * `none` entry with a reason for the other sixteen.
 *
 * Exhaustiveness is enforced by the type — a new entry in
 * `REMOTE_PROVIDER_PRESET_IDS` that nobody classified is a compile error, not a
 * silently untracked provider. Capability is NEVER inferred from
 * `PROVIDER_TYPE`: Moonshot (balance), Z.AI (windowed) and Groq (nothing) are
 * all `openai_compat`, so the protocol says nothing about quota.
 */

import {
	PROVIDER_QUOTA_KIND,
	PROVIDER_QUOTA_NONE_REASON,
	REMOTE_PROVIDER_PRESET_IDS,
	type RemoteProviderPresetId,
} from "@vibe-tavern/domain";
import type { QuotaCapability, QuotaCapabilityAdapter, QuotaCapabilityNone } from "./quota-capability-types.js";
import { deepseekQuotaAdapter } from "./adapters/deepseek-quota.js";
import { kimiQuotaAdapter } from "./adapters/kimi-quota.js";
import { moonshotQuotaAdapter } from "./adapters/moonshot-quota.js";
import { nanogptQuotaAdapter } from "./adapters/nanogpt-quota.js";
import { openrouterQuotaAdapter } from "./adapters/openrouter-quota.js";
import { zaiQuotaAdapter } from "./adapters/zai-quota.js";
import { isQuotaStubEnabled, stubQuotaAdapter } from "./adapters/stub-quota.js";

/** The vendors that can actually be polled. Order is irrelevant — lookup is by key. */
export const QUOTA_ADAPTERS: readonly QuotaCapabilityAdapter[] = [
	zaiQuotaAdapter,
	kimiQuotaAdapter,
	nanogptQuotaAdapter,
	moonshotQuotaAdapter,
	deepseekQuotaAdapter,
	openrouterQuotaAdapter,
];

function notExposed(note: string): QuotaCapabilityNone {
	return { kind: PROVIDER_QUOTA_KIND.none, reason: PROVIDER_QUOTA_NONE_REASON.notExposed, note };
}

/** A local endpoint, or one we cannot identify — quota is not a concept there. */
export const NOT_APPLICABLE: QuotaCapabilityNone = {
	kind: PROVIDER_QUOTA_KIND.none,
	reason: PROVIDER_QUOTA_NONE_REASON.notApplicable,
	note: "Local or unrecognized endpoint — no quota concept.",
};

/**
 * Every remote preset, classified. `satisfies Record<RemoteProviderPresetId, …>`
 * is the tripwire that keeps this exhaustive.
 */
const PRESET_CAPABILITIES = {
	zai: zaiQuotaAdapter,
	"zai-coding": zaiQuotaAdapter,
	kimi: kimiQuotaAdapter,
	nanogpt: nanogptQuotaAdapter,
	moonshot: moonshotQuotaAdapter,
	deepseek: deepseekQuotaAdapter,
	openrouter: openrouterQuotaAdapter,

	openai: notExposed("/v1/organization/usage requires an Admin key — a different credential class."),
	anthropic: notExposed("Usage and cost APIs are Admin-API only; a regular key sees rate-limit headers at most."),
	google: notExposed("Quota and billing are visible only in the AI Studio UI."),
	google_interactions: notExposed("Shares the AI Studio key and quota surface; visible only in the AI Studio UI."),
	xai: notExposed("Billing requires a Management API key plus a team id; CodexBar ships no xAI usage fetcher either."),
	// CodexBar's GroqUsageFetcher does hit a plain-key endpoint
	// (`/metrics/prometheus/api/v1/query`), but every series it reads is a RATE
	// (requests/sec, tokens/sec) — throughput with no ceiling. A rate has no
	// denominator, so it cannot become a `usedPercent`, and it is not money
	// either: it fits neither snapshot kind.
	groq: notExposed("Only a Prometheus throughput-rate endpoint — rates have no quota ceiling to measure against."),
	mistral: notExposed("CodexBar reads Mistral usage through browser cookies; no inference-key endpoint exists."),
	fireworks: notExposed("Account-scoped quotas, unconfirmed for inference keys."),
	perplexity: notExposed("CodexBar reads Perplexity usage through browser cookies; no API-key endpoint exists."),
	ai21: notExposed("No billing endpoint documented."),
	mimo: notExposed("CodexBar reads MiMo usage through a platform browser session; no API-key endpoint exists."),
	// NOT settled: CodexBar's ChutesUsageFetcher DOES use a plain key against
	// `/users/me/subscription_usage` (falling back to `/users/me/quotas` plus a
	// per-quota `/users/me/quota_usage/{id}` fan-out). What is missing here is the
	// response SHAPE — CodexBar's own parser is a key-walker that searches a dozen
	// spellings per field precisely because the shape is not pinned, and guessing
	// one is what produced the first round of broken adapters. Needs one captured
	// response from a real Chutes key before an adapter can be written honestly.
	chutes: notExposed("Endpoint exists (/users/me/subscription_usage) but its response shape is unverified."),
	electronhub: notExposed("No citable key-auth usage endpoint found."),
	siliconflow: notExposed("No citable key-auth usage endpoint found."),
	pollinations: notExposed("No citable key-auth usage endpoint found."),
	togetherai: notExposed("A /v1/credits endpoint is reported but its schema is unverified — excluded until fixture-confirmed."),
} satisfies Record<RemoteProviderPresetId, QuotaCapability>;

function isRemotePresetId(presetId: string): presetId is RemoteProviderPresetId {
	return (REMOTE_PROVIDER_PRESET_IDS as readonly string[]).includes(presetId);
}

/** Adapters visible to this process, including the dev stub when it is enabled. */
function activeAdapters(): readonly QuotaCapabilityAdapter[] {
	return isQuotaStubEnabled() ? [...QUOTA_ADAPTERS, stubQuotaAdapter] : QUOTA_ADAPTERS;
}

/**
 * Resolve a profile's quota capability.
 *
 * Preset first: it is the user's explicit statement of which vendor this is.
 * Endpoint origin second, so a profile saved as "custom" against a known host
 * still gets tracked. Anything else is `not_applicable` — including every local
 * provider, which never reaches the origin table.
 */
export function resolveQuotaAdapter(presetId: string, baseUrl: string): QuotaCapability {
	if (isRemotePresetId(presetId)) return PRESET_CAPABILITIES[presetId];

	let origin: string;
	try {
		origin = new URL(baseUrl).origin;
	} catch {
		return NOT_APPLICABLE;
	}

	const byOrigin = activeAdapters().find((adapter) => adapter.endpointOrigins.includes(origin));
	return byOrigin ?? NOT_APPLICABLE;
}

/** Look an adapter up by the id stored on a snapshot. */
export function findQuotaAdapterById(adapterId: string): QuotaCapabilityAdapter | null {
	return activeAdapters().find((adapter) => adapter.id === adapterId) ?? null;
}
