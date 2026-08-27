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
		return c.body(result.body, 200, {
			"Content-Type": result.contentType,
			...(result.contentLength.length > 0 ? { "Content-Length": result.contentLength } : {}),
			// The browser keeps its own CacheStorage copy; no need to let
			// intermediaries cache 92 MB model files.
			"Cache-Control": "no-store",
		});
	});
}
