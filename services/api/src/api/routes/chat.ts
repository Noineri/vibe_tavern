import { Hono, type Context } from "hono";
import type { ChatRuntimeApi } from "../contract/runtime-api.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { logSendDebug } from "../../shared/send-debug-log.js";
import * as schemas from "@vibe-tavern/api-contracts";
import { userMessageSavedFlag } from "../../domain/chat/user-message-saved.js";
import { AgentRunActiveError } from "../../domain/agent/agent-run-registry.js";
import type { ChatGenerationTurn } from "../contract/chat-runtime-contracts.js";
import { createRouteAbortBridge, writeAgentSseEvents } from "./agent-sse-transport.js";

async function startChatGenerationSse(c: Context, runtime: ChatRuntimeApi, chatId: string, operation: schemas.ChatGenerationOperation, turn: ChatGenerationTurn) {
  const bridge = createRouteAbortBridge(c.req.raw.signal, "api.route.chat-generation", { chatId });
  try {
    const events = await runtime.startChatGeneration(chatId, operation, turn, bridge.signal);
    return streamSSE(c, (stream) => writeAgentSseEvents(stream, events, bridge));
  } catch (error) {
    bridge.cleanup();
    if (error instanceof AgentRunActiveError) return c.json({ error: error.message, code: error.code }, 409);
    throw error;
  }
}

export function createChatRoutes(runtime: ChatRuntimeApi) {
  return new Hono()
    .get("/api/chats/:chatId", async (c) => {
      return c.json(await runtime.getChatSnapshot(c.req.param("chatId")));
    })
    .get("/api/chats/:chatId/queue", async (c) => c.json(await runtime.getGenerationQueue(c.req.param("chatId"))))
    .post("/api/chats/:chatId/queue", zValidator("json", schemas.enqueueChatGenerationJobSchema), async (c) =>
      c.json(await runtime.enqueueGenerationJob(c.req.param("chatId"), c.req.valid("json")), 201))
    .delete("/api/chats/:chatId/queue/:jobId", async (c) =>
      c.json(await runtime.cancelGenerationJob(c.req.param("chatId"), c.req.param("jobId"))))
    .post("/api/chats/:chatId/queue/clear", async (c) => c.json(await runtime.clearGenerationQueue(c.req.param("chatId"))))
    .get("/api/chats/:chatId/image-route", async (c) => {
      return c.json(await runtime.getImageRoute(c.req.param("chatId")));
    })
    .post("/api/chats", zValidator("json", schemas.createChatSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createChatForCharacter(body.characterId, body.mode));
    })
    .get("/api/characters/:characterId/coauthor-chats", async (c) => {
      return c.json(await runtime.listCoauthorChats(c.req.param("characterId")));
    })
    .get("/api/coauthor/modules", async (c) => {
      return c.json({ modules: await runtime.listCoauthorModules() });
    })
    .post("/api/coauthor/modules", zValidator("json", schemas.coauthorModuleCreateSchema), async (c) => {
      return c.json(await runtime.createCoauthorModule(c.req.valid("json")));
    })
    // Registered BEFORE the :moduleId PATCH so the literal "reorder" segment
    // is matched here, not swallowed as a module id (the proxies/reorder
    // pattern; Hono matches registration order).
    .patch("/api/coauthor/modules/reorder", zValidator("json", schemas.reorderCoauthorModulesSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json({ modules: await runtime.reorderCoauthorModules(body.updates) });
    })
    .patch("/api/coauthor/modules/:moduleId", zValidator("json", schemas.coauthorModuleUpdateSchema), async (c) => {
      return c.json(await runtime.updateCoauthorModule(c.req.param("moduleId"), c.req.valid("json")));
    })
    .delete("/api/coauthor/modules/:moduleId", async (c) => {
      await runtime.deleteCoauthorModule(c.req.param("moduleId"));
      return c.json({ ok: true });
    })
    .patch("/api/chats/:chatId/coauthor-module", zValidator("json", schemas.setCoauthorModuleSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setCoauthorModule(c.req.param("chatId"), body.moduleId));
    })
    .post("/api/chats/:chatId/coauthor/apply", zValidator("json", schemas.coauthorApplySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.applyCoauthorDraft(c.req.param("chatId"), body));
    })
    .get("/api/chats/:chatId/coauthor/review", async (c) => c.json(await runtime.getCoauthorReview(c.req.param("chatId"))))
    .put("/api/chats/:chatId/coauthor/review", zValidator("json", schemas.coauthorReviewEnvelopeSchema), async (c) =>
      c.json(await runtime.putCoauthorReview(c.req.param("chatId"), c.req.valid("json"))))
    .delete("/api/chats/:chatId/coauthor/review", async (c) => c.json(await runtime.deleteCoauthorReview(c.req.param("chatId"))))
    .post("/api/chats/:chatId/clone", async (c) => {
      return c.json(await runtime.cloneChat(c.req.param("chatId")));
    })
    .get("/api/chats/:chatId/export.jsonl", async (c) => {
      return c.text(
        await runtime.exportChatJsonl(c.req.param("chatId")),
        200,
        { "Content-Type": "application/x-ndjson; charset=utf-8" },
      );
    })
    .get("/api/prompt-traces/:traceId/export", async (c) => {
      const data = await runtime.exportPromptTrace(c.req.param("traceId"));
      c.header("Content-Disposition", `attachment; filename="${c.req.param("traceId")}.json"`);
      return c.json(data);
    })
    .get("/api/chats/:chatId/traces", zValidator("query", z.object({
      messageId: z.string().optional(),
      branchId: z.string().optional(),
    })), async (c) => {
      // Lazy-loaded trace history. Server-side filters; the frontend never
      // receives traces outside the requested scope (branchId / messageId).
      const chatId = c.req.param("chatId");
      const { messageId, branchId } = c.req.valid("query");
      return c.json(await runtime.listPromptTraces(chatId, { messageId, branchId }));
    })
    .post("/api/chats/:chatId/branches/:branchId/context-preview", async (c) => {
      // Live context preview — a standalone branch-scoped query, decoupled
      // from every navigation/mutation response so switching chats or branches
      // never blocks on prompt assembly. POST (not GET) because current
      // assembly persists lore/script activation state. The response echoes
      // the immutable { chatId, branchId } target so the client can reject a
      // result that no longer matches the active branch.
      return c.json(await runtime.getContextPreview(c.req.param("chatId"), c.req.param("branchId")));
    })
    .post("/api/chats/:chatId/messages/:messageId/branch", async (c) => {
      return c.json(await runtime.branchChat(c.req.param("chatId"), c.req.param("messageId")));
    })
    .patch("/api/chats/:chatId/branches/:branchId", zValidator("json", schemas.renameBranchSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.renameBranch(c.req.param("chatId"), c.req.param("branchId"), body.label));
    })
    .post("/api/chats/:chatId/messages/:messageId/regenerate", zValidator("json", schemas.regenerateOverrideSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const messageId = c.req.param("messageId");
      // A request without a JSON content type validates as `{}` (no override).
      const override = c.req.valid("json");
      const regenStartMs = Date.now();
      logSendDebug("api.route.regenerate.start", { chatId, messageId });
      try {
        const result = await runtime.regenerateMessage(chatId, messageId, override, c.req.raw.signal);
        logSendDebug("api.route.regenerate.done", { chatId, messageId, elapsedMs: Date.now() - regenStartMs });
        return c.json(result);
      } catch (err) {
        logSendDebug("api.route.regenerate.error", {
          chatId,
          messageId,
          elapsedMs: Date.now() - regenStartMs,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    })
    .post("/api/chats/:chatId/messages/:messageId/regenerate/stream", zValidator("json", schemas.regenerateOverrideSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const messageId = c.req.param("messageId");
      const override = c.req.valid("json");
      logSendDebug("api.route.regenerate-stream.start", { chatId, messageId });
      return startChatGenerationSse(c, runtime, chatId, { operation: "regenerate", messageId }, (signal) => runtime.regenerateMessageStream(chatId, messageId, override, signal));
    })
    .post("/api/chats/:chatId/messages/:messageId/continue", async (c) => {
      // LS-4a: continue the last assistant reply from its selected variant's
      // text — the variant rides as the pushed-assistant continuation point
      // and the result appends as a new variant of the target message. No
      // body: the continuation text resolves server-side.
      const chatId = c.req.param("chatId");
      const messageId = c.req.param("messageId");
      logSendDebug("api.route.continue.start", { chatId, messageId });
      return c.json(await runtime.continueMessage(chatId, messageId, c.req.raw.signal));
    })
    .post("/api/chats/:chatId/messages/:messageId/continue/stream", async (c) => {
      const chatId = c.req.param("chatId");
      const messageId = c.req.param("messageId");
      logSendDebug("api.route.continue-stream.start", { chatId, messageId });
      return startChatGenerationSse(c, runtime, chatId, { operation: "continue", messageId }, (signal) => runtime.continueMessageStream(chatId, messageId, signal));
    })
    .post("/api/chats/:chatId/messages/:messageId/variants/:variantIndex/select", async (c) => {
      return c.json(
        await runtime.selectVariant(
          c.req.param("chatId"),
          c.req.param("messageId"),
          Number(c.req.param("variantIndex")),
        ),
      );
    })
    .put("/api/chats/:chatId/messages/:messageId/variants/:variantIndex/tts-annotation", zValidator("json", schemas.setVariantTtsAnnotationSchema), async (c) => {
      // TPE-1 (AN-1): set/clear the per-variant narration annotation — the
      // AI editor's "prepare for narration" button writes here (TPE-2).
      return c.json(
        await runtime.setVariantTtsAnnotation(
          c.req.param("chatId"),
          c.req.param("messageId"),
          Number(c.req.param("variantIndex")),
          c.req.valid("json").text,
        ),
      );
    })
    .post("/api/chats/:chatId/messages/:messageId/variants", zValidator("json", schemas.createMessageVariantSchema), async (c) => {
      return c.json(await runtime.addEditorVariant(c.req.param("chatId"), c.req.param("messageId"), c.req.valid("json")));
    })
    .delete("/api/chats/:chatId/messages/:messageId/variants/:variantIndex", async (c) => {
      return c.json(
        await runtime.deleteVariant(
          c.req.param("chatId"),
          c.req.param("messageId"),
          Number(c.req.param("variantIndex")),
        ),
      );
    })
    .patch("/api/chats/:chatId/messages/:messageId", zValidator("json", schemas.editMessageSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.editMessage(c.req.param("chatId"), c.req.param("messageId"), body.content ?? "", body.expectedVariantId));
    })
    .patch("/api/chats/:chatId/messages/:messageId/attachments/:attachmentId/description", async (c) => {
      const body = await c.req.json<{ description: string }>().catch(() => ({ description: "" }));
      return c.json(await runtime.updateAttachmentDescription(
        c.req.param("chatId"),
        c.req.param("messageId"),
        c.req.param("attachmentId"),
        body.description ?? "",
      ));
    })
    .patch("/api/chats/:chatId/messages/:messageId/attachments/:attachmentId/include-in-prompt", async (c) => {
      const body = await c.req.json<{ includeInPrompt: boolean }>().catch(() => ({ includeInPrompt: false }));
      return c.json(await runtime.updateAttachmentIncludeInPrompt(
        c.req.param("chatId"),
        c.req.param("messageId"),
        c.req.param("attachmentId"),
        body.includeInPrompt === true,
      ));
    })
    .patch("/api/chats/:chatId/messages/:messageId/attachments/:attachmentId/prompt", async (c) => {
      const body = await c.req.json<{ prompt: string }>().catch(() => ({ prompt: "" }));
      return c.json(await runtime.updateAttachmentPrompt(
        c.req.param("chatId"),
        c.req.param("messageId"),
        c.req.param("attachmentId"),
        body.prompt ?? "",
      ));
    })
    .delete("/api/chats/:chatId/messages/:messageId/attachments/:attachmentId", async (c) => {
      return c.json(await runtime.deleteAttachment(
        c.req.param("chatId"),
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      ));
    })
    .post("/api/chats/:chatId/messages/:messageId/attachments/:attachmentId/regenerate-description", async (c) => {
      return c.json(await runtime.regenerateAttachmentDescription(
        c.req.param("chatId"),
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      ));
    })
    .delete("/api/chats/:chatId/messages/:messageId", async (c) => {
      return c.json(await runtime.deleteMessage(c.req.param("chatId"), c.req.param("messageId")));
    })
    .post("/api/chats/:chatId/messages/:messageId/attachments/:attachmentId/summarize", async (c) => {
      return c.json(await runtime.summarizeAttachment(
        c.req.param("chatId"), c.req.param("messageId"), c.req.param("attachmentId"), c.req.raw.signal,
      ));
    })
    .post("/api/chats/:chatId/messages/:messageId/attachments/:attachmentId/clear-summary", async (c) => {
      return c.json(await runtime.clearAttachmentSummary(
        c.req.param("chatId"), c.req.param("messageId"), c.req.param("attachmentId"),
      ));
    })
    .post("/api/chats/:chatId/messages", zValidator("json", schemas.sendMessageSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.messages.post", { chatId, contentLength: body.content?.length ?? 0 });
      try {
        return c.json(await runtime.sendMessage(chatId, body, c.req.raw.signal));
      } catch (err) {
        if (err instanceof (await import("../../infrastructure/ai/vision-gate.js")).VisionNotSupportedError) {
          return c.json({ type: "vision_not_supported", message: err.message, attachments: err.attachmentNames, ...userMessageSavedFlag(err) }, 422);
        }
        if (err instanceof (await import("../../infrastructure/ai/stt-gate.js")).VoiceTranscribeUnavailableError) {
          return c.json({ type: "voice_transcribe_unavailable", message: err.message, attachments: err.attachmentNames, ...userMessageSavedFlag(err) }, 422);
        }
        throw err;
      }
    })
    .post("/api/chats/:chatId/messages/stream", zValidator("json", schemas.sendMessageSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.messages-stream.post", { chatId, contentLength: body.content?.length ?? 0 });
      return startChatGenerationSse(c, runtime, chatId, { operation: "send", messageId: null }, (signal) => runtime.sendMessageStream(chatId, body, signal));
    })
    .get("/api/chats/:chatId/summaries", async (c) => {
      return c.json(await runtime.listChatSummaries(c.req.param("chatId")));
    })
    .post("/api/chats/:chatId/summaries", zValidator("json", schemas.createChatSummarySchema), async (c) => {
      return c.json(await runtime.createChatSummary(c.req.param("chatId"), c.req.valid("json")), 201);
    })
    .patch("/api/chats/:chatId/summaries/:summaryId", zValidator("json", schemas.updateChatSummarySchema), async (c) => {
      return c.json(await runtime.updateChatSummaryRecord(c.req.param("chatId"), c.req.param("summaryId"), c.req.valid("json")));
    })
    .delete("/api/chats/:chatId/summaries/:summaryId", async (c) => {
      return c.json(await runtime.deleteChatSummaryRecord(c.req.param("chatId"), c.req.param("summaryId")));
    })
    .post("/api/chats/:chatId/summaries/generate", zValidator("json", schemas.generateChatSummarySchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.summaries.generate", { chatId, providerProfileId: body.providerProfileId, model: body.model ?? null, from: body.summarizedFrom, to: body.summarizedTo });
      try {
        return c.json(await runtime.generateChatSummary(chatId, body));
      } catch (error) {
        if (error instanceof AgentRunActiveError) return c.json({ error: error.message, code: error.code }, 409);
        throw error;
      }
    })
    .get("/api/chats/:chatId/summaries/generate", (c) =>
      c.json(runtime.getManualSummaryRun(c.req.param("chatId"))))
    .post("/api/chats/:chatId/summaries/generate/stop", (c) =>
      c.json(runtime.stopManualSummary(c.req.param("chatId"))))
    .put("/api/chats/:chatId/summaries/reorder", zValidator("json", schemas.reorderChatSummariesSchema), async (c) => {
      // SUM-3b: manual summary-list order (store-side transactional rewrite
      // over the ACTIVE branch, matching listChatSummaries' branch scope).
      return c.json(await runtime.reorderChatSummaries(c.req.param("chatId"), c.req.valid("json")));
    })
    .patch("/api/chats/:chatId/memory-settings", zValidator("json", schemas.updateMemorySettingsSchema), async (c) => {
      return c.json(await runtime.updateMemorySettings(c.req.param("chatId"), c.req.valid("json")));
    })
    .patch("/api/chats/:chatId/insights-config", zValidator("json", schemas.updateInsightsConfigSchema), async (c) => {
      return c.json(await runtime.updateInsightsConfig(c.req.param("chatId"), c.req.valid("json")));
    })
    .post("/api/chats/:chatId/summary", zValidator("json", schemas.summarizeChatSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.summary.post", { chatId, providerProfileId: body.providerProfileId, model: body.model ?? null, maxMessages: body.maxMessages });
      return c.json(await runtime.summarizeChat(chatId, body, c.req.raw.signal));
    })
    .put("/api/chats/:chatId/summary", zValidator("json", schemas.saveChatSummarySchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      return c.json(await runtime.saveChatSummary(chatId, body));
    })
    .post("/api/chats/:chatId/generate-reply", async (c) => {
      const chatId = c.req.param("chatId");
      logSendDebug("api.route.generate-reply.post", { chatId });
      return c.json(await runtime.generateReply(chatId, c.req.raw.signal));
    })
    .post("/api/chats/:chatId/generate-reply/stream", async (c) => {
      const chatId = c.req.param("chatId");
      logSendDebug("api.route.generate-reply-stream.post", { chatId });
      return startChatGenerationSse(c, runtime, chatId, { operation: "generate", messageId: null }, (signal) => runtime.generateReplyStream(chatId, signal));
    })
    .get("/api/chats/:chatId/generation", zValidator("query", schemas.experienceCopilotRunQuerySchema), (c) => {
      const chatId = c.req.param("chatId");
      const bridge = createRouteAbortBridge(c.req.raw.signal, "api.route.chat-generation-replay", { chatId });
      const events = runtime.subscribeChatGeneration(chatId, c.req.valid("query").after, bridge.signal);
      if (!events) { bridge.cleanup(); return c.body(null, 204); }
      return streamSSE(c, (stream) => writeAgentSseEvents(stream, events, bridge));
    })
    .post("/api/chats/:chatId/generation/stop", (c) => c.json(runtime.stopChatGeneration(c.req.param("chatId"))))
    .post("/api/chats/:chatId/set-persona", zValidator("json", schemas.setPersonaSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setChatPersona(c.req.param("chatId"), body.personaId));
    })
    .post("/api/chats/:chatId/set-prompt-preset", zValidator("json", schemas.setPromptPresetSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setChatPromptPreset(c.req.param("chatId"), body.promptPresetId));
    })
    .post("/api/chats/:chatId/fork", zValidator("json", z.object({ fromMessageId: z.string().optional() })), async (c) => {
      const { fromMessageId } = c.req.valid("json");
      return c.json(await runtime.forkBranch(c.req.param("chatId"), fromMessageId));
    })
    .post("/api/chats/:chatId/branches/:branchId/activate", async (c) => {
      return c.json(await runtime.activateBranch(c.req.param("chatId"), c.req.param("branchId")));
    })
    .delete("/api/chats/:chatId/branches/:branchId", async (c) => {
      return c.json(await runtime.deleteBranch(c.req.param("chatId"), c.req.param("branchId")));
    })
    .delete("/api/chats/:chatId", async (c) => {
      return c.json(await runtime.deleteChat(c.req.param("chatId")));
    })
    .post("/api/chats/:chatId/clear", async (c) => {
      const snapshot = await runtime.clearChat(c.req.param("chatId"));
      return c.json(snapshot);
    })
    .patch("/api/chats/:chatId/title", zValidator("json", schemas.renameChatSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.renameChat(c.req.param("chatId"), body.title));
    })
    .patch("/api/chats/:chatId/greeting-index", zValidator("json", schemas.setGreetingIndexSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setGreetingIndex(c.req.param("chatId"), body.greetingIndex));
    })
    .patch("/api/chats/:chatId/coauthor-context-links", zValidator("json", schemas.setCoauthorContextLinksSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.setCoauthorContextLinks(c.req.param("chatId"), body.links));
    })
    .patch("/api/chats/:chatId/dynamic-prompt", zValidator("json", schemas.updateDynamicPromptSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateDynamicPrompt(c.req.param("chatId"), body));
    })
  ;
}
