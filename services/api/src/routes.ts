import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { logSendDebug } from "./send-debug-log.js";
import * as schemas from "@rp-platform/api-contracts";
import { isDomainError, providerError } from "./errors.js";

export interface RuntimeApi {
  bootstrap: () => Promise<unknown>;
  getChatSnapshot: (chatId: string) => Promise<unknown>;
  createChatForCharacter: (characterId: string) => Promise<unknown>;
  cloneChat: (chatId: string) => Promise<unknown>;
  exportCharacter: (characterId: string) => Promise<unknown>;
  exportChatJsonl: (chatId: string) => Promise<string>;
  exportPromptTrace: (traceId: string) => Promise<unknown>;
  updateChatSettings: (chatId: string, body: { title: string; subtitle: string; scenario: string; systemPrompt: string }) => unknown;
  branchChat: (chatId: string, messageId: string) => unknown;
  regenerateMessage: (chatId: string, messageId: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
  regenerateMessageStream: (chatId: string, messageId: string, body: unknown, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  selectVariant: (chatId: string, messageId: string, variantIndex: number) => unknown;
  editMessage: (chatId: string, messageId: string, content: string) => unknown;
  deleteMessage: (chatId: string, messageId: string) => unknown;
  sendMessage: (chatId: string, body: { content: string }, signal?: AbortSignal) => Promise<unknown>;
  sendMessageStream: (chatId: string, body: { content: string }, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  summarizeChat: (chatId: string, body: { providerProfileId: string; model?: string; maxMessages: number }, signal?: AbortSignal) => Promise<unknown>;
  saveChatSummary: (chatId: string, body: { summary: string }) => Promise<unknown>;
  generateReply: (chatId: string, signal?: AbortSignal) => Promise<unknown>;
  generateReplyStream: (chatId: string, signal?: AbortSignal) => AsyncIterable<{ event: string; data: string }>;
  updateCharacter: (characterId: string, body: Record<string, unknown>) => Promise<unknown>;
  updatePersona: (personaId: string, body: Record<string, unknown>) => unknown;
  listPersonas: () => Promise<unknown>;
  setChatPersona: (chatId: string, personaId: string) => Promise<unknown>;
  setChatPromptPreset: (chatId: string, promptPresetId: string) => Promise<unknown>;
  createPersona: (body: { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }) => Promise<unknown>;
  deletePersona: (personaId: string) => Promise<void>;
  getPersonalLorebookStatus: (personaId: string) => unknown;
  setPersonalLorebookEnabled: (personaId: string, enabled: boolean) => unknown;
  listLorebooks: (scopeType: string, ownerId?: string) => Promise<unknown>;
  createLorebook: (body: { name: string; description?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) => Promise<unknown>;
  updateLorebookMeta: (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; recursiveScanning?: boolean }) => Promise<unknown>;
  deleteLorebook: (lorebookId: string) => Promise<void>;
  createLoreEntry: (lorebookId: string, body: Record<string, unknown>) => Promise<unknown>;
  updateLoreEntry: (lorebookId: string, entryId: string, body: Record<string, unknown>) => Promise<unknown>;
  deleteLoreEntry: (lorebookId: string, entryId: string) => Promise<void>;
  listLoreEntries: (lorebookId: string) => Promise<unknown>;
  testLoreActivation: (lorebookId: string, body: { text: string }) => Promise<unknown>;
  // ── Scripts ──
  listScripts: (scopeType: string, ownerId?: string) => Promise<unknown>;
  getScript: (scriptId: string) => Promise<unknown>;
  createScript: (body: { name: string; description?: string; code?: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string; enabled?: boolean; sortOrder?: number }) => Promise<unknown>;
  updateScript: (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number }) => Promise<unknown>;
  deleteScript: (scriptId: string) => Promise<void>;
  testScript: (scriptId: string, body: { messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => Promise<unknown>;
  importScript: (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string }) => Promise<unknown>;
  streamScriptAiAssistant: (body: { prompt: string; existingCode?: string; providerProfileId: string; model?: string }) => AsyncIterable<{ type: "text" | "error" | "done"; text?: string; error?: string }>;
  listProviderProfiles: () => unknown;
  fetchProviderProfile: (providerProfileId: string) => unknown;
  activateProviderProfile: (providerProfileId: string) => unknown;
  updateProviderProfile: (providerProfileId: string, body: Record<string, unknown>) => unknown;
  saveProviderDraft: (body: Record<string, unknown>) => unknown;
  testProviderDraft: (body: { endpoint?: string; apiKey?: string; providerType?: string } | null) => Promise<unknown>;
  testProviderProfile: (providerProfileId: string) => Promise<unknown>;
  deleteProviderProfile: (providerProfileId: string) => void;
  fetchProviderModels: (providerProfileId: string) => Promise<{ models: unknown }>;
  listFavoriteProviderModels: (providerProfileId: string) => unknown;
  addFavoriteProviderModel: (providerProfileId: string, body: { modelId: string; label?: string | null; contextLength?: number | null }) => unknown;
  removeFavoriteProviderModel: (providerProfileId: string, modelId: string) => unknown;
  fetchModelsByEndpoint: (baseUrl: string, apiKey?: string, providerType?: string) => Promise<unknown>;
  importJson: (body: { fileName: string; jsonText: string; chatId?: string }) => unknown;
  forkBranch: (chatId: string) => unknown;
  activateBranch: (chatId: string, branchId: string) => unknown;
  deleteBranch: (chatId: string, branchId: string) => unknown;
  archiveCharacter: (characterId: string) => Promise<unknown>;
  unarchiveCharacter: (characterId: string) => Promise<unknown>;
  deleteCharacter: (characterId: string) => Promise<void>;
  deleteChat: (chatId: string) => void;
  renameChat: (chatId: string, title: string) => unknown;
  listPromptPresets: () => unknown;
  createPromptPreset: (body: unknown) => unknown;
  updatePromptPreset: (presetId: string, body: unknown) => unknown;
  deletePromptPreset: (presetId: string) => void;
  uploadAsset: (file: File) => Promise<{ assetId: string; url: string }>;
  serveAsset: (assetId: string) => Promise<{ body: Uint8Array; contentType: string } | null>;

  // ── Methods absorbed from former routerDeps ─────────────────────────

  createCharacterFromScratch: (body: {
    name: string;
    description?: string;
    firstMessage?: string;
    scenario?: string;
    personalitySummary?: string;
    mesExample?: string;
    mesExampleMode?: string;
    mesExampleDepth?: number;
    alternateGreetings?: string[];
    postHistoryInstructions?: string;
    creatorNotes?: string;
    systemPrompt?: string;
    depthPrompt?: string;
    depthPromptDepth?: number;
    depthPromptRole?: string;
    tags?: string[];
  }) => Promise<unknown>;

  createFreeChat: () => Promise<unknown>;

  testProviderChatByEndpoint: (opts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerType?: string;
  }) => Promise<unknown>;

  testProviderChatByProfile: (providerProfileId: string, model: string) => Promise<unknown>;

  scanSillyTavernDirectory: (dirPath: string) => Promise<unknown>;
  importSillyTavernDirectory: (dirPath: string) => Promise<unknown>;
}

export function createApiRouter(runtime: RuntimeApi) {
  return new Hono()
    .post("/api/debug/send-log", zValidator("json", schemas.debugSendLogSchema), async (c) => {
      const body = c.req.valid("json");
      logSendDebug("web.debug", typeof body === "object" && body ? body as Record<string, unknown> : { body });
      return c.json({ ok: true });
    })
    .get("/api/bootstrap", async (c) => {
      return c.json(await runtime.bootstrap());
    })
    .get("/api/personas", async (c) => {
      return c.json(await runtime.listPersonas());
    })
    .post("/api/personas", zValidator("json", schemas.createPersonaSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createPersona(body), 201);
    })
    .get("/api/chats/:chatId", async (c) => {
      return c.json(await runtime.getChatSnapshot(c.req.param("chatId")));
    })
    .post("/api/characters", zValidator("json", schemas.createCharacterSchema), async (c) => {
      const body = c.req.valid("json");
      const name = body.name;
      if (!name || !name.trim()) {
        return c.json({ error: "name is required" }, 400);
      }
      return c.json(await runtime.createCharacterFromScratch({
        name: name.trim(),
        description: body.description ?? undefined,
        firstMessage: body.firstMessage ?? undefined,
        scenario: body.scenario ?? undefined,
        personalitySummary: body.personalitySummary ?? undefined,
        mesExample: body.mesExample ?? undefined,
        mesExampleMode: body.mesExampleMode ?? undefined,
        mesExampleDepth: body.mesExampleDepth ?? undefined,
        alternateGreetings: body.alternateGreetings ?? undefined,
        postHistoryInstructions: body.postHistoryInstructions ?? undefined,
        creatorNotes: body.creatorNotes ?? undefined,
        systemPrompt: body.systemPrompt ?? undefined,
        depthPrompt: body.depthPrompt ?? undefined,
        depthPromptDepth: body.depthPromptDepth ?? undefined,
        depthPromptRole: body.depthPromptRole ?? undefined,
        tags: body.tags ?? undefined,
      }), 201);
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
    .get("/api/characters/:characterId/export", async (c) => {
      return c.json(await runtime.exportCharacter(c.req.param("characterId")));
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
    .post("/api/chats/:chatId/fork", async (c) => {
      return c.json(await runtime.forkBranch(c.req.param("chatId")));
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
    .patch("/api/characters/:characterId/archive", async (c) => {
      return c.json(await runtime.archiveCharacter(c.req.param("characterId")));
    })
    .patch("/api/characters/:characterId/unarchive", async (c) => {
      return c.json(await runtime.unarchiveCharacter(c.req.param("characterId")));
    })
    .patch("/api/characters/:characterId", zValidator("json", schemas.updateCharacterSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updateCharacter(c.req.param("characterId"), body),
      );
    })
    .delete("/api/characters/:characterId", async (c) => {
      runtime.deleteCharacter(c.req.param("characterId"));
      return c.body(null, 204);
    })
    .patch("/api/personas/:personaId", zValidator("json", schemas.updatePersonaSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updatePersona(c.req.param("personaId"), body),
      );
    })
    .delete("/api/personas/:personaId", async (c) => {
      runtime.deletePersona(c.req.param("personaId"));
      return c.body(null, 204);
    })
    .get("/api/personas/:personaId/personal-lorebook", async (c) => {
      return c.json(await runtime.getPersonalLorebookStatus(c.req.param("personaId")));
    })
    .put("/api/personas/:personaId/personal-lorebook", zValidator("json", schemas.setPersonalLorebookSchema), async (c) => {
      const body = c.req.valid("json");
      const enabled = body.enabled === true;
      return c.json(await runtime.setPersonalLorebookEnabled(c.req.param("personaId"), enabled));
    })
    .get("/api/lorebooks", async (c) => {
      const scopeType = c.req.query("scopeType") ?? "character";
      const ownerId = c.req.query("ownerId") ?? undefined;
      return c.json(await runtime.listLorebooks(scopeType, ownerId));
    })
    .post("/api/lorebooks", zValidator("json", schemas.createLorebookSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createLorebook(body), 201);
    })
    .patch("/api/lorebooks/:lorebookId", zValidator("json", schemas.updateLorebookMetaSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updateLorebookMeta(c.req.param("lorebookId"), body),
      );
    })
    .delete("/api/lorebooks/:lorebookId", async (c) => {
      await runtime.deleteLorebook(c.req.param("lorebookId"));
      return c.json({ ok: true });
    })
    .post("/api/lorebooks/:lorebookId/test-activation", zValidator("json", schemas.testActivationSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.testLoreActivation(c.req.param("lorebookId"), body),
      );
    })
    .get("/api/lorebooks/:lorebookId/entries", async (c) => {
      return c.json(await runtime.listLoreEntries(c.req.param("lorebookId")));
    })
    .post("/api/lorebooks/:lorebookId/entries", zValidator("json", schemas.createLoreEntrySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createLoreEntry(c.req.param("lorebookId"), body));
    })
    .patch("/api/lorebooks/:lorebookId/entries/:entryId", zValidator("json", schemas.updateLoreEntrySchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"), body));
    })
    .delete("/api/lorebooks/:lorebookId/entries/:entryId", async (c) => {
      await runtime.deleteLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"));
      return c.json({ ok: true });
    })
    // ── Scripts ──
    .get("/api/scripts", async (c) => {
      const scopeType = c.req.query("scopeType") ?? "character";
      const ownerId = c.req.query("ownerId") ?? undefined;
      return c.json(await runtime.listScripts(scopeType, ownerId));
    })
    .get("/api/scripts/:scriptId", async (c) => {
      const script = await runtime.getScript(c.req.param("scriptId"));
      if (!script) return c.json({ error: "Script not found" }, 404);
      return c.json(script);
    })
    .post("/api/scripts", zValidator("json", schemas.createScriptSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createScript(body), 201);
    })
    .patch("/api/scripts/:scriptId", zValidator("json", schemas.updateScriptSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateScript(c.req.param("scriptId"), body));
    })
    .delete("/api/scripts/:scriptId", async (c) => {
      await runtime.deleteScript(c.req.param("scriptId"));
      return c.json({ ok: true });
    })
    .post("/api/scripts/:scriptId/test", zValidator("json", schemas.testScriptSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.testScript(c.req.param("scriptId"), body));
    })
    .post("/api/scripts/import", zValidator("json", schemas.importScriptSchema), async (c) => {
      const body = c.req.valid("json");
      const format = body.format;
      const payload = format === "js"
        ? { format, code: body.code, name: body.name, scopeType: body.scopeType, characterId: body.characterId, personaId: body.personaId, chatId: body.chatId }
        : { format, jsonText: body.jsonText, scopeType: body.scopeType, characterId: body.characterId, personaId: body.personaId, chatId: body.chatId };
      return c.json(await runtime.importScript(payload), 201);
    })
    .post("/api/scripts/ai-assistant", async (c) => {
      const body = await c.req.json();
      const stream = runtime.streamScriptAiAssistant(body);

      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            for await (const chunk of stream) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      );
    })
    .get("/api/prompt-presets", async (c) => {
      return c.json(await runtime.listPromptPresets());
    })
    .post("/api/prompt-presets", zValidator("json", schemas.createPromptPresetSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.createPromptPreset(body), 201);
    })
    .patch("/api/prompt-presets/:presetId", zValidator("json", schemas.updatePromptPresetSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updatePromptPreset(c.req.param("presetId"), body));
    })
    .delete("/api/prompt-presets/:presetId", async (c) => {
      await runtime.deletePromptPreset(c.req.param("presetId"));
      return c.body(null, 204);
    })
    .get("/api/providers", async (c) => {
      return c.json(await runtime.listProviderProfiles());
    })
    .get("/api/providers/:providerId", async (c) => {
      return c.json(await runtime.fetchProviderProfile(c.req.param("providerId")));
    })
    .delete("/api/providers/:providerId", async (c) => {
      runtime.deleteProviderProfile(c.req.param("providerId"));
      return c.json({ ok: true });
    })
    .patch("/api/providers/:providerId", zValidator("json", schemas.updateProviderProfileSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateProviderProfile(c.req.param("providerId"), body));
    })
    .post("/api/assets/upload", async (c) => {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json({ error: "No file provided. Use 'file' field in multipart form." }, 400);
      }
      const result = await runtime.uploadAsset(file);
      return c.json(result, 201);
    })
    .get("/api/assets/:assetId", async (c) => {
      const assetId = c.req.param("assetId");
      const result = await runtime.serveAsset(assetId);
      if (!result) {
        return c.json({ error: "Asset not found" }, 404);
      }
      return c.body(new ReadableStream({ start(controller) { controller.enqueue(result.body); controller.close(); } }), 200, { "Content-Type": result.contentType, "Cache-Control": "public, max-age=31536000" });
    })
    .post("/api/providers/test", zValidator("json", schemas.testProviderDraftSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.testProviderDraft({ ...body, providerType: body.providerType }));
    })
    .post("/api/import/json", zValidator("json", schemas.importJsonSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.importJson(body));
    })
    .post("/api/import/st-scan", async (c) => {
      const body = await c.req.json<{ path?: string }>();
      if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
      try {
        const result = await runtime.scanSillyTavernDirectory(body.path);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/api/import/st-directory", async (c) => {
      const body = await c.req.json<{ path?: string }>();
      if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
      try {
        const result = await runtime.importSillyTavernDirectory(body.path);
        return c.json(result);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    })
    .post("/api/providers", zValidator("json", schemas.saveProviderDraftSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.saveProviderDraft(body));
    })
    .post("/api/providers/:providerId/activate", async (c) => {
      return c.json(await runtime.activateProviderProfile(c.req.param("providerId")));
    })
    .post("/api/providers/fetch-models", zValidator("json", schemas.fetchModelsSchema), async (c) => {
      const body = c.req.valid("json");
      const baseUrl = body?.baseUrl ?? "";
      const apiKey = body?.apiKey ?? "";
      if (!baseUrl.trim()) {
        return c.json({ error: "baseUrl is required." }, 400);
      }
      try {
        const models = await runtime.fetchModelsByEndpoint(baseUrl, apiKey, body?.providerType);
        return c.json({ models });
      } catch (err) {
        if (isDomainError(err)) throw err;
        throw providerError(err instanceof Error ? err.message : "Failed to fetch models.");
      }
    })
    .post("/api/providers/test-chat", zValidator("json", schemas.testChatSchema), async (c) => {
      const body = c.req.valid("json");
      const baseUrl = body?.baseUrl ?? "";
      const apiKey = body?.apiKey ?? "";
      const model = body?.model ?? "";
      if (!baseUrl || !model) {
        return c.json({ error: "baseUrl and model are required." }, 400);
      }
      return c.json(await runtime.testProviderChatByEndpoint({ baseUrl, apiKey, model, providerType: body?.providerType }));
    })
    .post("/api/providers/:providerId/models", async (c) => {
      return c.json(await runtime.fetchProviderModels(c.req.param("providerId")));
    })
    .get("/api/providers/:providerId/model-favorites", async (c) => {
      return c.json(await runtime.listFavoriteProviderModels(c.req.param("providerId")));
    })
    .post("/api/providers/:providerId/model-favorites", zValidator("json", schemas.favoriteProviderModelSchema), async (c) => {
      return c.json(await runtime.addFavoriteProviderModel(c.req.param("providerId"), c.req.valid("json")), 201);
    })
    .delete("/api/providers/:providerId/model-favorites", zValidator("json", schemas.favoriteProviderModelSchema.pick({ modelId: true })), async (c) => {
      await runtime.removeFavoriteProviderModel(c.req.param("providerId"), c.req.valid("json").modelId);
      return c.json({ ok: true });
    })
    .post("/api/providers/:providerId/test", async (c) => {
      return c.json(await runtime.testProviderProfile(c.req.param("providerId")));
    })
    .post("/api/providers/:providerId/test-chat", zValidator("json", schemas.testChatProfileSchema), async (c) => {
      const body = c.req.valid("json");
      const model = body.model;
      if (!model) {
        return c.json({ error: "model is required." }, 400);
      }
      return c.json(await runtime.testProviderChatByProfile(c.req.param("providerId"), model));
    });
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {};
  }

  const text = await request.text();
  return text.trim() ? JSON.parse(text) : {};
}

export type AppType = ReturnType<typeof createApiRouter>;
