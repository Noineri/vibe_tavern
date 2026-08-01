import { isIP } from "node:net";
import type { MiddlewareHandler } from "hono";

// ── Types ───────────────────────────────────────────────────────────────

export interface OriginGuardOptions {
	/** Exact origins admitted for intentional split frontend/API deployments
	 *  (`VIBE_TAVERN_ALLOWED_ORIGINS`). Wildcards are never valid. */
	allowedOrigins: ReadonlySet<string>;
	/** External hostname admitted by Host validation
	 *  (`VIBE_TAVERN_EXTERNAL_HOST`, scheme/port stripped). */
	allowedHost?: string;
}

// ── Env parsing ─────────────────────────────────────────────────────────

/** Parses `VIBE_TAVERN_ALLOWED_ORIGINS` into a set of canonical origins.
 *  Wildcards, credentials, paths, queries, and fragments are rejected. */
export function parseAllowedOrigins(envValue: string | undefined): ReadonlySet<string> {
	if (!envValue) return new Set<string>();
	const origins: string[] = [];
	for (const raw of envValue.split(",")) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.includes("*")) continue;
		try {
			const parsed = new URL(trimmed);
			if (
				(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
				parsed.username !== "" ||
				parsed.password !== "" ||
				parsed.pathname !== "/" ||
				parsed.search !== "" ||
				parsed.hash !== ""
			) {
				continue;
			}
			origins.push(parsed.origin);
		} catch {
			// Invalid origin — skip silently and remain fail-closed.
		}
	}
	return new Set(origins);
}

/** Extracts a canonical hostname from `VIBE_TAVERN_EXTERNAL_HOST`. */
export function normalizeExternalHost(envValue: string | undefined): string | undefined {
	const trimmed = envValue?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
		if (
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.pathname !== "/" ||
			parsed.search !== "" ||
			parsed.hash !== ""
		) {
			return undefined;
		}
		return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return undefined;
	}
}

// ── Host validation (DNS-rebinding protection) ──────────────────────────

/** Extracts the hostname (no port) from a raw Host value.
 *  Returns an empty string for malformed host/port combinations. */
export function extractHostname(rawHost: string): string {
	const host = rawHost.trim().toLowerCase();
	if (!host) return "";

	// Accept a bare IP literal for direct callers, including bare IPv6.
	if (isIP(host) !== 0) return host;

	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		if (end <= 1) return "";
		const hostname = host.slice(1, end);
		const suffix = host.slice(end + 1);
		if (isIP(hostname) !== 6 || (suffix !== "" && !isValidPortSuffix(suffix))) return "";
		return hostname;
	}

	const firstColon = host.indexOf(":");
	if (firstColon === -1) return host;
	if (firstColon !== host.lastIndexOf(":")) return "";
	if (!isValidPortSuffix(host.slice(firstColon))) return "";
	return host.slice(0, firstColon);
}

function isValidPortSuffix(suffix: string): boolean {
	if (!/^:\d+$/.test(suffix)) return false;
	const port = Number(suffix.slice(1));
	return port >= 0 && port <= 65_535;
}

/** Admits loopback names, any valid IP literal (LAN/Tailscale/mobile), and
 *  the configured external host. Rejects arbitrary domain names that could
 *  be used for DNS rebinding. */
export function isTrustedHost(rawHost: string, allowedHost?: string): boolean {
	const hostname = extractHostname(rawHost);
	if (!hostname) return false;
	if (hostname === "localhost") return true;
	if (isIP(hostname) !== 0) return true;
	return allowedHost !== undefined && hostname === allowedHost.toLowerCase();
}

// ── Middleware ──────────────────────────────────────────────────────────

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "Content-Type, Authorization";

/** Fail-closed browser-origin boundary for the local API.
 *
 * Replaces the previous global `cors({ origin: "*" })` which allowed any
 * website to read API responses (including `/api/bootstrap` chat data).
 *
 * Default posture is same-origin: the SPA and API share one origin, so no
 * CORS grant is needed. Browser requests carrying a foreign `Origin` are
 * rejected at the boundary — not merely stripped of response headers.
 * `Sec-Fetch-Site: cross-site` is rejected as defense in depth. Host is
 * validated against loopback/IP-literals/configured-external to block DNS
 * rebinding. Non-browser clients (no Origin, no Fetch Metadata) pass
 * through unchanged; mobile-auth enforces the token boundary separately.
 *
 * Gating applies to `/api` and `/api/*`. Static SPA HTML and assets are
 * not sensitive and remain unrestricted.
 */
export function createOriginGuardMiddleware(options: OriginGuardOptions): MiddlewareHandler {
	const { allowedOrigins } = options;
	const allowedHost = options.allowedHost?.toLowerCase();

	return async (c, next) => {
		const url = new URL(c.req.url);

		// Only gate API routes — static SPA and assets are unrestricted.
		if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
			return await next();
		}

		// DNS-rebinding protection: validate the host. In production Bun derives
		// c.req.url from the HTTP Host header, so url.host is equivalent to the
		// header but also works in tests where the header isn't auto-set.
		if (!isTrustedHost(url.host, allowedHost)) {
			return c.json(
				{ error: { kind: "Forbidden" as const, message: "Host not allowed" } },
				403,
			);
		}

		const origin = c.req.header("Origin");
		const isExplicitlyAllowed = origin !== undefined && allowedOrigins.has(origin);

		// Defense in depth for browser-controlled requests. An exact operator
		// allowlist entry intentionally overrides Fetch Metadata for split-origin
		// deployments, which browsers correctly label as cross-site.
		if (c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site" && !isExplicitlyAllowed) {
			return c.json(
				{ error: { kind: "Forbidden" as const, message: "Cross-site requests are not allowed" } },
				403,
			);
		}

		// No Origin header → non-browser client (curl, CLI tools, server-to-
		// server). Mobile-auth enforces the token boundary separately.
		if (origin === undefined || origin === "") {
			return await next();
		}

		// Same-origin browser request → no CORS headers needed.
		if (origin === url.origin) {
			return await next();
		}

		// Explicitly allowed cross-origin (split frontend/API deployment).
		if (isExplicitlyAllowed) {
			if (c.req.method === "OPTIONS") {
				// Preflight — respond directly without calling next(), matching
				// Hono's own cors middleware behavior.
				return new Response(null, {
					status: 204,
					headers: {
						"Access-Control-Allow-Origin": origin,
						"Access-Control-Allow-Methods": CORS_METHODS,
						"Access-Control-Allow-Headers": CORS_HEADERS,
						"Access-Control-Max-Age": "86400",
						Vary: "Origin",
					},
				});
			}
			// Actual request — attach CORS headers to the downstream response.
			await next();
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Access-Control-Allow-Headers", CORS_HEADERS);
			c.header("Vary", "Origin", { append: true });
			return;
		}

		// Foreign origin → reject at the boundary.
		return c.json(
			{ error: { kind: "Forbidden" as const, message: "Origin not allowed" } },
			403,
		);
	};
}
