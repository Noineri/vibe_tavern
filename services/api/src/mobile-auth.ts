import type { MiddlewareHandler } from "hono";
import { existsSync } from "node:fs";

// ── Auth middleware ──────────────────────────────────────────────────────

/** Creates a conditional auth middleware.
 *  If no token is provided, returns a pass-through middleware (no auth).
 *  If token is provided, validates Bearer header OR ?token= query param on /api/* only.
 */
export function createMobileAuthMiddleware(token: string | undefined): MiddlewareHandler {
	if (!token) {
		// No token configured → no auth
		return async (_c, next) => await next();
	}

	return async (c, next) => {
		// Skip auth for loopback (desktop/local access)
		const url = new URL(c.req.url);
		// Hono/Bun: c.req.header('x-forwarded-for') for proxied, or check host from URL
		const loopbackHosts = ["127.0.0.1", "localhost", "::1"];
		if (loopbackHosts.includes(url.hostname)) {
			return await next();
		}

		// Only protect /api/* routes
		if (!url.pathname.startsWith("/api/")) {
			return await next();
		}

		// Check Authorization header first, then ?token= query param
		const headerToken = c.req.header("Authorization")?.replace("Bearer ", "");
		const queryToken = c.req.query("token");
		const providedToken = headerToken || queryToken;

		if (providedToken !== token) {
			return c.json({ error: { kind: "Unauthorized", message: "Invalid or missing token" } }, 401);
		}

		return await next();
	};
}

// ── TLS config resolver ──────────────────────────────────────────────────

export interface TlsConfig {
	key: ReturnType<typeof Bun.file>;
	cert: ReturnType<typeof Bun.file>;
}

/** Resolves TLS config from env variables. Returns undefined if not configured. */
export function resolveTlsConfig(): TlsConfig | undefined {
	const keyPath = process.env.RP_PLATFORM_TLS_KEY;
	const certPath = process.env.RP_PLATFORM_TLS_CERT;

	if (!keyPath || !certPath) return undefined;
	if (!existsSync(keyPath) || !existsSync(certPath)) {
		console.warn("[tls] TLS paths configured but files not found. Starting without TLS.");
		return undefined;
	}

	return {
		key: Bun.file(keyPath),
		cert: Bun.file(certPath),
	};
}
