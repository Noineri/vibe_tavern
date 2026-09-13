import { Hono, type Context } from "hono";
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
import { weakEtag, withStaticValidator } from "./static-conditional.js";

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
	/** Frontend files baked into the standalone binary, keyed by the URL
	 *  pathname each answers. When non-empty, the SPA is served from the
	 *  binary itself and no on-disk web/ folder is required. Sourced from
	 *  embedded-web-assets.ts. */
	embeddedWebFiles?: ReadonlyMap<string, Blob>;
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
		if (url.includes("/messages")) {
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
	//      non-empty map of URL pathname → the file's bytes inside the .exe.
	//      No web/ folder on disk needed.
	//   2. On-disk (classic standalone/installer): deps.staticDir points at a
	//      web/ folder next to the binary; hono serveStatic serves it.
	// Both can be active: serveStatic handles whatever it finds on disk first,
	// the embedded map fills in any misses, then SPA fallback. This lets the
	// build ship a self-contained .exe while still allowing a hot-swappable
	// web/ folder for rapid frontend patches without recompiling.
	//
	// /assets/* and /fonts/* from disk are served before Hono by Bun {dir}
	// routes (server-runtime.ts), which validate with an ETag. What reaches
	// here is the embedded copy and index.html — neither has a file on disk to
	// validate, so both carry a weak ETag built from their own bytes.

	const hasEmbedded = (deps.embeddedWebFiles?.size ?? 0) > 0;
	const hasDiskStatic = !!deps.staticDir
		&& await Bun.file(resolve(deps.staticDir, "index.html")).exists();

	if (hasEmbedded || hasDiskStatic) {
		const staticDir = deps.staticDir;
		const embeddedIndex = deps.embeddedWebFiles?.get("/index.html") ?? null;
		const embeddedIndexHtml = embeddedIndex === null ? null : await embeddedIndex.text();

		/** The SPA document, for `/`, `/index.html` and every deep link.
		 *  Re-read from disk per request so a patched web/index.html still takes
		 *  effect without a restart (previously only `/` did — deep links were
		 *  answered from a startup snapshot, so the two disagreed), then tagged
		 *  with a validator built from those bytes so a reload costs a 304. */
		const respondWithIndex = async (c: Context): Promise<Response> => {
			let html = embeddedIndexHtml;
			if (hasDiskStatic && staticDir) {
				const file = Bun.file(resolve(staticDir, "index.html"));
				if (await file.exists()) html = await file.text();
			}
			if (html === null) return c.notFound();
			const body = html;
			return withStaticValidator(c.req.raw, weakEtag(body), () => c.html(body));
		};

		// Before serveStatic: it would answer `/` from disk without a validator.
		app.get("/", respondWithIndex);
		app.get("/index.html", respondWithIndex);

		if (hasDiskStatic) {
			// Serve built assets from disk: /assets/*, /fonts/*, etc.
			app.use("/*", serveStatic({ root: staticDir }));
		}

		// Embedded files are immutable for the life of the binary, so each
		// validator is computed once on first request and kept.
		const embeddedEtags = new Map<string, string>();

		// SPA fallback + embedded-file lookup + clear 404 for missing assets.
		app.get("*", async (c) => {
			const { pathname } = new URL(c.req.url);
			// Embedded lookup (serves files baked into the .exe). Wins only when
			// serveStatic above didn't finalize — i.e. disk static is absent or
			// the file isn't on disk.
			const embedded = deps.embeddedWebFiles?.get(pathname);
			if (embedded) {
				let etag = embeddedEtags.get(pathname);
				if (etag === undefined) {
					etag = weakEtag(new Uint8Array(await embedded.arrayBuffer()));
					embeddedEtags.set(pathname, etag);
				}
				// Content-Type comes from the blob: Bun records each embedded
				// file's MIME at compile time from its extension.
				return withStaticValidator(c.req.raw, etag, () => new Response(embedded));
			}
			// Don't serve index.html for missing static assets — that returns
			// HTML with MIME text/html, which the browser rejects as a module
			// script ("Expected a JavaScript module ... got text/html"), masking
			// a missing-bundle problem as a baffling frozen splash with no
			// actionable console message.
			if (pathname.startsWith("/assets/") || pathname.startsWith("/fonts/")) {
				return c.text(`Asset not found: ${pathname}`, 404);
			}
			return respondWithIndex(c);
		});
	}

	app.all("*", (c) => {
		const url = new URL(c.req.url);
		return c.json({ error: `Route not found: ${c.req.method} ${url.pathname}` }, 404);
	});

	return app;
}
