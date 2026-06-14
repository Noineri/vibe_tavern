import type { MiddlewareHandler } from "hono";
import { existsSync } from "node:fs";

// ── Auth middleware ──────────────────────────────────────────────────────

export type MobileAccessTokenSource = string | (() => string | null | undefined) | null | undefined;

export interface MobileAuthOptions {
	/** Current access token or a getter. Use a getter so regenerate/revoke works without restart. */
	token: MobileAccessTokenSource;
	/** When true, remote /api/* requests are denied while no token exists. */
	enforceWhenTokenMissing?: boolean;
}

function resolveToken(source: MobileAccessTokenSource): string | undefined {
	const token = typeof source === "function" ? source() : source;
	return typeof token === "string" && token.trim() ? token : undefined;
}

/**
 * Returns true for loopback addresses AND RFC 1918 private subnets.
 *
 * Why private subnets? When the app runs inside Docker, the host's browser
 * connects through Docker's bridge NAT (typically 172.17.x.x or 172.18.x.x).
 * The request is functionally local — same machine — but the TCP remote IP is
 * no longer 127.0.0.1. Treating private IPs as trusted preserves the "local
 * access is passwordless" UX while still requiring a token for truly remote
 * connections (public IPs).
 */
function isTrustedClient(remoteIp: unknown): boolean {
	if (typeof remoteIp !== "string") return false;
	// Loopback
	if (remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1") return true;

	// Parse IPv4 (strip IPv6-mapped prefix if present)
	const v4 = remoteIp.replace(/^::ffff:/, "");
	const parts = v4.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map(Number);
	if (octets.some((o) => Number.isNaN(o))) return false;

	// 10.0.0.0/8
	if (octets[0] === 10) return true;
	// 172.16.0.0/12
	if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
	// 192.168.0.0/16
	if (octets[0] === 192 && octets[1] === 168) return true;

	return false;
}

function isPublicAssetRead(path: string, method: string): boolean {
	return path.startsWith("/api/assets/") && (method === "GET" || method === "HEAD");
}

function extractBearerToken(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim();
}

/** Creates conditional mobile/LAN auth middleware.
 *  Loopback connections are always allowed.
 *  Remote /api/* requests must provide the current Bearer token or ?token= query param.
 *  Public asset reads stay open so avatar/image URLs work in <img>, but uploads are protected.
 */
export function createMobileAuthMiddleware(options: MobileAuthOptions): MiddlewareHandler {
	return async (c, next) => {
		// Skip auth for loopback connections (real TCP remote IP from Bun)
		const remoteIp = c.get("remoteIp");
		if (isTrustedClient(remoteIp)) {
			return await next();
		}

		const path = new URL(c.req.url).pathname;
		const method = c.req.method.toUpperCase();

		// Only protect /api/* routes, except public asset reads.
		if (!path.startsWith("/api/") || isPublicAssetRead(path, method)) {
			return await next();
		}

		const token = resolveToken(options.token);
		if (!token) {
			if (options.enforceWhenTokenMissing) {
				return c.json({ error: { kind: "Unauthorized", message: "Mobile access is disabled" } }, 401);
			}
			return await next();
		}

		// Check Authorization header first, then ?token= query param.
		const headerToken = extractBearerToken(c.req.header("Authorization"));
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
