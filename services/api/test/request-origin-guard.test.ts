import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
	createOriginGuardMiddleware,
	parseAllowedOrigins,
	normalizeExternalHost,
	extractHostname,
	isTrustedHost,
	type OriginGuardOptions,
} from "../src/server/request-origin-guard.js";
import { createMobileAuthMiddleware } from "../src/domain/mobile-access/mobile-auth.js";

/**
 * Boundary tests for the local API browser-origin guard.
 *
 * The previous setup used global cors({ origin: "*" }) which allowed any
 * website to send browser requests to the loopback API and read responses
 * (including /api/bootstrap chat data). The guard replaces that with a
 * fail-closed boundary: same-origin by default, foreign Origin rejected at
 * the request boundary (not merely stripped of CORS headers), Host validated
 * against DNS rebinding, Sec-Fetch-Site: cross-site rejected as defense in
 * depth, and exact VIBE_TAVERN_ALLOWED_ORIGINS support for split deployments.
 *
 * Mobile auth semantics (loopback trust, LAN token requirement) must remain
 * unchanged — tested in the composition section below.
 */

// ── Helpers ─────────────────────────────────────────────────────────────

function appWithGuard(
	guardOptions: OriginGuardOptions,
	provenance: {
		path?: string;
		method?: string;
		headers?: Record<string, string>;
		fullUrl?: string;
	} = {},
) {
	const app = new Hono<{ Variables: { remoteIp: string } }>();
	app.use("*", createOriginGuardMiddleware(guardOptions));
	app.all("/api", (c) => c.json({ ok: true }));
	app.all("/api/test", (c) => c.json({ ok: true }));
	app.all("/api/vary", (c) => {
		c.header("Vary", "Accept-Encoding");
		return c.json({ ok: true });
	});
	app.all("/public", (c) => c.json({ ok: true }));
	return app.request(
		provenance.fullUrl ?? provenance.path ?? "/api/test",
		{ method: provenance.method ?? "GET", headers: provenance.headers },
	);
}

// ── Unit: env parsing ───────────────────────────────────────────────────

describe("parseAllowedOrigins", () => {
	test("empty/undefined → empty set", () => {
		expect(parseAllowedOrigins(undefined).size).toBe(0);
		expect(parseAllowedOrigins("").size).toBe(0);
	});

	test("rejects wildcard values and wildcard hosts", () => {
		expect(parseAllowedOrigins("*,https://*.example.com").size).toBe(0);
	});

	test("accepts and canonicalizes valid http/https origins", () => {
		const set = parseAllowedOrigins("http://LOCALHOST:80/,https://tavern.example.com");
		expect(set.size).toBe(2);
		expect(set.has("http://localhost")).toBe(true);
		expect(set.has("https://tavern.example.com")).toBe(true);
	});

	test("skips invalid URLs and values that are not bare origins", () => {
		const set = parseAllowedOrigins([
			"http://localhost:4173",
			"not-a-url",
			"ftp://bad.com",
			"http://ok.com/path",
			"https://user:password@secret.example",
			"https://query.example?allowed=true",
		].join(","));
		expect(set.size).toBe(1);
		expect(set.has("http://localhost:4173")).toBe(true);
	});
});

describe("normalizeExternalHost", () => {
	test("strips scheme and port", () => {
		expect(normalizeExternalHost("https://tavern.example.com:8443")).toBe("tavern.example.com");
		expect(normalizeExternalHost("http://my.server:8080")).toBe("my.server");
	});

	test("returns undefined for empty/missing", () => {
		expect(normalizeExternalHost(undefined)).toBeUndefined();
		expect(normalizeExternalHost("")).toBeUndefined();
		expect(normalizeExternalHost("   ")).toBeUndefined();
	});
});

// ── Unit: Host validation ───────────────────────────────────────────────

describe("extractHostname", () => {
	test("strips port from IPv4", () => {
		expect(extractHostname("127.0.0.1:8788")).toBe("127.0.0.1");
		expect(extractHostname("192.168.1.5:3000")).toBe("192.168.1.5");
	});

	test("extracts IPv6 from brackets", () => {
		expect(extractHostname("[::1]:8788")).toBe("::1");
		expect(extractHostname("[fe80::1]")).toBe("fe80::1");
	});

	test("plain hostname without port", () => {
		expect(extractHostname("localhost")).toBe("localhost");
		expect(extractHostname("Evil.COM")).toBe("evil.com");
	});
});

describe("isTrustedHost", () => {
	test("loopback names", () => {
		expect(isTrustedHost("localhost")).toBe(true);
		expect(isTrustedHost("localhost:8788")).toBe(true);
		expect(isTrustedHost("127.0.0.1")).toBe(true);
		expect(isTrustedHost("127.0.0.1:8788")).toBe(true);
		expect(isTrustedHost("::1")).toBe(true);
		expect(isTrustedHost("[::1]:8788")).toBe(true);
		expect(isTrustedHost("0.0.0.0")).toBe(true);
	});

	test("IPv4 literals — any IP (LAN/Tailscale)", () => {
		expect(isTrustedHost("192.168.1.5:8788")).toBe(true);
		expect(isTrustedHost("10.0.0.2")).toBe(true);
		expect(isTrustedHost("100.64.0.1:8788")).toBe(true); // Tailscale CGNAT
	});

	test("IPv6 literals", () => {
		expect(isTrustedHost("[fe80::1]")).toBe(true);
		expect(isTrustedHost("[2001:db8::1]:8788")).toBe(true);
	});

	test("configured external host", () => {
		expect(isTrustedHost("tavern.example.com:8443", "tavern.example.com")).toBe(true);
	});

	test("rejects arbitrary domain names and malformed IP-shaped hosts", () => {
		expect(isTrustedHost("evil.com")).toBe(false);
		expect(isTrustedHost("evil.com:8788")).toBe(false);
		expect(isTrustedHost("evil.com:abc:def")).toBe(false);
		expect(isTrustedHost("myserver.lan")).toBe(false);
		expect(isTrustedHost("999.999.999.999")).toBe(false);
		// Domain name that matches a subdomain of the configured host
		expect(isTrustedHost("sub.tavern.example.com", "tavern.example.com")).toBe(false);
	});
});

// ── Integration: Origin boundary ────────────────────────────────────────

describe("origin guard — same-origin and non-browser", () => {
	test("same-origin browser request → 200 (Origin matches URL origin)", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ headers: { Origin: "http://localhost" } },
		);
		expect(res.status).toBe(200);
	});

	test("same-origin loopback with port → 200", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ fullUrl: "http://127.0.0.1:8788/api/test", headers: { Origin: "http://127.0.0.1:8788" } },
		);
		expect(res.status).toBe(200);
	});

	test("same-origin LAN mobile request → 200", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{
				fullUrl: "http://192.168.1.5:8788/api/test",
				headers: { Origin: "http://192.168.1.5:8788", "Sec-Fetch-Site": "same-origin" },
			},
		);
		expect(res.status).toBe(200);
	});

	test("no Origin header → 200 (non-browser client)", async () => {
		const res = await appWithGuard({ allowedOrigins: new Set() });
		expect(res.status).toBe(200);
	});

	test("empty Origin header → 200 (treated as non-browser)", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ headers: { Origin: "" } },
		);
		expect(res.status).toBe(200);
	});

	test("non-/api/ path is unrestricted even with foreign Origin", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ path: "/public", headers: { Origin: "https://evil.example" } },
		);
		expect(res.status).toBe(200);
	});
});

describe("origin guard — foreign origin rejected", () => {
	test("foreign Origin on loopback → 403", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ headers: { Origin: "https://evil.example" } },
		);
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.kind).toBe("Forbidden");
	});

	test("foreign Origin from HTTP → 403", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ headers: { Origin: "http://evil.example" } },
		);
		expect(res.status).toBe(403);
	});

	test("bare /api path is also guarded", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ path: "/api", headers: { Origin: "https://evil.example" } },
		);
		expect(res.status).toBe(403);
	});
});

describe("origin guard — Sec-Fetch-Site defense in depth", () => {
	test("Sec-Fetch-Site: cross-site → 403", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ headers: { "Sec-Fetch-Site": "cross-site" } },
		);
		expect(res.status).toBe(403);
	});

	test("Sec-Fetch-Site: same-origin → 200", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ headers: { "Sec-Fetch-Site": "same-origin" } },
		);
		expect(res.status).toBe(200);
	});

	test("Sec-Fetch-Site: same-site → 200", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ headers: { "Sec-Fetch-Site": "same-site" } },
		);
		expect(res.status).toBe(200);
	});
});

describe("origin guard — Host validation (DNS rebinding)", () => {
	test("arbitrary domain Host → 403", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ fullUrl: "http://evil.com/api/test" },
		);
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error.message).toMatch(/host/i);
	});

	test("IP literal Host → 200", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set() },
			{ fullUrl: "http://192.168.1.5:8788/api/test" },
		);
		expect(res.status).toBe(200);
	});

	test("configured external Host → 200", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: new Set(), allowedHost: "tavern.example.com" },
			{ fullUrl: "http://tavern.example.com:8443/api/test" },
		);
		expect(res.status).toBe(200);
	});
});

// ── Integration: allowed-origin CORS ────────────────────────────────────

describe("origin guard — explicitly allowed cross-origin", () => {
	const allowed = new Set(["http://localhost:4173"]);

	test("allowed origin actual request → 200 + CORS headers", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: allowed },
			{ headers: { Origin: "http://localhost:4173" } },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4173");
		expect(res.headers.get("Vary")).toBe("Origin");
	});

	test("allowed origin preflight → 204 + CORS headers", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: allowed },
			{
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost:4173",
					"Sec-Fetch-Site": "cross-site",
					"Access-Control-Request-Method": "POST",
				},
			},
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4173");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
	});

	test("allowed cross-site actual request → 200", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: allowed },
			{ headers: { Origin: "http://localhost:4173", "Sec-Fetch-Site": "cross-site" } },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4173");
	});

	test("preserves downstream Vary values", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: allowed },
			{ path: "/api/vary", headers: { Origin: "http://localhost:4173" } },
		);
		expect(res.headers.get("Vary")).toContain("Accept-Encoding");
		expect(res.headers.get("Vary")).toContain("Origin");
	});

	test("origin not in allowlist → 403", async () => {
		const res = await appWithGuard(
			{ allowedOrigins: allowed },
			{ headers: { Origin: "http://evil.example" } },
		);
		expect(res.status).toBe(403);
	});
});

// ── Integration: composition with mobile auth ──────────────────────────

describe("origin guard + mobile auth composition", () => {
	/**
	 * Verifies the guard sits before mobile auth without breaking its
	 * semantics: foreign origins are rejected by the guard; legitimate
	 * same-origin/non-browser clients still go through token enforcement.
	 * LAN clients still need the token; loopback is still trusted.
	 */

	function appWithBoth(
		remoteIp: string,
		provenance: {
			path?: string;
			method?: string;
			headers?: Record<string, string>;
		} = {},
	) {
		const app = new Hono<{ Variables: { remoteIp: string } }>();
		app.use("*", async (c, next) => {
			c.set("remoteIp", remoteIp);
			await next();
		});
		app.use("*", createOriginGuardMiddleware({ allowedOrigins: new Set() }));
		app.use("*", createMobileAuthMiddleware({
			token: "secret-token",
			enforceWhenTokenMissing: true,
		}) as MiddlewareHandler);
		app.all("/api/test", (c) => c.json({ ok: true }));
		return app.request(
			provenance.path ?? "/api/test",
			{ method: provenance.method ?? "GET", headers: provenance.headers },
		);
	}

	test("loopback + foreign Origin → 403 (guard rejects before auth)", async () => {
		const res = await appWithBoth("127.0.0.1", {
			headers: { Origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
	});

	test("loopback + same-origin → 200 (no token needed)", async () => {
		const res = await appWithBoth("127.0.0.1", {
			headers: { Origin: "http://localhost" },
		});
		expect(res.status).toBe(200);
	});

	test("LAN client without token → 401 (token enforcement unchanged)", async () => {
		const res = await appWithBoth("192.168.1.50");
		expect(res.status).toBe(401);
	});

	test("LAN client with correct token → 200", async () => {
		const res = await appWithBoth("192.168.1.50", {
			headers: { Authorization: "Bearer secret-token" },
		});
		expect(res.status).toBe(200);
	});

	test("LAN client + foreign Origin → 403 (guard wins over auth)", async () => {
		const res = await appWithBoth("192.168.1.50", {
			headers: { Origin: "https://evil.example", Authorization: "Bearer secret-token" },
		});
		expect(res.status).toBe(403);
	});
});
