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
 *   effects   — run + retry under /api/experience/effects/:effectId
 *
 * Deferred: effect resolve semantics (Wave 4 model effects), report formatting
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
    .post("/api/experience/sessions/:sessionId/restart", zValidator("json", schemas.experienceRestartRequestSchema), async (c) => {
      const sessionId = c.req.param("sessionId");
      return c.json(await runtime.restartExperienceSession(sessionId, c.req.valid("json")));
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
    // `cancelled` (Wave 4 durable interruption policy). Timer effects are
    // host-scheduled (fix step 2c): the adapter refuses to run them and flags
    // `hostScheduled`, answered 202 — the host scheduler owns their firing.
    .post("/api/experience/effects/:effectId/run", async (c) => {
      const result = await runtime.runExperienceEffect(c.req.param("effectId"), c.req.raw.signal);
      return c.json(result, result.hostScheduled ? 202 : 200);
    })
    // Explicit user retry (lobby effect diagnostics): a failed/cancelled/
    // unknown effect returns to `pending`; the host runner (chat-page
    // lifetime) picks model rows back up and the scheduler owns timer rows —
    // this route never runs the effect. Typed 404 (missing) / 409 (not
    // retryable) surface through the shared DomainError envelope.
    .post("/api/experience/effects/:effectId/retry", async (c) => {
      return c.json(await runtime.retryExperienceEffect(c.req.param("effectId")));
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
    )

    // ── Stateless unsaved-source tester (Wave 8 / IR-81B) ──────────────────
    // Drive UNSAVED rules source through the real sandbox/kernel with zero
    // persistence and zero chat/session/DB binding. Each request is an
    // independent in-memory scenario; these routes never touch a session,
    // store, or chat config. Typed tester failures surface as thrown
    // DomainErrors (409 stale_revision / 422 authoring, validation, capability,
    // or VM faults) via the adapter's mapTestError.
    .post("/api/experience/test/run", zValidator("json", schemas.experienceTestRunRequestSchema), async (c) => {
      return c.json(await runtime.runExperienceTest(c.req.valid("json")));
    })
    .post("/api/experience/test/simulate", zValidator("json", schemas.experienceTestSimulateRequestSchema), async (c) => {
      return c.json(await runtime.simulateExperienceTest(c.req.valid("json")));
    })

    // ── Interactive playground session driver (Wave 8 / IR-84A) ──────────────
    // Drive UNSAVED-or-saved rules through the real kernel as an interactive
    // play loop (start → advance → advance ...) with ZERO persistence and ZERO
    // chat/session/DB binding. start creates the in-memory session and advances
    // leading script seats; advance applies one human action then advances
    // script seats. Typed failures surface as thrown DomainErrors (409
    // stale_revision / 422 authoring, validation, capability, or VM faults) via
    // the adapter's mapTestError, preserving the captured console on the error
    // path.
    .post("/api/experience/playground/start", zValidator("json", schemas.experiencePlaygroundStartRequestSchema), async (c) => {
      return c.json(await runtime.startExperiencePlayground(c.req.valid("json")));
    })
    .post("/api/experience/playground/advance", zValidator("json", schemas.experiencePlaygroundAdvanceRequestSchema), async (c) => {
      return c.json(await runtime.advanceExperiencePlayground(c.req.valid("json")));
    })
    // Timer beat: fire ONE pending timer effect (sleep + reduce server-side).
    // The client's beat loop issues one call per response reporting
    // pendingTimers > 0 — the sandbox's real-time axis. NOT chained into
    // start/advance: the sleep must never lag a click's response.
    .post("/api/experience/playground/timer", zValidator("json", schemas.experiencePlaygroundTimerRequestSchema), async (c) => {
      return c.json(await runtime.runExperiencePlaygroundTimer(c.req.valid("json")));
    })

    // ── Realtime round commit + model seam (RM-7 / REALTIME_EXPERIENCE_MODE_PLAN) ──
    // Commit: the visual loop's client-authoritative round claim. There is
    // deliberately NO revision/CAS compare — RM-8 replay-verifies the log
    // against the session's pinned seed + rules source (mismatch → typed 422,
    // nothing applied) before ONE terminal transition + the finish-writeback
    // chat card. The body is exactly the bridge's round_commit vocabulary.
    .post(
      "/api/experience/sessions/:sessionId/round/commit",
      zValidator("json", schemas.experienceRoundCommitRequestSchema),
      async (c) => {
        return c.json(
          await runtime.commitExperienceRound(c.req.param("sessionId"), c.req.valid("json")),
        );
      },
    )
    // Round-model: one-shot non-streaming generation for a model seat. This is
    // SESSION-LESS and STATELESS (read-only provider resolution, NO effect row)
    // precisely so the playground realtime panel and the live modal host share
    // the same route — the round stays client-authoritative and the reply is
    // just DATA the host posts back into the frame's log.
    .post(
      "/api/experience/round-model",
      zValidator("json", schemas.experienceRoundModelRequestSchema),
      async (c) => {
        return c.json(await runtime.runExperienceRoundModel(c.req.valid("json"), c.req.raw.signal));
      },
    );
}
