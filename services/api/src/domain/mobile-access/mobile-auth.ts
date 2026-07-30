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
 * Trust ONLY loopback by default. Same-LAN clients (192.168.x.x, 10.x.x.x,
 * 172.16–31.x.x) must present a valid token — otherwise the mobile-access
 * "Disable" button does nothing because every device on the home WiFi is
 * treated as local. A sibling on the same WiFi is the exact threat this
 * feature exists for.
 *
 * Escape hatch: set `VIBE_TAVERN_TRUST_PRIVATE=1` to restore the old
 * "all RFC 1918 = trusted" behavior. This is needed when the app runs inside
 * Docker and the host browser connects through the Docker bridge NAT
 * (typically 172.17.x.x or 172.18.x.x) — the request is functionally local
 * but no longer loopback. Prefer binding the container to 127.0.0.1 when
 * possible; only enable this when you actually need LAN passwordless access.
 */
const TRUST_PRIVATE_IPS = process.env.VIBE_TAVERN_TRUST_PRIVATE === "1";

function isTrustedClient(remoteIp: unknown): boolean {
	if (typeof remoteIp !== "string") return false;
	// Loopback — always trusted (real local access from the same machine).
	if (remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1") return true;

	if (!TRUST_PRIVATE_IPS) return false;

	// RFC 1918 private subnets — opt-in via VIBE_TAVERN_TRUST_PRIVATE=1.
	// Parse IPv4 (strip IPv6-mapped prefix if present).
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
	const keyPath = process.env.VIBE_TAVERN_TLS_KEY;
	const certPath = process.env.VIBE_TAVERN_TLS_CERT;

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
