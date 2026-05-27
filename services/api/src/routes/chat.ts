import { Hono } from "hono";
import type { RuntimeApi } from "./types.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { logSendDebug } from "../send-debug-log.js";
import * as schemas from "@vibe-tavern/api-contracts";
import { readOptionalJson } from "./helpers.js";

export function createChatRoutes(runtime: RuntimeApi) {
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
      return c.json(await runtime.exportPromptTrace(c.req.param("traceId")));
    })
    .patch("/api/chats/:chatId/settings", zValidator("json", schemas.updateChatSettingsSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updateChatSettings(c.req.param("chatId"), body),
      );
    })
    .post("/api/chats/:chatId/messages/:messageId/branch", async (c) => {
      return c.json(await runtime.branchChat(c.req.param("chatId"), c.req.param("messageId")));
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
      const gen = runtime.regenerateMessageStream(chatId, messageId, body, c.req.raw.signal);
      return streamSSE(c, async (stream) => {
        for await (const event of gen) {
          await stream.writeSSE({ event: event.event, data: event.data });
        }
      });
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
    .patch("/api/chats/:chatId/messages/:messageId", zValidator("json", schemas.editMessageSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.editMessage(c.req.param("chatId"), c.req.param("messageId"), body.content ?? ""));
    })
    .delete("/api/chats/:chatId/messages/:messageId", async (c) => {
      return c.json(await runtime.deleteMessage(c.req.param("chatId"), c.req.param("messageId")));
    })
    .post("/api/chats/:chatId/messages", zValidator("json", schemas.sendMessageSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.messages.post", { chatId, contentLength: body.content?.length ?? 0 });
      return c.json(await runtime.sendMessage(chatId, body, c.req.raw.signal));
    })
    .post("/api/chats/:chatId/messages/stream", zValidator("json", schemas.sendMessageSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.messages-stream.post", { chatId, contentLength: body.content?.length ?? 0 });
      const gen = runtime.sendMessageStream(chatId, body, c.req.raw.signal);
      return streamSSE(c, async (stream) => {
        for await (const event of gen) {
          await stream.writeSSE({ event: event.event, data: event.data });
        }
      });
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
      const gen = runtime.generateReplyStream(chatId, c.req.raw.signal);
      return streamSSE(c, async (stream) => {
        for await (const event of gen) {
          await stream.writeSSE({ event: event.event, data: event.data });
        }
      });
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
    .patch("/api/chats/:chatId/title", zValidator("json", schemas.renameChatSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.renameChat(c.req.param("chatId"), body.title));
    })
  ;
}
