import { Hono } from "hono";
import type { TtsRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import type { DraftTtsVoicesInput } from "@vibe-tavern/api-contracts";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import { KokoroClientSideError, TtsCloneUnsupportedError } from "../adapters/tts-adapter.js";

export function createTtsRoutes(runtime: TtsRuntimeApi) {
  return new Hono()
    .get("/api/tts/profiles/all", async (c) => {
      return c.json(await runtime.listTtsProfiles());
    })
    .get("/api/tts/profiles/:id", async (c) => {
      const profile = await runtime.getTtsProfile(c.req.param("id"));
      if (!profile) return c.json({ error: "TTS profile not found" }, 404);
      return c.json(profile);
    })
    .post("/api/tts/profiles", zValidator("json", schemas.createTtsProfileSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createTtsProfile(body), 201);
    })
    .patch("/api/tts/profiles/:id", zValidator("json", schemas.updateTtsProfileSchema), async (c) => {
      const body = c.req.valid("json");
      const updated = await runtime.updateTtsProfile(c.req.param("id"), body);
      if (!updated) return c.json({ error: "TTS profile not found" }, 404);
      return c.json(updated);
    })
    .delete("/api/tts/profiles/:id", async (c) => {
      await runtime.deleteTtsProfile(c.req.param("id"));
      return c.json({ ok: true });
    })
    .put("/api/tts/profiles/:id/default", async (c) => {
      const updated = await runtime.setTtsDefault(c.req.param("id"));
      if (!updated) return c.json({ error: "TTS profile not found" }, 404);
      return c.json(updated);
    })
    .get("/api/tts/profiles/default", async (c) => {
      const profile = await runtime.getDefaultTtsProfile();
      if (!profile) return c.json({ error: "No default TTS profile" }, 404);
      return c.json(profile);
    })
    // ── Links (voice map) ────────────────────────────────────────────────
    .get("/api/tts/profiles/:id/links", async (c) => {
      return c.json(await runtime.getTtsLinks(c.req.param("id")));
    })
    .put(
      "/api/tts/profiles/:id/links",
      zValidator("json", schemas.setTtsLinksSchema),
      async (c) => {
        const body = c.req.valid("json");
        return c.json(await runtime.setTtsLinks(c.req.param("id"), body.links));
      },
    )
    .get("/api/tts/links", async (c) => {
      return c.json(await runtime.listAllTtsLinks());
    })
    // ── Generation (buffered audio) ──────────────────────────────────────
    .post("/api/tts/generate", zValidator("json", schemas.generateTtsSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await runtime.generateTtsSpeech(body);
        if (!result) return c.json({ error: "TTS profile not found" }, 404);
        return c.body(new Uint8Array(result.audio), 200, {
          "Content-Type": result.mime,
          "Cache-Control": "no-store",
        });
      } catch (error) {
        if (error instanceof KokoroClientSideError) {
          return c.json({ error: "kokoro runs client-side" }, 400);
        }
        throw error;
      }
    })
    // ── Voices ───────────────────────────────────────────────────────────
    .get("/api/tts/profiles/:id/voices", async (c) => {
      try {
        const voices = await runtime.listTtsVoices(c.req.param("id"));
        if (voices === null) return c.json({ error: "TTS profile not found" }, 404);
        return c.json(voices);
      } catch (error) {
        // Browser-only backend (kokoro): a clean 400, not an unhandled 500 —
        // the client synthesizes and lists voices for it locally.
        if (error instanceof KokoroClientSideError) {
          return c.json({ error: "kokoro runs client-side" }, 400);
        }
        throw error;
      }
    })
    // ── Draft (transient) check — unsaved form config ─────────────────────
    .post("/api/tts/draft/voices", zValidator("json", schemas.draftTtsVoicesSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        return c.json(await runtime.draftListTtsVoices(body));
      } catch (error) {
        if (error instanceof KokoroClientSideError) {
          return c.json({ error: "kokoro runs client-side" }, 400);
        }
        throw error;
      }
    })
    .post("/api/tts/draft/preview", zValidator("json", schemas.draftTtsPreviewSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await runtime.draftPreviewTts(body);
        return c.body(new Uint8Array(result.audio), 200, {
          "Content-Type": result.mime,
          "Cache-Control": "no-store",
        });
      } catch (error) {
        if (error instanceof KokoroClientSideError) {
          return c.json({ error: "kokoro runs client-side" }, 400);
        }
        throw error;
      }
    })
    .post("/api/tts/draft/models", zValidator("json", schemas.draftTtsModelsSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        const models = await runtime.draftListTtsModels(body);
        if (models === null) return c.json({ error: "model listing not supported" }, 400);
        return c.json(models);
      } catch (error) {
        if (error instanceof KokoroClientSideError) {
          return c.json({ error: "kokoro runs client-side" }, 400);
        }
        throw error;
      }
    })
    // ── Voice cloning (clone field design 2026-08-31) ──────────────────
    // Multipart: backend/config/profileId/name as fields + `audio` file.
    // Manual validation (no zod for multipart); the same stored-key
    // injection as the other draft routes applies server-side.
    .post("/api/tts/clone", async (c) => {
      const form = await c.req.parseBody();
      const name = form["name"];
      const backend = form["backend"];
      const configField = form["config"];
      const profileId = form["profileId"];
      const audio = form["audio"];
      const referenceText = form["referenceText"];
      if (typeof referenceText !== "undefined" && typeof referenceText !== "string") {
        return c.json({ error: "referenceText must be a string" }, 400);
      }
      if (typeof referenceText === "string" && referenceText.trim().length > 2000) {
        return c.json({ error: "reference text must be at most 2000 characters" }, 400);
      }
      if (typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
        return c.json({ error: "voice name must be 1-100 characters" }, 400);
      }
      if (typeof backend !== "string" || !(Object.values(TTS_BACKEND) as string[]).includes(backend)) {
        return c.json({ error: "unknown TTS backend" }, 400);
      }
      if (typeof configField !== "string") {
        return c.json({ error: "config is required" }, 400);
      }
      let config: unknown;
      try {
        config = JSON.parse(configField);
      } catch {
        return c.json({ error: "config must be a JSON object" }, 400);
      }
      if (typeof config !== "object" || config === null) {
        return c.json({ error: "config must be a JSON object" }, 400);
      }
      if (!(audio instanceof File)) {
        return c.json({ error: "audio sample file is required" }, 400);
      }
      // Mirror the backend capability hints (chatterbox voice-library limits).
      const MAX_CLONE_BYTES = 10 * 1024 * 1024;
      if (audio.size === 0 || audio.size > MAX_CLONE_BYTES) {
        return c.json({ error: `audio sample must be 1 B - 10 MB (got ${audio.size} B)` }, 400);
      }
      const mimeType = audio.type || "application/octet-stream";
      const ALLOWED_AUDIO_MIME_PREFIXES = ["audio/"];
      if (!ALLOWED_AUDIO_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
        return c.json({ error: `unsupported audio type: ${mimeType}` }, 400);
      }
      try {
        const voice = await runtime.cloneTtsVoiceDraft({
          // Guarded against Object.values(TTS_BACKEND) above — the cast is
          // the validated boundary from multipart string to the slug union.
          backend: backend as DraftTtsVoicesInput["backend"],
          config: config as Record<string, unknown>,
          profileId: typeof profileId === "string" && profileId.length > 0 ? profileId : undefined,
          name: name.trim(),
          referenceAudio: Buffer.from(await audio.arrayBuffer()),
          mimeType,
          ...(typeof referenceText === "string" && referenceText.trim().length > 0
            ? { referenceText: referenceText.trim() }
            : {}),
        });
        return c.json(voice);
      } catch (error) {
        if (error instanceof KokoroClientSideError) {
          return c.json({ error: "kokoro runs client-side" }, 400);
        }
        if (error instanceof TtsCloneUnsupportedError) {
          return c.json({ error: "this TTS backend does not support voice cloning" }, 400);
        }
        throw error;
      }
    })
    // ── Local-server helpers (D8) ────────────────────────────────────
    .get("/api/tts/local/docker", async (c) => {
      // Never throws — every probe failure degrades to available:false.
      return c.json(await runtime.probeLocalDocker());
    })
    .get("/api/tts/local/discover", async (c) => {
      // Server-side port probing: local servers without CORS headers
      // (openai-edge-tts) are unreachable from the browser. Never throws —
      // each port's failure mode is part of the ProbeOutcome data.
      return c.json(await runtime.discoverLocalTts());
    });
}
