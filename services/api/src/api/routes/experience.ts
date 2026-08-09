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
    // Branch-scoped active-session discovery (IR-70A). Strict query: branchId is
    // required (a missing branchId is 400, never an implicit active-branch
    // default) so a stale URL cannot silently follow whichever branch is active.
    .get(
      "/api/chats/:chatId/experience/session",
      zValidator("query", z.object({ branchId: z.string().min(1).max(schemas.INTERACTIVE_SCHEMA_MAX_ID) })),
      async (c) => {
        const chatId = c.req.param("chatId");
        const { branchId } = c.req.valid("query");
        return c.json(await runtime.getActiveExperienceSession(chatId, branchId));
      },
    )
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

    // ── Queued-attachment read (IR-70A) ───────────────────────────────────
    // Privacy-safe: returns only public display/commit-intent fields (never the
    // hidden checkpoint). The service verifies the session exists before reading.
    .get("/api/experience/sessions/:sessionId/attachment", async (c) => {
      return c.json(await runtime.getExperienceQueuedAttachment(c.req.param("sessionId")));
    })
    .post(
      "/api/experience/sessions/:sessionId/reports/queue",
      zValidator("json", schemas.experienceReportQueueRequestSchema),
      async (c) => c.json(await runtime.queueExperienceReport(c.req.param("sessionId"), c.req.valid("json"))),
    )
    .get("/api/experience/sessions/:sessionId/reports/status", async (c) => {
      return c.json(await runtime.getExperienceReportStatus(c.req.param("sessionId")));
    })

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
    })
    // Run one pending model effect to a terminal state and feed the result
    // back into the reducer. The request signal wires client-disconnect →
    // `cancelled` (Wave 4 durable interruption policy).
    .post("/api/experience/effects/:effectId/run", async (c) => {
      return c.json(await runtime.runExperienceEffect(c.req.param("effectId"), c.req.raw.signal));
    })

    // ── Context capture + status (IR-70D) ────────────────────────────────────
    // Explicit cancellable context capture. The signal passes all the way to
    // captureContext so a compact-summary disconnect cancels and preserves the
    // previous bundle. Body is strict: unknown keys are rejected; mode/model/ids
    // are bounded.
    .post(
      "/api/experience/sessions/:sessionId/context/capture",
      zValidator("json", schemas.experienceContextCaptureRequestSchema),
      async (c) => {
        return c.json(
          await runtime.captureExperienceContext(c.req.param("sessionId"), c.req.valid("json"), c.req.raw.signal),
        );
      },
    )
    // Privacy-safe context-bundle status (IR-70D). Returns null when never
    // captured; otherwise ONLY session metadata + provider/model ids — never
    // payload fields like variantsJson, compactSummaryJson, or snapshots.
    .get("/api/experience/sessions/:sessionId/context/status", async (c) => {
      return c.json(await runtime.getExperienceContextStatus(c.req.param("sessionId")));
    })

    // ── Prompt overrides (IR-70D) ────────────────────────────────────────────
    // Read both independent layers (global + current-character) through the
    // `model` capability gate. Never collapses to the effective winner only.
    .get("/api/experience/sessions/:sessionId/prompt-overrides", async (c) => {
      return c.json(await runtime.getExperiencePromptOverrides(c.req.param("sessionId")));
    })
    // Write the global prompt-override layer. Requires `model`. Returns the
    // updated combined layers.
    .put(
      "/api/experience/sessions/:sessionId/prompt-overrides/global",
      zValidator("json", schemas.experiencePromptOverrideContentSchema),
      async (c) => {
        return c.json(
          await runtime.updateExperienceGlobalOverride(c.req.param("sessionId"), c.req.valid("json")),
        );
      },
    )
    // Write the current-character prompt-override layer. Requires `model` + the
    // session's chat must have a character (otherwise typed 422). Derives the
    // character from session → chat; never accepts an arbitrary characterId.
    .put(
      "/api/experience/sessions/:sessionId/prompt-overrides/character",
      zValidator("json", schemas.experiencePromptOverrideContentSchema),
      async (c) => {
        return c.json(
          await runtime.updateExperienceCharacterOverride(c.req.param("sessionId"), c.req.valid("json")),
        );
      },
    );
}
