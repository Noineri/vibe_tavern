/**
 * @module routes/kokoro-mirror
 *
 * `GET /api/tts/kokoro/model/*` — server-side mirror of the fixed Kokoro
 * model repository (TTS defects report, F4 / defect D4). See
 * `domain/tts/kokoro-mirror.ts` for the design: single fixed repo, strict
 * path validation, disk cache, upstream through the app's proxy
 * infrastructure. This route module only adapts the service result to HTTP.
 */

import { Hono } from "hono";

import { MIRROR_CONTENT_LENGTH_HEADER } from "@vibe-tavern/domain";

import { KokoroMirrorService, type KokoroMirrorResult } from "../../domain/tts/kokoro-mirror.js";

export function createKokoroMirrorRoutes(service: KokoroMirrorService): Hono {
	return new Hono().get("/api/tts/kokoro/model/*", async (c) => {
		// Hono's wildcard param includes the leading slash; the service's
		// validator is the security boundary either way.
		const rawPath = c.req.path.slice("/api/tts/kokoro/model/".length);
		const result: KokoroMirrorResult = await service.handle(rawPath);
		if (result.status !== 200) {
			return c.json({ error: result.error }, result.status);
		}
		// Cache hit: serve the file itself — Bun.serve answers a Bun.file body
		// with a REAL Content-Length (sendfile), so progress totals survive.
		if (result.filePath) {
			return new Response(Bun.file(result.filePath), {
				status: 200,
				headers: {
					"Content-Type": result.contentType,
					[MIRROR_CONTENT_LENGTH_HEADER]: result.contentLength,
					"Cache-Control": "no-store",
				},
			});
		}
		// filePath XOR body is the service contract — a 200 with neither is a
		// contract break, fail loud instead of sending an empty 200.
		if (!result.body) return c.json({ error: "Model file body missing." }, 500);
		return c.body(result.body, 200, {
			"Content-Type": result.contentType,
			// Bun.serve strips an explicit Content-Length from streaming bodies
			// (chunked wins) — the twin custom header below survives it, and the
			// worker-side fetch wrapper rebuilds a real content-length from it
			// (see domain model-mirror.ts). Cache hits never take this path.
			...(result.contentLength.length > 0 ? { "Content-Length": result.contentLength } : {}),
			...(result.contentLength.length > 0
				? { [MIRROR_CONTENT_LENGTH_HEADER]: result.contentLength }
				: {}),
			// The browser keeps its own CacheStorage copy; no need to let
			// intermediaries cache 92 MB model files.
			"Cache-Control": "no-store",
		});
	});
}
