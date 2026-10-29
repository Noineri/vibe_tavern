import { Hono } from "hono";
import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import * as schemas from "@vibe-tavern/api-contracts";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { createRouteAbortBridge, writeAgentSseEvents as writeCopilotSseEvents } from "./agent-sse-transport.js";
export { writeAgentSseEvents as writeCopilotSseEvents } from "./agent-sse-transport.js";
import { AgentRunActiveError } from "../../domain/agent/agent-run-registry.js";
import {
  NoAgentKindForScriptKindError,
  UnknownAgentKindError,
  AgentKindNotWiredError,
} from "../../domain/agent/agent-kind-registry.js";

export function createExperienceCopilotRoutes(runtime: ExperienceCopilotRuntimeApi) {
  return new Hono()
    .post(
      "/api/experience-copilot/:threadId/stream",
      zValidator("json", schemas.experienceCopilotStreamRequestSchema),
      async (c) => {
        const threadId = c.req.param("threadId");
        const body = c.req.valid("json");
        logSendDebug("api.route.experience-copilot-stream.post", {
          threadId,
          contentLength: body.content?.length ?? 0,
          answerToolCallId: body.answer?.toolCallId ?? null,
        });
        // AS-2c kind resolution inside StartRun: run BEFORE the SSE
        // headers are sent so an unserved script kind is a 400 JSON response
        // (mirrors this file's `{ error }` response shape, plus the registry
        // error's machine-readable `code`), never an in-stream SSE error.
        // Today interactive → experience always resolves, so behavior is
        // unchanged on every reachable state.
        const abortBridge = createRouteAbortBridge(c.req.raw.signal, "api.route.experience-copilot-stream", { threadId });
        try {
          const events = await runtime.experienceCopilotStartRun(threadId, body, abortBridge.signal);
          return streamSSE(c, async (stream) => writeCopilotSseEvents(stream, events, abortBridge));
        } catch (err) {
          abortBridge.cleanup();
          if (err instanceof AgentRunActiveError) {
            return c.json({ error: err.message, code: err.code } satisfies schemas.ExperienceCopilotRunActiveError, 409);
          }
          if (
            err instanceof NoAgentKindForScriptKindError ||
            err instanceof UnknownAgentKindError ||
            err instanceof AgentKindNotWiredError
          ) {
            return c.json({ error: err.message, code: err.code }, 400);
          }
          throw err;
        }
      },
    )
    .get(
      "/api/experience-copilot/:threadId/run",
      zValidator("query", schemas.experienceCopilotRunQuerySchema),
      (c) => {
        const threadId = c.req.param("threadId");
        const bridge = createRouteAbortBridge(c.req.raw.signal, "api.route.experience-copilot-run", { threadId });
        const events = runtime.experienceCopilotSubscribeRun(threadId, c.req.valid("query").after, bridge.signal);
        if (!events) {
          bridge.cleanup();
          return c.body(null, 204);
        }
        return streamSSE(c, async (stream) => writeCopilotSseEvents(stream, events, bridge));
      },
    )
    .post("/api/experience-copilot/:threadId/stop", (c) =>
      c.json(runtime.experienceCopilotStopRun(c.req.param("threadId"))))
    .get("/api/experience-copilot/:threadId/review", async (c) =>
      c.json(await runtime.experienceCopilotGetReview(c.req.param("threadId"))))
    .put("/api/experience-copilot/:threadId/review", zValidator("json", schemas.agentReviewEnvelopeSchema), async (c) =>
      c.json(await runtime.experienceCopilotPutReview(c.req.param("threadId"), c.req.valid("json"))))
    .delete("/api/experience-copilot/:threadId/review", async (c) =>
      c.json(await runtime.experienceCopilotDeleteReview(c.req.param("threadId"))))
    .get("/api/experience-copilot/script/:scriptId/active", async (c) => {
      const scriptId = c.req.param("scriptId");
      return c.json(await runtime.experienceCopilotGetActive(scriptId));
    })
    // CA-4e1: registered before the `:threadId`-shaped GETs; a single-segment
    // literal cannot collide with them (they all carry a second segment), but
    // keep the literal first so the match never even consults them.
    .get(
      "/api/experience-copilot/image-route",
      zValidator("query", z.object({ providerProfileId: z.string(), model: z.string().optional() })),
      async (c) => {
        const query = c.req.valid("query");
        return c.json(await runtime.experienceCopilotGetImageRoute(query.providerProfileId, query.model));
      },
    )
    .get("/api/experience-copilot/:threadId/messages", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotListMessages(threadId));
    })
    .post(
      "/api/experience-copilot/script/:scriptId/session",
      zValidator("json", z.object({ title: z.string().optional() }).optional()),
      async (c) => {
        const scriptId = c.req.param("scriptId");
        const body = c.req.valid("json");
        return c.json(await runtime.experienceCopilotStartNewSession(scriptId, body?.title));
      },
    )
    .get("/api/experience-copilot/script/:scriptId/sessions", async (c) => {
      const scriptId = c.req.param("scriptId");
      return c.json(await runtime.experienceCopilotListSessions(scriptId));
    })
    .post("/api/experience-copilot/:threadId/activate", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotActivate(threadId));
    })
    .post("/api/experience-copilot/:threadId/archive", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotArchive(threadId));
    })
    .patch(
      "/api/experience-copilot/:threadId/title",
      zValidator("json", z.object({ title: z.string().max(120) })),
      async (c) => {
        const threadId = c.req.param("threadId");
        return c.json(await runtime.experienceCopilotRenameSession(threadId, c.req.valid("json").title));
      },
    )
    .get("/api/experience-copilot/:threadId/context", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotGetContext(threadId));
    })
    .patch(
      "/api/experience-copilot/:threadId/context",
      zValidator("json", z.object({ autoCompact: z.boolean().optional() })),
      async (c) => {
        const threadId = c.req.param("threadId");
        const body = c.req.valid("json");
        return c.json(await runtime.experienceCopilotPatchContext(threadId, body));
      },
    )
    .get("/api/experience-copilot/:threadId/context-links", async (c) => {
      const threadId = c.req.param("threadId");
      return c.json(await runtime.experienceCopilotGetContextLinks(threadId));
    })
    .patch(
      "/api/experience-copilot/:threadId/context-links",
      zValidator("json", schemas.setCopilotContextLinksSchema),
      async (c) => {
        const threadId = c.req.param("threadId");
        return c.json(await runtime.experienceCopilotSetContextLinks(threadId, c.req.valid("json").links));
      },
    )
    .post(
      "/api/experience-copilot/:threadId/compact",
      zValidator("json", z.object({ providerProfileId: z.string().optional(), model: z.string().optional() })),
      async (c) => {
        const threadId = c.req.param("threadId");
        const body = c.req.valid("json");
        // AS-10h: kind-resolution errors map to the same 400 JSON shape the
        // stream route's assert step uses (an unwired kind is a server wiring
        // bug surfacing as 400, not the client's 500); any other error
        // propagates unchanged.
        try {
          return c.json(await runtime.experienceCopilotCompact(threadId, body, c.req.raw.signal));
        } catch (err) {
          if (
            err instanceof NoAgentKindForScriptKindError ||
            err instanceof UnknownAgentKindError ||
            err instanceof AgentKindNotWiredError
          ) {
            return c.json({ error: err.message, code: err.code }, 400);
          }
          throw err;
        }
      },
    )
    .post(
      "/api/experience-copilot/:threadId/messages/:messageId/attachments/:attachmentId/summarize",
      zValidator("json", z.object({ providerProfileId: z.string().optional(), model: z.string().optional() }).optional()),
      async (c) => c.json(await runtime.experienceCopilotSummarizeAttachment(
        c.req.param("threadId"), c.req.param("messageId"), c.req.param("attachmentId"), c.req.valid("json") ?? {}, c.req.raw.signal,
      )),
    )
    .post(
      "/api/experience-copilot/:threadId/messages/:messageId/attachments/:attachmentId/clear-summary", async (c) =>
        c.json(await runtime.experienceCopilotClearAttachmentSummary(c.req.param("threadId"), c.req.param("messageId"), c.req.param("attachmentId"))))
    .patch(
      "/api/experience-copilot/:threadId/messages/:messageId/attachments/:attachmentId/description",
      zValidator("json", z.object({ description: z.string() })),
      async (c) => c.json(await runtime.experienceCopilotUpdateAttachmentDescription(
        c.req.param("threadId"), c.req.param("messageId"), c.req.param("attachmentId"), c.req.valid("json").description,
      )),
    )
    .post(
      "/api/experience-copilot/:threadId/messages/:messageId/attachments/:attachmentId/regenerate-description",
      zValidator("json", z.object({ providerProfileId: z.string().optional(), model: z.string().optional() }).optional()),
      async (c) => c.json(await runtime.experienceCopilotRegenerateAttachmentDescription(
        c.req.param("threadId"), c.req.param("messageId"), c.req.param("attachmentId"), c.req.valid("json") ?? {}, c.req.raw.signal,
      )),
    )
    .patch(
      "/api/experience-copilot/:threadId/messages/:messageId/attachments/:attachmentId/include-in-prompt",
      zValidator("json", z.object({ includeInPrompt: z.boolean() })),
      async (c) => c.json(await runtime.experienceCopilotSetAttachmentIncluded(
        c.req.param("threadId"), c.req.param("messageId"), c.req.param("attachmentId"), c.req.valid("json").includeInPrompt,
      )),
    )
    .delete("/api/experience-copilot/:threadId/messages/:messageId/attachments/:attachmentId", async (c) =>
      c.json(await runtime.experienceCopilotDeleteAttachment(c.req.param("threadId"), c.req.param("messageId"), c.req.param("attachmentId"))))
    .post(
      "/api/experience-copilot/:threadId/turns/delete",
      zValidator("json", z.object({ messageId: z.string(), includeUserMessage: z.boolean(), keepAttachmentFiles: z.boolean().optional() })),
      async (c) => {
        const threadId = c.req.param("threadId");
        const body = c.req.valid("json");
        // AP-8: the adapter maps the store's refusal families onto the shared
        // DomainError vocabulary — they propagate to the global handler (the
        // compact endpoint's error family), so no local catch here.
        return c.json(await runtime.experienceCopilotDeleteTurn(threadId, body));
      },
    )
    .patch(
      "/api/experience-copilot/:threadId/messages/:messageId",
      zValidator("json", schemas.experienceCopilotMessageEditSchema),
      async (c) => {
        const threadId = c.req.param("threadId");
        const messageId = c.req.param("messageId");
        // AP-30: same convention as /turns/delete — the adapter maps the
        // store's refusal families (typed 400 reason codes / 404s) onto the
        // shared DomainError vocabulary, which the global handler serializes.
        return c.json(
          await runtime.experienceCopilotEditMessage(threadId, messageId, c.req.valid("json").content),
        );
      },
    );
}
