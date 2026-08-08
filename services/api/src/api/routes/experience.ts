import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as schemas from "@vibe-tavern/api-contracts";
import type { ExperienceRuntimeApi } from "../contract/runtime-api.js";

/**
 * Experience routes (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-32).
 *
 * Typed Hono endpoints for the interactive-runtime contract. Routes carry no
 * business logic — each validates its body/query with a Zod schema, reads path
 * params, and delegates to {@link ExperienceRuntimeApi}. Typed service failures
 * surface as thrown DomainErrors that the global onError handler maps to
 * 404/409/422/500 (see experience-adapter.ts).
 *
 * Endpoint groups:
 *   config    — GET/PUT  /api/chats/:chatId/experience/config
 *   visuals   — CRUD under /api/experience/visuals (scoped by query)
 *   sessions  — start under the chat; lifecycle/view/actions/undo/recalculate/
 *               effects under /api/experience/sessions/:sessionId
 *
 * Deferred: effect retry/resolve (Wave 4 model effects), report formatting
 * (IR-52 prompt binding), standalone definition-authoring (Wave 8 playground).
 */
export function createExperienceRoutes(runtime: ExperienceRuntimeApi) {
  return new Hono()
    // ── Config ─────────────────────────────────────────────────────────────
    .get("/api/chats/:chatId/experience/config", async (c) => {
      const chatId = c.req.param("chatId");
      return c.json(await runtime.getExperienceConfig(chatId));
    })
    .put("/api/chats/:chatId/experience/config", zValidator("json", schemas.experienceConfigUpdateSchema), async (c) => {
      const chatId = c.req.param("chatId");
      return c.json(await runtime.updateExperienceConfig(chatId, c.req.valid("json")));
    })

    // ── Visual resources ───────────────────────────────────────────────────
    .get("/api/experience/visuals", zValidator("query", schemas.experienceVisualsQuerySchema), async (c) => {
      const { scopeType, ownerId } = c.req.valid("query");
      return c.json(await runtime.listExperienceVisuals(scopeType, ownerId));
    })
    .get("/api/experience/visuals/:id", async (c) => {
      return c.json(await runtime.getExperienceVisual(c.req.param("id")));
    })
    .post("/api/experience/visuals", zValidator("json", schemas.experienceVisualCreateSchema), async (c) => {
      return c.json(await runtime.createExperienceVisual(c.req.valid("json")));
    })
    .patch("/api/experience/visuals/:id", zValidator("json", schemas.experienceVisualUpdateSchema), async (c) => {
      return c.json(await runtime.updateExperienceVisual(c.req.param("id"), c.req.valid("json")));
    })
    .delete("/api/experience/visuals/:id", async (c) => {
      await runtime.deleteExperienceVisual(c.req.param("id"));
      return c.json({ ok: true });
    })

    // ── Session lifecycle ──────────────────────────────────────────────────
    .post("/api/chats/:chatId/experience/sessions", zValidator("json", schemas.experienceStartRequestSchema), async (c) => {
      const chatId = c.req.param("chatId");
      return c.json(await runtime.startExperienceSession(chatId, c.req.valid("json")));
    })
    .get("/api/experience/sessions/:sessionId", async (c) => {
      return c.json(await runtime.getExperienceSession(c.req.param("sessionId")));
    })
    .post("/api/experience/sessions/:sessionId/end", zValidator("json", schemas.experienceFinishRequestSchema), async (c) => {
      return c.json(await runtime.endExperienceSession(c.req.param("sessionId"), c.req.valid("json")));
    })
    .post("/api/experience/sessions/:sessionId/actions", zValidator("json", schemas.experienceActionRequestSchema), async (c) => {
      return c.json(
        await runtime.submitExperienceAction(c.req.param("sessionId"), c.req.valid("json"), c.req.raw.signal),
      );
    })

    // ── Per-viewer projection reads ────────────────────────────────────────
    .get(
      "/api/experience/sessions/:sessionId/view",
      zValidator("query", z.object({ participantId: z.string().min(1).optional() })),
      async (c) => {
        const { participantId } = c.req.valid("query");
        return c.json(await runtime.getExperienceView(c.req.param("sessionId"), participantId));
      },
    )
    .get(
      "/api/experience/sessions/:sessionId/actions",
      zValidator("query", z.object({ participantId: z.string().min(1).optional() })),
      async (c) => {
        const { participantId } = c.req.valid("query");
        return c.json(await runtime.getExperienceActions(c.req.param("sessionId"), participantId));
      },
    )

    // ── Replay ─────────────────────────────────────────────────────────────
    .post("/api/experience/sessions/:sessionId/undo", zValidator("json", schemas.experienceUndoRequestSchema), async (c) => {
      return c.json(await runtime.undoExperienceSession(c.req.param("sessionId"), c.req.valid("json")));
    })
    .post(
      "/api/experience/sessions/:sessionId/recalculate",
      zValidator("json", schemas.experienceRecalculateRequestSchema),
      async (c) => {
        return c.json(await runtime.previewExperienceRecalculation(c.req.param("sessionId"), c.req.valid("json")));
      },
    )

    // ── Effects (read-only) ────────────────────────────────────────────────
    .get("/api/experience/sessions/:sessionId/effects", async (c) => {
      return c.json(await runtime.getExperienceEffects(c.req.param("sessionId")));
    });
}
