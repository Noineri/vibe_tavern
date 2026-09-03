/**
 * @module routes/stt-whisper-mirror
 *
 * `GET /api/stt/whisper/model/<repo>/<path>` — server-side mirror of the
 * Whisper model repositories (STT_PLAN ST-3). See
 * `domain/stt/whisper-mirror.ts` for the design: fixed repo allowlist (the
 * whisper roster), strict path validation, disk cache, upstream through the
 * app's proxy infrastructure. This route module only adapts the service
 * result to HTTP.
 */

import { Hono } from "hono";

import {
  WhisperMirrorService,
  whisperMirrorAllowlist,
  type WhisperMirrorResult,
} from "../../domain/stt/whisper-mirror.js";

const ROUTE_PREFIX = "/api/stt/whisper/model/";

export function createSttWhisperMirrorRoutes(service: WhisperMirrorService): Hono {
  return new Hono().get("/api/stt/whisper/model/*", async (c) => {
    // Hono's wildcard param includes the leading slash. Repo ids are
    // NAMESPACED ("onnx-community/whisper-base") — the first slash sits
    // INSIDE the repo id, so parsing must match the roster repo as a
    // PREFIX, not split at the first boundary (owner bug report 2026-09-05:
    // the first-slash split produced repo="onnx-community" → 400 "Unknown
    // model repository" for EVERY real download; the first live click
    // through WhisperModelPanel found it). The roster prefix IS the security
    // boundary: a non-roster path can match nothing.
    const raw = c.req.path.slice(ROUTE_PREFIX.length);
    const repo = whisperMirrorAllowlist().find((r) => raw.startsWith(r + "/"));
    if (!repo) {
      return c.json({ error: "Unknown model repository." }, 400);
    }
    const rawPath = raw.slice(repo.length + 1);
    const result: WhisperMirrorResult = await service.handle(repo, rawPath);
    if (result.status !== 200) {
      return c.json({ error: result.error }, result.status);
    }
    return c.body(result.body, 200, {
      "Content-Type": result.contentType,
      ...(result.contentLength.length > 0 ? { "Content-Length": result.contentLength } : {}),
      // The browser keeps its own CacheStorage copy; no need to let
      // intermediaries cache model files.
      "Cache-Control": "no-store",
    });
  });
}
