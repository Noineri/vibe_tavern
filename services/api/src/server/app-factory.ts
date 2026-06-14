import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { resolve } from "node:path";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../errors.js";
import { logSendDebug } from "../send-debug-log.js";
import { createApiRouter, type RuntimeApi } from "../api/routes/index.js";
import { createMobileAuthMiddleware, type MobileAccessTokenSource } from "../mobile-auth.js";

export interface AppDeps {
	runtime: RuntimeApi;
	/** Absolute path to the built frontend assets directory. When set, the app
	 *  serves static files and falls back to index.html for SPA routing. */
	staticDir?: string;
	/** Current mobile/LAN token. Prefer a getter so regenerate/revoke works without restart. */
	mobileAccessToken?: MobileAccessTokenSource;
	/** Deny remote /api/* requests when mobile access has no token. */
	enforceMobileAuth?: boolean;
	/** Mount feature routes before static frontend fallback and final 404 catch-all. */
	configureFeatures?: (app: Hono) => void;
}

/**
 * Creates a fully-configured Hono application with middleware,
 * error handling, health-check, and all API routes.
 */
export async function createApp(deps: AppDeps): Promise<Hono> {
	const { runtime } = deps;
	const apiRouter = createApiRouter(runtime);

	const app = new Hono();

	// ─── Detect real remote IP ────────────────────────────────────────────
	app.use("*", async (c, next) => {
		const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
		if (server?.requestIP) {
			const info = server.requestIP(c.req.raw);
			c.set("remoteIp", info?.address ?? "unknown");
		} else {
			c.set("remoteIp", "unknown");
		}
		await next();
	});

	// ─── Middleware ──────────────────────────────────────────────────────

	app.use("*", cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}));

	// ─── Mobile auth ────────────────────────────────────────────────────
	const authMiddleware = createMobileAuthMiddleware({
		token: deps.mobileAccessToken,
		enforceWhenTokenMissing: deps.enforceMobileAuth,
	});
	app.use("*", authMiddleware);

	app.onError((err, c) => {
		const url = c.req.url;
		const method = c.req.method;
		if (url.includes("/messages") || url.includes("/debug/send-log")) {
			logSendDebug("api.route.error", {
				method,
				url,
				message: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : null,
			});
		}
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 401 | 404 | 409 | 500 | 502);
		}
		console.error("[unhandled]", err);
		return c.json(
			{ error: { kind: "Internal" as const, message: err instanceof Error ? err.message : "Unknown server error" } },
			500,
		);
	});

	// ─── Routes ─────────────────────────────────────────────────────────

	app.get("/health", (c) => {
		return c.json({
			ok: true,
			service: "vibe-tavern-api",
			time: new Date().toISOString(),
		});
	});

	app.route("/", apiRouter);

	// Feature routes must be mounted before static fallback and the final 404.
	deps.configureFeatures?.(app);

	// ─── Static frontend (production only) ───────────────────────────────

	if (deps.staticDir && await Bun.file(resolve(deps.staticDir, "index.html")).exists()) {
		// Serve built assets: /assets/*, /fonts/*, etc.
		app.use("/*", serveStatic({ root: deps.staticDir }));

		// SPA fallback: any non-API, non-asset request → index.html
		const indexHtml = await Bun.file(resolve(deps.staticDir, "index.html")).text();
		app.get("*", (c) => c.html(indexHtml));
	}

	app.all("*", (c) => {
		const url = new URL(c.req.url);
		return c.json({ error: `Route not found: ${c.req.method} ${url.pathname}` }, 404);
	});

	return app;
}
