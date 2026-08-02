import { describe, it, expect, afterEach } from "bun:test";
import {
	PROXY_MODE,
	isValidProxyUrl,
	type ProviderProxyMode,
	type StoredProxyRecord,
} from "@vibe-tavern/domain";
import {
	buildProxyRequestUrl,
	createProxiedFetch,
	resolveEffectiveProxy,
	resolveProviderFetch,
	createProviderFetchFactory,
	setProviderFetchFactory,
	getProviderFetchFactory,
	resetProviderFetchFactory,
	resolveProviderFetchForProfile,
	ProviderProxyError,
	type ProxyLookup,
} from "../src/domain/providers/provider-fetch-factory.js";

// ─── Stub proxy lookup ─────────────────────────────────────────────────────

function makeProxy(over: Partial<StoredProxyRecord> = {}): StoredProxyRecord {
	return {
		id: "proxy_1",
		name: "Test Proxy",
		url: "http://127.0.0.1:8080",
		username: null,
		password: null,
		sortOrder: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

function makeLookup(opts: {
	byId?: Record<string, StoredProxyRecord>;
	defaultId?: string | null;
} = {}): ProxyLookup {
	return {
		getById: async (id) => opts.byId?.[id] ?? null,
		getDefaultProxyId: async () => opts.defaultId ?? null,
	};
}

// ─── buildProxyRequestUrl ──────────────────────────────────────────────────

describe("buildProxyRequestUrl", () => {
	it("returns the bare URL when no credentials are stored", () => {
		expect(buildProxyRequestUrl(makeProxy({ url: "http://127.0.0.1:8080" }))).toBe("http://127.0.0.1:8080");
	});

	it("embeds separately stored credentials as URL userinfo", () => {
		const url = buildProxyRequestUrl(
			makeProxy({ url: "http://10.0.0.5:3128", username: "alice", password: "stored-password" }),
		);
		const parsed = new URL(url);
		expect(parsed.username).toBe("alice");
		expect(parsed.password).not.toBe("");
	});

	it("embeds a username without a password", () => {
		expect(
			buildProxyRequestUrl(makeProxy({ url: "https://proxy.example:8443", username: "bob", password: null })),
		).toBe("https://bob@proxy.example:8443");
	});

	it("percent-encodes special characters in credentials", () => {
		const url = buildProxyRequestUrl(
			makeProxy({ url: "http://h:1", username: "a@b", password: "stored/password" }),
		);
		expect(url).toContain("a%40b:");
		expect(new URL(url).password).not.toBe("");
	});

	it("fails closed on an unsupported (socks) scheme", () => {
		expect(() => buildProxyRequestUrl(makeProxy({ url: "socks5://127.0.0.1:1080" }))).toThrow(
			ProviderProxyError,
		);
	});

	it("fails closed on a malformed URL", () => {
		expect(() => buildProxyRequestUrl(makeProxy({ url: "not a url" }))).toThrow(ProviderProxyError);
	});

	it("never leaks credentials into the thrown error message", () => {
		const password = "super-secret-value-xyz";
		// A valid-looking http URL that isValidProxyUrl rejects because of an
		// embedded path — buildProxyRequestUrl re-validates and fails closed.
		let caught: unknown;
		try {
			buildProxyRequestUrl(makeProxy({ url: "http://127.0.0.1:8080/path", password }));
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ProviderProxyError);
		expect(String(caught).includes(password)).toBe(false);
	});
});

// ─── resolveEffectiveProxy ─────────────────────────────────────────────────

describe("resolveEffectiveProxy", () => {
	it("direct → direct (no lookup)", async () => {
		const res = await resolveEffectiveProxy(
			{ proxyMode: PROXY_MODE.direct, proxyId: null },
			makeLookup(),
		);
		expect(res).toEqual({ kind: "direct" });
	});

	it("direct fails closed when a stale proxy id is supplied", async () => {
		await expect(
			resolveEffectiveProxy({ proxyMode: PROXY_MODE.direct, proxyId: "stale" }, makeLookup()),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});

	it("proxy → the named proxy URL", async () => {
		const lookup = makeLookup({ byId: { p1: makeProxy({ url: "http://1.2.3.4:8080", id: "p1" }) } });
		const res = await resolveEffectiveProxy({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }, lookup);
		expect(res).toEqual({ kind: "proxy", proxyUrl: "http://1.2.3.4:8080" });
	});

	it("proxy with credentials combines them", async () => {
		const lookup = makeLookup({
			byId: { p1: makeProxy({ id: "p1", url: "http://1.2.3.4:8080", username: "u", password: "stored-password" }) },
		});
		const res = await resolveEffectiveProxy({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }, lookup);
		expect(res.kind).toBe("proxy");
		if (res.kind === "proxy") {
			const parsed = new URL(res.proxyUrl);
			expect(parsed.username).toBe("u");
			expect(parsed.password).not.toBe("");
		}
	});

	it("proxy fails closed when the named proxy is missing", async () => {
		const lookup = makeLookup();
		await expect(
			resolveEffectiveProxy({ proxyMode: PROXY_MODE.proxy, proxyId: "gone" }, lookup),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});

	it("proxy fails closed when proxyId is absent", async () => {
		await expect(
			resolveEffectiveProxy({ proxyMode: PROXY_MODE.proxy, proxyId: null }, makeLookup()),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});

	it("proxy fails closed on a malformed stored proxy (no credential leak)", async () => {
		const lookup = makeLookup({ byId: { p1: makeProxy({ id: "p1", url: "bad", password: "leak-me" }) } });
		let err: unknown;
		try {
			await resolveEffectiveProxy({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }, lookup);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ProviderProxyError);
		expect(String(err).includes("leak-me")).toBe(false);
	});

	it("proxy fails closed on an unsupported scheme", async () => {
		const lookup = makeLookup({ byId: { p1: makeProxy({ id: "p1", url: "socks5://h:1" }) } });
		await expect(
			resolveEffectiveProxy({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }, lookup),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});

	it("inherit with no global default → direct", async () => {
		const res = await resolveEffectiveProxy(
			{ proxyMode: PROXY_MODE.inherit, proxyId: null },
			makeLookup({ defaultId: null }),
		);
		expect(res).toEqual({ kind: "direct" });
	});

	it("inherit fails closed when a stale explicit proxy id is supplied", async () => {
		await expect(
			resolveEffectiveProxy({ proxyMode: PROXY_MODE.inherit, proxyId: "stale" }, makeLookup()),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});

	it("inherit with a global default → that default proxy", async () => {
		const lookup = makeLookup({
			defaultId: "g1",
			byId: { g1: makeProxy({ id: "g1", url: "http://global:9000" }) },
		});
		const res = await resolveEffectiveProxy({ proxyMode: PROXY_MODE.inherit, proxyId: null }, lookup);
		expect(res).toEqual({ kind: "proxy", proxyUrl: "http://global:9000" });
	});

	it("inherit fails closed when its configured global default no longer resolves", async () => {
		const lookup = makeLookup({ defaultId: "deleted", byId: {} });
		await expect(
			resolveEffectiveProxy({ proxyMode: PROXY_MODE.inherit, proxyId: null }, lookup),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});
});

// ─── resolveProviderFetch ──────────────────────────────────────────────────

describe("resolveProviderFetch", () => {
	it("returns undefined for direct (preserves SDK default fetch)", async () => {
		expect(
			await resolveProviderFetch({ proxyMode: PROXY_MODE.direct, proxyId: null }, makeLookup()),
		).toBeUndefined();
	});

	it("returns a function for proxy", async () => {
		const lookup = makeLookup({ byId: { p1: makeProxy({ id: "p1" }) } });
		const fn = await resolveProviderFetch({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }, lookup);
		expect(typeof fn).toBe("function");
	});

	it("returns undefined for inherit with no default", async () => {
		expect(
			await resolveProviderFetch({ proxyMode: PROXY_MODE.inherit, proxyId: null }, makeLookup()),
		).toBeUndefined();
	});
});

// ─── createProxiedFetch ────────────────────────────────────────────────────

describe("createProxiedFetch", () => {
	it("calls the underlying fetch with the proxy option merged into init", async () => {
		const calls: Array<{ init: unknown }> = [];
		const fakeFetch = ((input: unknown, init?: unknown) => {
			calls.push({ init });
			return Promise.resolve(new Response("ok"));
		}) as typeof fetch;
		fakeFetch.preconnect = () => {};

		const controller = new AbortController();
		const proxied = createProxiedFetch("http://127.0.0.1:8080", fakeFetch);
		await proxied("http://target.example/api", { method: "POST", headers: { a: "b" }, body: "request body", redirect: "manual", signal: controller.signal });

		expect(calls).toHaveLength(1);
		const init = calls[0]!.init as Record<string, unknown> | undefined;
		expect(init).toBeTruthy();
		expect(init!.proxy).toBe("http://127.0.0.1:8080");
		expect(init!.method).toBe("POST");
		expect(init!.body).toBe("request body");
		expect(init!.redirect).toBe("manual");
		expect(init!.signal).toBe(controller.signal);
	});

	it("keeps fetch.preconnect as a no-op so proxy intent cannot preconnect directly", () => {
		let directPreconnects = 0;
		const fakeFetch = (async () => new Response("ok")) as typeof fetch;
		fakeFetch.preconnect = () => { directPreconnects += 1; };
		const proxied = createProxiedFetch("http://127.0.0.1:8080", fakeFetch);
		proxied.preconnect("https://provider.example");
		expect(directPreconnects).toBe(0);
	});
});

// ─── Factory lifecycle + module-wide default ───────────────────────────────

describe("provider fetch factory lifecycle", () => {
	afterEach(() => resetProviderFetchFactory());

	it("fails closed for an explicit proxy before the runtime factory is bound", async () => {
		await expect(
			resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "any" }),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});

	it("createProviderFetchFactory resolves against the bound store", async () => {
		const lookup = makeLookup({ byId: { p1: makeProxy({ id: "p1", url: "http://px:1" }) } });
		const factory = createProviderFetchFactory(lookup);
		expect(typeof (await factory.resolveFetch({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }))).toBe("function");
		expect(await factory.resolveFetch({ proxyMode: PROXY_MODE.direct, proxyId: null })).toBeUndefined();
	});

	it("setProviderFetchFactory / getProviderFetchFactory / resetProviderFetchFactory", async () => {
		const lookup = makeLookup({ byId: { p1: makeProxy({ id: "p1", url: "http://px:1" }) } });
		setProviderFetchFactory(createProviderFetchFactory(lookup));
		expect(getProviderFetchFactory()).toBeDefined();
		// The module-wide default now resolves the policy through the bound store.
		expect(typeof (await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }))).toBe("function");
		resetProviderFetchFactory();
		// After reset, explicit proxy intent fails closed instead of bypassing it.
		await expect(
			resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "p1" }),
		).rejects.toBeInstanceOf(ProviderProxyError);
	});

	it("inherit follows and stops following the global default when changed", async () => {
		let defaultId: string | null = "g1";
		const byId: Record<string, StoredProxyRecord> = {
			g1: makeProxy({ id: "g1", url: "http://g1:1" }),
			g2: makeProxy({ id: "g2", url: "http://g2:1" }),
		};
		const lookup: ProxyLookup = {
			getById: async (id) => byId[id] ?? null,
			getDefaultProxyId: async () => defaultId,
		};
		setProviderFetchFactory(createProviderFetchFactory(lookup));

		// Follows g1.
		let fetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.inherit, proxyId: null });
		expect(typeof fetch).toBe("function");

		// Switch the global default to g2.
		defaultId = "g2";
		fetch = await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.inherit, proxyId: null });
		expect(typeof fetch).toBe("function");

		// Clear the global default → direct.
		defaultId = null;
		expect(await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.inherit, proxyId: null })).toBeUndefined();
	});

	it("an explicit named proxy overrides the global default", async () => {
		const byId: Record<string, StoredProxyRecord> = {
			named: makeProxy({ id: "named", url: "http://named:1" }),
			global: makeProxy({ id: "global", url: "http://global:1" }),
		};
		const lookup: ProxyLookup = {
			getById: async (id) => byId[id] ?? null,
			getDefaultProxyId: async () => "global",
		};
		setProviderFetchFactory(createProviderFetchFactory(lookup));

		// Explicit named proxy resolves (ignoring the global default).
		expect(typeof (await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.proxy, proxyId: "named" }))).toBe("function");
		// direct overrides too.
		expect(await resolveProviderFetchForProfile({ proxyMode: PROXY_MODE.direct, proxyId: null })).toBeUndefined();
	});
});

// ─── Domain validation parity (sanity) ─────────────────────────────────────

describe("isValidProxyUrl parity", () => {
	it("accepts bare http/https URLs", () => {
		expect(isValidProxyUrl("http://127.0.0.1:8080")).toBe(true);
		expect(isValidProxyUrl("https://proxy.example:8443")).toBe(true);
	});
	it("rejects socks and embedded credentials", () => {
		expect(isValidProxyUrl("socks5://127.0.0.1:1080")).toBe(false);
		expect(isValidProxyUrl("http://u:p@127.0.0.1:8080")).toBe(false);
	});
});

// Re-exported type usage keeps the import meaningful for type-narrowed paths.
export type { ProviderProxyMode };
