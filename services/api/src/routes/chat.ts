import { Hono } from "hono";
import type { ChatRuntimeApi } from "./types.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { logSendDebug } from "../send-debug-log.js";
import * as schemas from "@vibe-tavern/api-contracts";
import { readOptionalJson } from "./helpers.js";
import { extractProviderErrorMessage } from "../ai/provider-error-message.js";

type ChatStreamEvent = { event: string; data: string };
type RouteAbortBridge = ReturnType<typeof createRouteAbortBridge>;
type SseStreamWriter = {
  aborted: boolean;
  onAbort: (callback: () => void) => void;
  writeSSE: (options: ChatStreamEvent) => Promise<void>;
};

function createRouteAbortBridge(requestSignal: AbortSignal, label: string, meta: Record<string, unknown>) {
  const controller = new AbortController();
  const abort = (source: string) => {
    if (controller.signal.aborted) return;
    logSendDebug(`${label}.abort`, { ...meta, source });
    controller.abort(new DOMException("Client closed generation stream", "AbortError"));
  };
  const onRequestAbort = () => abort("request");

  if (requestSignal.aborted) {
    abort("request-preaborted");
  } else {
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }

  return {
    signal: controller.signal,
    abort,
    cleanup: () => requestSignal.removeEventListener("abort", onRequestAbort),
  };
}

async function writeChatSseEvents(
  stream: SseStreamWriter,
  events: AsyncIterable<ChatStreamEvent>,
  abortBridge: RouteAbortBridge,
): Promise<void> {
  stream.onAbort(() => abortBridge.abort("sse"));
  try {
    for await (const event of events) {
      if (stream.aborted) {
        abortBridge.abort("sse-aborted-flag");
        break;
      }
      await stream.writeSSE({ event: event.event, data: event.data });
    }
  } catch (err) {
    if (abortBridge.signal.aborted || stream.aborted) {
      abortBridge.abort("sse-write-error");
      return;
    }

    const message = extractProviderErrorMessage(err);
    logSendDebug("api.route.sse.error", { message });
    try {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
    } catch {
      abortBridge.abort("sse-error-write-failed");
    }
  } finally {
    abortBridge.cleanup();
  }
}

export function createChatRoutes(runtime: ChatRuntimeApi) {
  return new Hono()
    .get("/api/chats/:chatId", async (c) => {
      return c.json(await runtime.getChatSnapshot(c.req.param("chatId")));
    })
    .post("/api/chats", zValidator("json", schemas.createChatSchema), async (c) => {
      const body = c.req.valid("json");
      const characterId = body.characterId;
      if (!characterId) {
        return c.json(await runtime.createFreeChat());
      }
      return c.json(await runtime.createChatForCharacter(characterId));
    })
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
    .post("/api/chats/:chatId/messages/:messageId/branch", async (c) => {
      return c.json(await runtime.branchChat(c.req.param("chatId"), c.req.param("messageId")));
    })
    .patch("/api/chats/:chatId/branches/:branchId", zValidator("json", schemas.renameBranchSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.renameBranch(c.req.param("chatId"), c.req.param("branchId"), body.label));
    })
    .post("/api/chats/:chatId/messages/:messageId/regenerate", async (c) => {
      const chatId = c.req.param("chatId");
      const messageId = c.req.param("messageId");
      const body = await readOptionalJson(c.req.raw);
      const regenStartMs = Date.now();
      logSendDebug("api.route.regenerate.start", { chatId, messageId });
      try {
        const result = await runtime.regenerateMessage(chatId, messageId, body, c.req.raw.signal);
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
    .post("/api/chats/:chatId/messages/:messageId/regenerate/stream", async (c) => {
      const chatId = c.req.param("chatId");
      const messageId = c.req.param("messageId");
      const body = await readOptionalJson(c.req.raw);
      logSendDebug("api.route.regenerate-stream.start", { chatId, messageId });
      const abortBridge = createRouteAbortBridge(c.req.raw.signal, "api.route.regenerate-stream", { chatId, messageId });
      const gen = runtime.regenerateMessageStream(chatId, messageId, body, abortBridge.signal);
      return streamSSE(c, async (stream) => writeChatSseEvents(stream, gen, abortBridge));
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
      return c.json(await runtime.editMessage(c.req.param("chatId"), c.req.param("messageId"), body.content ?? ""));
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
    .delete("/api/chats/:chatId/messages/:messageId", async (c) => {
      return c.json(await runtime.deleteMessage(c.req.param("chatId"), c.req.param("messageId")));
    })
    .post("/api/chats/:chatId/messages", zValidator("json", schemas.sendMessageSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.messages.post", { chatId, contentLength: body.content?.length ?? 0 });
      try {
        return c.json(await runtime.sendMessage(chatId, body, c.req.raw.signal));
      } catch (err) {
        if (err instanceof (await import("../ai/vision-gate.js")).VisionNotSupportedError) {
          return c.json({ type: "vision_not_supported", message: err.message, attachments: err.attachmentNames }, 422);
        }
        throw err;
      }
    })
    .post("/api/chats/:chatId/messages/stream", zValidator("json", schemas.sendMessageSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.messages-stream.post", { chatId, contentLength: body.content?.length ?? 0 });
      const abortBridge = createRouteAbortBridge(c.req.raw.signal, "api.route.messages-stream", { chatId });
      const gen = runtime.sendMessageStream(chatId, body, abortBridge.signal);
      return streamSSE(c, async (stream) => writeChatSseEvents(stream, gen, abortBridge));
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
      return c.json(await runtime.generateChatSummary(chatId, body, c.req.raw.signal));
    })
    .patch("/api/chats/:chatId/memory-settings", zValidator("json", schemas.updateMemorySettingsSchema), async (c) => {
      return c.json(await runtime.updateMemorySettings(c.req.param("chatId"), c.req.valid("json")));
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
      const abortBridge = createRouteAbortBridge(c.req.raw.signal, "api.route.generate-reply-stream", { chatId });
      const gen = runtime.generateReplyStream(chatId, abortBridge.signal);
      return streamSSE(c, async (stream) => writeChatSseEvents(stream, gen, abortBridge));
    })
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
      runtime.deleteChat(c.req.param("chatId"));
      return c.body(null, 204);
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
  ;
}
