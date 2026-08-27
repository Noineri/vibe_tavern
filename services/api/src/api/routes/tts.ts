import { Hono } from "hono";
import type { TtsRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "@vibe-tavern/api-contracts";
import { KokoroClientSideError } from "../adapters/tts-adapter.js";

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
    });
}
