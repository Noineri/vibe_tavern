/**
 * @module providers/provider-fetch-factory
 *
 * The single proxy-aware provider transport boundary. Resolves a provider's
 * proxy policy (`direct` / `proxy` / `inherit`) into the fetch function that
 * every outbound provider HTTP request must use — both AI SDK generation
 * (streaming + non-streaming + Responses transport) and direct adapter
 * requests (connection probes, model-list fetches, test-chat operations).
 *
 * Resolution rules (precedence implemented exactly once here — adapters and
 * executors never re-implement it):
 *  - `direct`  → no proxy (the default fetch, preserves existing behavior).
 *  - `proxy`   → the provider's selected named proxy. Fail closed if the named
 *                proxy is missing, malformed, or uses an unsupported scheme.
 *  - `inherit` → the current global default proxy, or `direct` when no global
 *                default is configured.
 *
 * Only `http://` and `https://` proxy URLs are supported (Bun's native
 * per-request `fetch(url, { proxy })` option). Unsupported schemes fail closed.
 *
 * Credential safety: the username/password are stored as SEPARATE columns and
 * combined here into the proxy URL only at request time. They are NEVER placed
 * in error messages, logs, or thrown exceptions — a resolution failure raises a
 * generic error with no credential content.
 *
 * Step 3 of the Local API Origin & Provider Proxy report.
 */

import {
	PROXY_MODE,
	isValidProxyUrl,
	type ProviderProxyMode,
	type StoredProxyRecord,
} from "@vibe-tavern/domain";

// ─── Public types ─────────────────────────────────────────────────────────

/** A fetch function compatible with both Bun's per-request `proxy` option and
 *  the AI SDK's custom-`fetch` provider option (both are `typeof globalThis.fetch`). */
export type ProviderFetch = typeof fetch;

/** A provider's proxy selection policy. */
export interface ProviderProxyPolicy {
	proxyMode: ProviderProxyMode;
	proxyId: string | null;
}

/** A fetch factory bound to a proxy store — resolves one policy per operation. */
export interface ProviderFetchFactory {
	/**
	 * Resolve a policy to its effective fetch. Returns `undefined` for `direct`
	 * so callers can OMIT the `fetch` option and let AI SDK providers / direct
	 * adapters use their default fetch (preserving existing behavior exactly).
	 * Returns a proxy-wrapping fetch otherwise.
	 */
	resolveFetch(policy: ProviderProxyPolicy): Promise<ProviderFetch | undefined>;
}

/** Minimal subset of {@link ProxyStore} this module needs — keeps it testable
 *  with a plain stub and avoids pulling the concrete class into pure checks. */
export interface ProxyLookup {
	getById(id: string): Promise<StoredProxyRecord | null>;
	getDefaultProxyId(): Promise<string | null>;
}

// ─── Fail-closed error ────────────────────────────────────────────────────

/**
 * Raised when a configured proxy cannot be used (missing, malformed, or
 * unsupported). The message deliberately carries NO credential or URL detail
 * — connecting directly would silently bypass the user's explicit proxy intent,
 * so the request fails instead.
 */
export class ProviderProxyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderProxyError";
	}
}

// ─── Proxy URL building (credentials combined here, never logged) ─────────

/**
 * Build the per-request proxy URL string for Bun's `fetch(url, { proxy })`,
 * embedding the separately-stored username/password as URL userinfo.
 *
 * The stored URL is a bare `http://`/`https://` URL without userinfo/path/query
 * (validated at write time by {@link isValidProxyUrl}); this re-validates and
 * reconstructs it with credentials. Credentials are percent-encoded so special
 * characters are safe. Throws {@link ProviderProxyError} (no credential detail)
 * on a malformed stored URL or unsupported scheme — fail closed.
 */
export function buildProxyRequestUrl(proxy: StoredProxyRecord): string {
	// isValidProxyUrl already rejects non-http(s), embedded userinfo, and
	// path/query/fragment. Re-checking here defends against a corrupt row.
	if (!isValidProxyUrl(proxy.url)) {
		throw new ProviderProxyError("Configured proxy has an invalid URL.");
	}

	let parsed: URL;
	try {
		parsed = new URL(proxy.url);
	} catch {
		throw new ProviderProxyError("Configured proxy has an invalid URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ProviderProxyError("Configured proxy uses an unsupported scheme.");
	}

	const username = proxy.username ?? "";
	const password = proxy.password ?? "";
	let userinfo = "";
	if (username.length > 0 && password.length > 0) {
		userinfo = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
	} else if (username.length > 0) {
		userinfo = `${encodeURIComponent(username)}@`;
	} else if (password.length > 0) {
		// Password-only: emit an empty username so the password is honored.
		userinfo = `:${encodeURIComponent(password)}@`;
	}

	return `${parsed.protocol}//${userinfo}${parsed.host}`;
}

// ─── Effective proxy resolution (the single precedence implementation) ─────

/** The resolved outcome of a policy: direct, or proxied via a specific URL. */
type ResolvedProxy =
	| { kind: "direct" }
	| { kind: "proxy"; proxyUrl: string };

/**
 * Resolve a provider proxy policy to its effective proxy, looking up named and
 * default proxies through the existing step-2 store.
 *
 * - `direct` → direct (no lookup).
 * - `proxy` → the named proxy; fail closed if missing/malformed/unsupported.
 * - `inherit` → the global default proxy; direct when no default is configured
 *   (the normal "no proxy" state). A configured default that no longer
 *   resolves fails closed instead of silently bypassing it.
 */
export async function resolveEffectiveProxy(
	policy: ProviderProxyPolicy,
	lookup: ProxyLookup,
): Promise<ResolvedProxy> {
	if (policy.proxyMode === PROXY_MODE.direct) {
		if (policy.proxyId !== null) {
			throw new ProviderProxyError("Direct proxy mode must not select a proxy.");
		}
		return { kind: "direct" };
	}

	if (policy.proxyMode === PROXY_MODE.proxy) {
		if (!policy.proxyId) {
			throw new ProviderProxyError("Proxy mode 'proxy' requires a selected proxy.");
		}
		const proxy = await lookup.getById(policy.proxyId);
		if (!proxy) {
			throw new ProviderProxyError("Selected proxy is not available.");
		}
		return { kind: "proxy", proxyUrl: buildProxyRequestUrl(proxy) };
	}

	if (policy.proxyMode !== PROXY_MODE.inherit) {
		throw new ProviderProxyError("Configured proxy mode is invalid.");
	}
	if (policy.proxyId !== null) {
		throw new ProviderProxyError("Inherited proxy mode must not select a proxy.");
	}

	// inherit → global default proxy, or direct when none.
	const defaultId = await lookup.getDefaultProxyId();
	if (!defaultId) {
		return { kind: "direct" };
	}
	const proxy = await lookup.getById(defaultId);
	if (!proxy) {
		throw new ProviderProxyError("Default proxy is not available.");
	}
	return { kind: "proxy", proxyUrl: buildProxyRequestUrl(proxy) };
}

// ─── Fetch wrappers ───────────────────────────────────────────────────────

/**
 * Create a fetch wrapper that routes every request through the given proxy URL
 * using Bun's native per-request `proxy` option. The option is merged AFTER the
 * caller's init so an explicit proxy always wins, while headers/body/signal/etc.
 * pass through untouched. Bun's `fetch` namespace also exposes `preconnect`;
 * the wrapper supplies a no-op implementation so it stays assignable to
 * `typeof fetch` without opening a direct connection that bypasses the proxy.
 */
export function createProxiedFetch(proxyUrl: string): ProviderFetch {
	const proxied: ProviderFetch = (input, init) =>
		fetch(input, { ...init, proxy: proxyUrl });
	// A direct preconnect could leak target DNS/connection metadata outside the
	// configured proxy. Keep the namespace member for type compatibility only.
	proxied.preconnect = () => {};
	return proxied;
}

/**
 * Resolve a policy to its effective fetch. Returns `undefined` for `direct` so
 * callers can omit the option and preserve default behavior; returns a proxy
 * wrapper otherwise.
 */
export async function resolveProviderFetch(
	policy: ProviderProxyPolicy,
	lookup: ProxyLookup,
): Promise<ProviderFetch | undefined> {
	const resolved = await resolveEffectiveProxy(policy, lookup);
	return resolved.kind === "direct" ? undefined : createProxiedFetch(resolved.proxyUrl);
}

// ─── Factory + process-wide default ───────────────────────────────────────
//
// Mirrors the established `setTokenCountFn` startup pattern (see
// prompt-pipeline/compaction.ts): a module-level binding is replaced during
// server bootstrap (`setProviderFetchFactory` in server-runtime) after the store
// is created. Before binding, ordinary direct/inherit-without-default callers
// retain direct behavior while explicit proxy intent fails closed. Every
// operation boundary resolves through the same active factory, so precedence
// lives in exactly one place.

const directFactory: ProviderFetchFactory = {
	resolveFetch: async (policy) => {
		if (policy.proxyMode === PROXY_MODE.proxy) {
			throw new ProviderProxyError("Provider proxy transport is not initialized.");
		}
		if (policy.proxyId !== null) {
			throw new ProviderProxyError("Configured proxy policy is invalid.");
		}
		return undefined;
	},
};

let activeFactory: ProviderFetchFactory = directFactory;

/** Bind the process-wide provider fetch factory. Called once at startup with the
 *  live {@link ProxyStore}; tests may swap it and {@link resetProviderFetchFactory}. */
export function setProviderFetchFactory(factory: ProviderFetchFactory): void {
	activeFactory = factory;
}

/** Restore the unbound factory. For test isolation. */
export function resetProviderFetchFactory(): void {
	activeFactory = directFactory;
}

/** The currently active factory. Operation boundaries resolve through this. */
export function getProviderFetchFactory(): ProviderFetchFactory {
	return activeFactory;
}

/** Build a factory bound to the proxy lookup supplied by the store. */
export function createProviderFetchFactory(proxies: ProxyLookup): ProviderFetchFactory {
	return {
		resolveFetch: (policy) => resolveProviderFetch(policy, proxies),
	};
}

/**
 * Resolve the effective fetch for a profile's policy through the active factory.
 * Convenience for operation boundaries that hold the full provider profile
 * (which carries `proxyMode` / `proxyId`). Returns `undefined` for direct.
 */
export async function resolveProviderFetchForProfile(
	profile: ProviderProxyPolicy,
): Promise<ProviderFetch | undefined> {
	return activeFactory.resolveFetch({
		proxyMode: profile.proxyMode,
		proxyId: profile.proxyId,
	});
}
