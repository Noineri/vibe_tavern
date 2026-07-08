import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createMobileAuthMiddleware } from "../src/domain/mobile-access/mobile-auth.js";

/**
 * Regression tests for the mobile-auth middleware trust boundary.
 *
 * Pre-fix: every RFC 1918 private IP (192.168.x.x / 10.x.x.x /
 * 172.16-31.x.x) was treated as trusted, which made the mobile-access
 * "Disable" button a no-op for the actual threat model (sibling on the
 * same WiFi) — every device on the home LAN bypassed the token check
 * entirely. The DELETE/regenerate endpoints could also be invoked by
 * anyone on the same LAN.
 *
 * Post-fix: only loopback is trusted by default. Same-LAN clients must
 * present the current token, so Disable/Regenerate actually take effect.
 */

function appWith(
	remoteIp: string,
	options: Parameters<typeof createMobileAuthMiddleware>[0],
	provenance: { path?: string; method?: string; headers?: Record<string, string>; query?: string } = {},
) {
	const app = new Hono<{ Variables: { remoteIp: string } }>();
	app.use("*", async (c, next) => {
		c.set("remoteIp", remoteIp);
		await next();
	});
	const auth = createMobileAuthMiddleware(options) as MiddlewareHandler;
	app.use("*", auth);
	app.all("/api/test", (c) => c.json({ ok: true }));
	app.all("/api/assets/thing", (c) => c.json({ ok: true }));
	app.all("/public", (c) => c.json({ ok: true }));
	return app.request(
		`${provenance.path ?? "/api/test"}${provenance.query ?? ""}`,
		{ method: provenance.method ?? "GET", headers: provenance.headers },
	);
}

describe("mobile-auth middleware — trust boundary", () => {
	test("loopback IPv4 is always trusted (no token required)", async () => {
		const res = await appWith("127.0.0.1", { token: "abc", enforceWhenTokenMissing: true });
		expect(res.status).toBe(200);
	});

	test("loopback IPv6 ::1 is trusted", async () => {
		const res = await appWith("::1", { token: "abc", enforceWhenTokenMissing: true });
		expect(res.status).toBe(200);
	});

	test("IPv6-mapped loopback ::ffff:127.0.0.1 is trusted", async () => {
		const res = await appWith("::ffff:127.0.0.1", { token: "abc", enforceWhenTokenMissing: true });
		expect(res.status).toBe(200);
	});

	test("REGRESSION: 192.168.x.x (home WiFi) is NOT trusted — token required", async () => {
		const res = await appWith("192.168.1.50", { token: "abc", enforceWhenTokenMissing: true });
		expect(res.status).toBe(401);
	});

	test("REGRESSION: 10.x.x.x is NOT trusted by default", async () => {
		const res = await appWith("10.0.0.2", { token: "abc", enforceWhenTokenMissing: true });
		expect(res.status).toBe(401);
	});

	test("REGRESSION: 172.16-31.x.x is NOT trusted by default", async () => {
		const res = await appWith("172.17.0.1", { token: "abc", enforceWhenTokenMissing: true });
		expect(res.status).toBe(401);
	});

	test("public IP is NOT trusted", async () => {
		const res = await appWith("203.0.113.5", { token: "abc", enforceWhenTokenMissing: true });
		expect(res.status).toBe(401);
	});
});

describe("mobile-auth middleware — token enforcement (non-trusted client)", () => {
	const remoteIp = "192.168.1.50";

	test("missing token + enforceWhenTokenMissing=true → 401 'Mobile access is disabled'", async () => {
		const res = await appWith(remoteIp, { token: null, enforceWhenTokenMissing: true });
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toMatch(/disabled/i);
	});

	test("missing token + enforceWhenTokenMissing=false → open access (fail-open mode)", async () => {
		const res = await appWith(remoteIp, { token: null, enforceWhenTokenMissing: false });
		expect(res.status).toBe(200);
	});

	test("wrong Bearer token → 401 'Invalid or missing token'", async () => {
		const res = await appWith(remoteIp, { token: "abc", enforceWhenTokenMissing: true }, {
			headers: { Authorization: "Bearer wrong" },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toMatch(/invalid|missing/i);
	});

	test("correct Bearer token → 200", async () => {
		const res = await appWith(remoteIp, { token: "abc", enforceWhenTokenMissing: true }, {
			headers: { Authorization: "Bearer abc" },
		});
		expect(res.status).toBe(200);
	});

	test("correct ?token= query → 200 (SSE/streaming path)", async () => {
		const res = await appWith(remoteIp, { token: "abc", enforceWhenTokenMissing: true }, {
			query: "?token=abc",
		});
		expect(res.status).toBe(200);
	});

	test("REGRESSION: old token after regenerate → 401 (regenerate kicks out previous session)", async () => {
		// Server token rotated to "new"; mobile still holds "old".
		// Pre-fix this only worked from public IPs — from LAN the old
		// session stayed alive because the token check was skipped.
		const res = await appWith(remoteIp, { token: "new", enforceWhenTokenMissing: true }, {
			headers: { Authorization: "Bearer old" },
		});
		expect(res.status).toBe(401);
	});
});

describe("mobile-auth middleware — public paths", () => {
	const remoteIp = "192.168.1.50";

	test("/api/assets/* GET bypasses token (avatar/image URLs in <img>)", async () => {
		const res = await appWith(remoteIp, { token: "abc", enforceWhenTokenMissing: true }, {
			path: "/api/assets/thing",
			method: "GET",
		});
		expect(res.status).toBe(200);
	});

	test("/api/assets/* POST is still protected (uploads)", async () => {
		const res = await appWith(remoteIp, { token: "abc", enforceWhenTokenMissing: true }, {
			path: "/api/assets/thing",
			method: "POST",
		});
		expect(res.status).toBe(401);
	});

	test("non-/api/ path bypasses auth (static SPA shell)", async () => {
		const res = await appWith(remoteIp, { token: "abc", enforceWhenTokenMissing: true }, {
			path: "/public",
		});
		expect(res.status).toBe(200);
	});
});
