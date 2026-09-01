import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { resolve } from "node:path";
import { DiceBindError, ExperienceBindError } from "@vibe-tavern/db";
import { isDomainError, httpStatusForDomainError, domainErrorToJson } from "../shared/errors.js";
import { ProviderExecutionError } from "../infrastructure/ai/provider-execution-types.js";
import {
	OpenAiCompatTtsConfigError,
	OpenAiCompatTtsError,
} from "../domain/tts/backends/openai-tts.js";
import { GeminiTtsError } from "../domain/tts/backends/gemini-tts.js";
import { ElevenLabsTtsError } from "../domain/tts/backends/elevenlabs-tts.js";
import { logSendDebug } from "../shared/send-debug-log.js";
import { createApiRouter, type RuntimeApi } from "../api/routes/index.js";
import { createKokoroMirrorRoutes } from "../api/routes/kokoro-mirror.js";
import { KokoroMirrorService } from "../domain/tts/kokoro-mirror.js";
import { createSttWhisperMirrorRoutes } from "../api/routes/stt-whisper-mirror.js";
import { WhisperMirrorService } from "../domain/stt/whisper-mirror.js";
import { createMobileAuthMiddleware, type MobileAccessTokenSource } from "../domain/mobile-access/mobile-auth.js";
import {
	createOriginGuardMiddleware,
	parseAllowedOrigins,
	normalizeExternalHost,
} from "./request-origin-guard.js";

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
	/** App data directory (DB, assets, caches). When set, the Kokoro model
	 *  mirror route is mounted, caching the in-browser TTS model under
	 *  <dataDir>/kokoro-model-cache. */
	dataDir?: string;
	/** Embedded frontend files baked into the standalone .exe via
	 *  `import ... with { type: "file" }`. Map of URL pathname → embedded
	 *  file path. When non-empty, the SPA is served from the binary itself
	 *  and no on-disk web/ folder is required. Sourced from
	 *  embedded-web-manifest.ts (regenerated at build time). */
	embeddedWebFiles?: Record<string, string>;
}

/**
 * Creates a fully-configured Hono application with middleware,
 * error handling, health-check, and all API routes.
 */
export async function createApp(deps: AppDeps): Promise<Hono> {
	const { runtime } = deps;
	const apiRouter = createApiRouter(runtime);
	if (deps.dataDir) {
		apiRouter.route(
			"/",
			createKokoroMirrorRoutes(new KokoroMirrorService(deps.dataDir)),
		);
		apiRouter.route(
			"/",
			createSttWhisperMirrorRoutes(new WhisperMirrorService(deps.dataDir)),
		);
	}

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

	// Fail-closed browser-origin boundary for the local API. Replaces the
	// previous global cors({ origin: "*" }) which allowed any website to
	// read API responses. Same-origin by default; foreign Origin rejected;
	// Host validated against DNS rebinding; VIBE_TAVERN_ALLOWED_ORIGINS for
	// intentional split frontend/API deployments. See request-origin-guard.ts.
	app.use("*", createOriginGuardMiddleware({
		allowedOrigins: parseAllowedOrigins(process.env.VIBE_TAVERN_ALLOWED_ORIGINS),
		allowedHost: normalizeExternalHost(process.env.VIBE_TAVERN_EXTERNAL_HOST),
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
		if (err instanceof ProviderExecutionError) {
			// Execution-boundary failure (see provider-error-categorization-reanimation.md).
			// Not a DomainError, so it would otherwise fall through to the generic 500;
			// map it to the same 502 the old providerError() DomainError yielded, and
			// surface the category in error.details so the UI can react to it.
			return c.json(
				{ error: { kind: "Provider" as const, message: err.message, details: { category: err.category } } },
				502,
			);
		}
		if (err instanceof DiceBindError || err instanceof ExperienceBindError) {
			// Send-path bind conflicts (DICE-B11 / IR-70H): the atomic-send bind
			// step throws DiceBindError (a plain Error, NOT a DomainError) when the
			// send-time dice commit has a stale lane revision or an unresolved
			// choose, and ExperienceBindError when an experience-attachment bind
			// fails (not_found / already_bound / stale_queue / stale_session). Both
			// are plain Errors rather than DomainErrors, so unmapped they fell
			// through to the generic 500 below and the frontend could never
			// distinguish a retryable conflict (refresh pending + keep the draft)
			// from a real server/provider error. Map each to the 409 Conflict the
			// contract promises, carrying the structured typed code the client keys
			// on. The two instanceof checks keep both vocabularies explicit; the
			// JSON shape is identical for either kind.
			return c.json(
				{ error: { kind: "Conflict" as const, message: err.message, details: { code: err.code } } },
				409,
			);
		}
		if (
			err instanceof OpenAiCompatTtsError ||
			err instanceof GeminiTtsError ||
			err instanceof ElevenLabsTtsError
		) {
			// TTS upstream failure (any server-side backend): the request itself was
			// fine — the provider refused or failed (bad key → 401, dead endpoint,
			// bad model → 4xx from upstream). Unmapped these fell through to the
			// generic 500 "Internal", which hid the upstream status (an edge-tts
			// 401 on a wrong key read as our own crash). Map to the same 502
			// "Provider" shape as ProviderExecutionError, carrying the captured
			// upstream status when the failure came from an HTTP response.
			return c.json(
				{
					error: {
						kind: "Provider" as const,
						message: err.message,
						details: { ...(err.status !== undefined ? { upstreamStatus: err.status } : {}) },
					},
				},
				502,
			);
		}
		if (err instanceof OpenAiCompatTtsConfigError) {
			// TTS profile config problem (missing/empty endpoint after
			// normalization): the caller's config is incomplete, not a server
			// fault — 400 with the Validation kind, matching
			// httpStatusForDomainError's mapping for the same vocabulary.
			return c.json({ error: { kind: "Validation" as const, message: err.message } }, 400);
		}
		if (isDomainError(err)) {
			return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 401 | 404 | 409 | 422 | 500 | 502);
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

	// ─── Static frontend ─────────────────────────────────────────────────
	// Two compatible modes:
	//   1. Embedded (single-binary standalone): deps.embeddedWebFiles is a
	//      non-empty map of URL → embedded-file path baked into the .exe via
	//      `import ... with { type: "file" }`. No web/ folder on disk needed.
	//   2. On-disk (classic standalone/installer): deps.staticDir points at a
	//      web/ folder next to the binary; hono serveStatic serves it.
	// Both can be active: serveStatic handles whatever it finds on disk first,
	// the embedded map fills in any misses, then SPA fallback. This lets the
	// build ship a self-contained .exe while still allowing a hot-swappable
	// web/ folder for rapid frontend patches without recompiling.

	const hasEmbedded = !!deps.embeddedWebFiles && Object.keys(deps.embeddedWebFiles).length > 0;
	const hasDiskStatic = !!deps.staticDir
		&& await Bun.file(resolve(deps.staticDir, "index.html")).exists();

	if (hasEmbedded || hasDiskStatic) {
		if (hasDiskStatic) {
			// Serve built assets from disk: /assets/*, /fonts/*, etc.
			app.use("/*", serveStatic({ root: deps.staticDir }));
		}

		// Resolve index.html once: prefer disk (hot-patchable), fall back to embedded.
		let indexHtml: string | null = null;
		if (hasDiskStatic && deps.staticDir) {
			indexHtml = await Bun.file(resolve(deps.staticDir, "index.html")).text();
		} else if (deps.embeddedWebFiles?.["/index.html"]) {
			indexHtml = await Bun.file(deps.embeddedWebFiles["/index.html"]).text();
		}

		// SPA fallback + embedded-file lookup + clear 404 for missing assets.
		app.get("*", (c) => {
			const { pathname } = new URL(c.req.url);
			// Embedded lookup (serves files baked into the .exe). Wins only when
			// serveStatic above didn't finalize — i.e. disk static is absent or
			// the file isn't on disk.
			const embedded = deps.embeddedWebFiles?.[pathname];
			if (embedded) {
				return new Response(Bun.file(embedded));
			}
			// Don't serve index.html for missing static assets — that returns
			// HTML with MIME text/html, which the browser rejects as a module
			// script ("Expected a JavaScript module ... got text/html"), masking
			// a missing-bundle problem as a baffling frozen splash with no
			// actionable console message.
			if (pathname.startsWith("/assets/") || pathname.startsWith("/fonts/")) {
				return c.text(`Asset not found: ${pathname}`, 404);
			}
			return indexHtml !== null ? c.html(indexHtml) : c.notFound();
		});
	}

	app.all("*", (c) => {
		const url = new URL(c.req.url);
		return c.json({ error: `Route not found: ${c.req.method} ${url.pathname}` }, 404);
	});

	return app;
}
