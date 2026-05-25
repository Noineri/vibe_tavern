import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { resolve } from "node:path";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "./errors.js";
import { logSendDebug } from "./send-debug-log.js";
import { createApiRouter, type RuntimeApi } from "./routes/index.js";
import { createMobileAuthMiddleware } from "./mobile-auth.js";

export interface AppDeps {
	runtime: RuntimeApi;
	/** Absolute path to the built frontend assets directory. When set, the app
	 *  serves static files and falls back to index.html for SPA routing. */
	staticDir?: string;
	/** If set, all /api/* routes require this Bearer token (header or ?token= param). */
	mobileAccessToken?: string;
}

/**
 * Creates a fully-configured Hono application with middleware,
 * error handling, health-check, and all API routes.
 */
export async function createApp(deps: AppDeps): Promise<Hono> {
	const { runtime } = deps;
	const apiRouter = createApiRouter(runtime);

	const app = new Hono();

	// ─── Middleware ──────────────────────────────────────────────────────

	app.use("*", cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}));

	// ─── Mobile auth ────────────────────────────────────────────────────
	const authMiddleware = createMobileAuthMiddleware(deps.mobileAccessToken);
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
			service: "rp-platform-api",
			time: new Date().toISOString(),
		});
	});

	app.route("/", apiRouter);

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
