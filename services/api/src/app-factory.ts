import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "./errors.js";
import { logSendDebug } from "./send-debug-log.js";
import { createApiRouter, type RuntimeApi } from "./routes.js";

export interface AppDeps {
	runtime: RuntimeApi;
	/** Absolute path to the built frontend assets directory. When set, the app
	 *  serves static files and falls back to index.html for SPA routing. */
	staticDir?: string;
}

/**
 * Creates a fully-configured Hono application with middleware,
 * error handling, health-check, and all API routes.
 */
export function createApp(deps: AppDeps): Hono {
	const { runtime } = deps;
	const apiRouter = createApiRouter(runtime);

	const app = new Hono();

	// ─── Middleware ──────────────────────────────────────────────────────

	app.use("*", cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	}));

	app.use("*", async (c, next) => {
		const contentType = c.req.header("content-type") ?? "";
		if (contentType.includes("multipart/form-data")) {
			return await next();
		}
		const contentLength = c.req.header("content-length");
		if (contentLength && parseInt(contentLength) > 1024 * 1024) {
			return c.json({ error: "Request body too large" }, 413);
		}
		await next();
	});

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

	if (deps.staticDir && existsSync(deps.staticDir)) {
		// Serve built assets: /assets/*, /fonts/*, etc.
		app.use("/*", serveStatic({ root: deps.staticDir }));

		// SPA fallback: any non-API, non-asset request → index.html
		const indexHtml = readFileSync(resolve(deps.staticDir, "index.html"), "utf-8");
		app.get("*", (c) => c.html(indexHtml));
	}

	app.all("*", (c) => {
		const url = new URL(c.req.url);
		return c.json({ error: `Route not found: ${c.req.method} ${url.pathname}` }, 404);
	});

	return app;
}
