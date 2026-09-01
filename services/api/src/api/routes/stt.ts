/**
 * @module routes/stt
 *
 * STT profile CRUD + transcription routes (STT_PLAN ST-5b). Mirrors
 * routes/tts.ts: same envelope shapes, same default-pointer endpoints, plus
 * `POST /api/stt/transcribe` — one-shot multipart transcription through a
 * saved profile. The in-browser whisper-browser backend is rejected with a
 * clean 400 (it transcribes client-side; the server has no factory for it).
 * Upstream failures arrive as normalized OpenAiCompatSttError and map to
 * 502; unknown slugs → 400.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";

import type { SttRuntimeApi } from "../contract/runtime-api.js";
import { SttClientSideError } from "../adapters/stt-adapter.js";
import {
  OpenAiCompatSttConfigError,
  OpenAiCompatSttError,
} from "../../domain/stt/backends/openai-stt.js";
import { SttBackendNotRegisteredError, SttUnknownBackendError } from "../../domain/stt/stt-registry.js";

/** Multipart transcriptions may carry sizable clips — a sane ceiling before
 *  the buffer passes to the backend (mirrors the TTS clone guard's shape). */
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

export function createSttRoutes(runtime: SttRuntimeApi) {
  return new Hono()
    // ── Profile CRUD ──────────────────────────────────────────────────────
    .get("/api/stt/profiles/all", async (c) => {
      return c.json(await runtime.listSttProfiles());
    })
    .get("/api/stt/profiles/:id", async (c) => {
      const profile = await runtime.getSttProfile(c.req.param("id"));
      if (!profile) return c.json({ error: "STT profile not found" }, 404);
      return c.json(profile);
    })
    .post("/api/stt/profiles", zValidator("json", schemas.createSttProfileSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createSttProfile(body), 201);
    })
    .patch("/api/stt/profiles/:id", zValidator("json", schemas.updateSttProfileSchema), async (c) => {
      const body = c.req.valid("json");
      const updated = await runtime.updateSttProfile(c.req.param("id"), body);
      if (!updated) return c.json({ error: "STT profile not found" }, 404);
      return c.json(updated);
    })
    .delete("/api/stt/profiles/:id", async (c) => {
      await runtime.deleteSttProfile(c.req.param("id"));
      return c.json({ ok: true });
    })
    .put("/api/stt/profiles/:id/default", async (c) => {
      const updated = await runtime.setSttDefault(c.req.param("id"));
      if (!updated) return c.json({ error: "STT profile not found" }, 404);
      return c.json(updated);
    })
    .get("/api/stt/profiles/default", async (c) => {
      const profile = await runtime.getDefaultSttProfile();
      if (!profile) return c.json({ error: "No default STT profile" }, 404);
      return c.json(profile);
    })
    // ── Transcription (multipart) ────────────────────────────────────────
    .post("/api/stt/transcribe", async (c) => {
      const form = await c.req.parseBody();
      const profileId = form["profileId"];
      const audio = form["audio"];
      const language = form["language"];
      if (typeof profileId !== "string" || profileId.length === 0) {
        return c.json({ error: "profileId is required" }, 400);
      }
      if (!(audio instanceof File)) {
        return c.json({ error: "audio file is required" }, 400);
      }
      if (audio.size === 0 || audio.size > MAX_TRANSCRIBE_BYTES) {
        return c.json({ error: `audio must be 1 B - 25 MB (got ${audio.size} B)` }, 400);
      }
      const mimeType = audio.type || "application/octet-stream";
      const ALLOWED_AUDIO_MIME_PREFIXES = ["audio/"];
      if (!ALLOWED_AUDIO_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
        return c.json({ error: `unsupported audio type: ${mimeType}` }, 400);
      }
      try {
        const result = await runtime.transcribeSttAudio(
          profileId,
          {
            buffer: Buffer.from(await audio.arrayBuffer()),
            mimeType,
            fileName: audio.name,
          },
          typeof language === "string" && language.length > 0 ? language : undefined,
        );
        if (!result) return c.json({ error: "STT profile not found" }, 404);
        return c.json(result);
      } catch (error) {
        if (error instanceof SttClientSideError) {
          return c.json({ error: "whisper-browser runs client-side" }, 400);
        }
        if (error instanceof SttUnknownBackendError || error instanceof SttBackendNotRegisteredError) {
          return c.json({ error: error.message }, 400);
        }
        if (error instanceof OpenAiCompatSttConfigError) {
          return c.json({ error: error.message }, 400);
        }
        // Normalized upstream failure (transport or non-2xx) → the caller
        // should see it as a gateway problem, not a 500 with no body.
        if (error instanceof OpenAiCompatSttError) {
          return c.json({ error: error.message }, error.status && error.status >= 400 && error.status < 500 ? 400 : 502);
        }
        throw error;
      }
    });
}