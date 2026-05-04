import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { logSendDebug } from "./send-debug-log.js";
import * as schemas from "./api-schemas.js";
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
  selectVariant: (chatId: string, messageId: string, variantIndex: number) => unknown;
  editMessage: (chatId: string, messageId: string, content: string) => unknown;
  deleteMessage: (chatId: string, messageId: string) => unknown;
  sendMessage: (chatId: string, body: { content: string }, signal?: AbortSignal) => Promise<unknown>;
  updateCharacter: (characterId: string, body: Record<string, unknown>) => Promise<unknown>;
  updatePersona: (personaId: string, body: Record<string, unknown>) => unknown;
  listPersonas: () => Promise<unknown>;
  setChatPersona: (chatId: string, personaId: string) => Promise<unknown>;
  setChatPromptPreset: (chatId: string, promptPresetId: string) => Promise<unknown>;
  createPersona: (body: { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }) => Promise<unknown>;
  deletePersona: (personaId: string) => Promise<void>;
  getPersonalLorebookStatus: (personaId: string) => unknown;
  setPersonalLorebookEnabled: (personaId: string, enabled: boolean) => unknown;
  updateLorebook: (lorebookId: string, body: { chatId: string; lorebookRaw: string }) => unknown;
  createLoreEntry: (lorebookId: string, body: unknown) => unknown;
  updateLoreEntry: (lorebookId: string, entryId: string, body: unknown) => unknown;
  deleteLoreEntry: (lorebookId: string, entryId: string) => void;
  listLoreEntries: (lorebookId: string) => unknown;
  testLoreActivation: (lorebookId: string, body: { text: string }) => unknown;
  listProviderProfiles: () => unknown;
  fetchProviderProfile: (providerProfileId: string) => unknown;
  activateProviderProfile: (providerProfileId: string) => unknown;
  updateProviderProfile: (providerProfileId: string, body: unknown) => unknown;
  saveProviderDraft: (body: unknown) => unknown;
  testProviderDraft: (body: { endpoint?: string; apiKey?: string } | null) => Promise<unknown>;
  testProviderProfile: (providerProfileId: string) => Promise<unknown>;
  deleteProviderProfile: (providerProfileId: string) => void;
  fetchProviderModels: (providerProfileId: string) => Promise<{ models: unknown }>;
  fetchModelsByEndpoint: (baseUrl: string, apiKey?: string) => Promise<unknown>;
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
}

export function createApiRouter(
  runtime: RuntimeApi,
  deps: {
    getRequiredProviderProfile: (id: string) => Promise<{ endpoint: string; apiKey?: string | null }>;
    sessionRuntime: {
      createCharacterFromScratch: (body: { name: string; description?: string; firstMessage?: string; scenario?: string; personalitySummary?: string }) => Promise<unknown>;
      createFreeChat: () => Promise<unknown>;
      getProviderProfile: (id: string) => Promise<{ endpoint: string; apiKey?: string | null } | null>;
    };
    providerOrchestrator: { refreshProfileModels: (profile: any) => Promise<unknown> };
    listProviderModels: (opts: { baseUrl: string; apiKey: string }) => Promise<unknown>;
    normalizeOpenAiCompatibleBaseUrl: (url: string) => string;
    probeProviderConnection: (opts: { baseUrl: string; apiKey: string }) => Promise<unknown>;
    testProviderChat: (opts: { baseUrl: string; apiKey: string; model: string }) => Promise<unknown>;
  },
) {
  return new Hono()
    .post("/api/debug/send-log", zValidator("json", schemas.debugSendLogSchema), (c) => {
      const body = c.req.valid("json");
      logSendDebug("web.debug", typeof body === "object" && body ? body as Record<string, unknown> : { body });
      return c.json({ ok: true });
    })
    .get("/api/bootstrap", async (c) => {
      return c.json(await runtime.bootstrap());
    })
    .get("/api/personas", (c) => {
      return c.json(runtime.listPersonas());
    })
    .post("/api/personas", zValidator("json", schemas.createPersonaSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.createPersona(body), 201);
    })
    .get("/api/chats/:chatId", (c) => {
      return c.json(runtime.getChatSnapshot(c.req.param("chatId")));
    })
    .post("/api/characters", zValidator("json", schemas.createCharacterSchema), async (c) => {
      const body = c.req.valid("json");
      const name = body.name;
      if (!name || !name.trim()) {
        return c.json({ error: "name is required" }, 400);
      }
      return c.json(await deps.sessionRuntime.createCharacterFromScratch({
        name: name.trim(),
        description: body.description ?? undefined,
        firstMessage: body.firstMessage ?? undefined,
        scenario: body.scenario ?? undefined,
        personalitySummary: body.personalitySummary ?? undefined,
      }), 201);
    })
    .post("/api/chats", zValidator("json", schemas.createChatSchema), async (c) => {
      const body = c.req.valid("json");
      const characterId = body.characterId;
      if (!characterId) {
        return c.json(await deps.sessionRuntime.createFreeChat());
      }
      return c.json(runtime.createChatForCharacter(characterId));
    })
    .post("/api/chats/:chatId/clone", (c) => {
      return c.json(runtime.cloneChat(c.req.param("chatId")));
    })
    .get("/api/characters/:characterId/export", (c) => {
      return c.json(runtime.exportCharacter(c.req.param("characterId")));
    })
    .get("/api/chats/:chatId/export.jsonl", async (c) => {
      return c.text(
        await runtime.exportChatJsonl(c.req.param("chatId")),
        200,
        { "Content-Type": "application/x-ndjson; charset=utf-8" },
      );
    })
    .get("/api/prompt-traces/:traceId/export", (c) => {
      return c.json(runtime.exportPromptTrace(c.req.param("traceId")));
    })
    .patch("/api/chats/:chatId/settings", zValidator("json", schemas.updateChatSettingsSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(
        runtime.updateChatSettings(c.req.param("chatId"), body),
      );
    })
    .post("/api/chats/:chatId/messages/:messageId/branch", (c) => {
      return c.json(runtime.branchChat(c.req.param("chatId"), c.req.param("messageId")));
    })
    .post("/api/chats/:chatId/messages/:messageId/regenerate", async (c) => {
      const chatId = c.req.param("chatId");
      const messageId = c.req.param("messageId");
      const body = await c.req.json();
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
    .post("/api/chats/:chatId/messages/:messageId/variants/:variantIndex/select", (c) => {
      return c.json(
        runtime.selectVariant(
          c.req.param("chatId"),
          c.req.param("messageId"),
          Number(c.req.param("variantIndex")),
        ),
      );
    })
    .patch("/api/chats/:chatId/messages/:messageId", zValidator("json", schemas.editMessageSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.editMessage(c.req.param("chatId"), c.req.param("messageId"), body.content ?? ""));
    })
    .delete("/api/chats/:chatId/messages/:messageId", (c) => {
      return c.json(runtime.deleteMessage(c.req.param("chatId"), c.req.param("messageId")));
    })
    .post("/api/chats/:chatId/messages", zValidator("json", schemas.sendMessageSchema), async (c) => {
      const chatId = c.req.param("chatId");
      const body = c.req.valid("json");
      logSendDebug("api.route.messages.post", { chatId, contentLength: body.content?.length ?? 0 });
      return c.json(await runtime.sendMessage(chatId, body, c.req.raw.signal));
    })
    .post("/api/chats/:chatId/set-persona", zValidator("json", schemas.setPersonaSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.setChatPersona(c.req.param("chatId"), body.personaId));
    })
    .post("/api/chats/:chatId/set-prompt-preset", zValidator("json", schemas.setPromptPresetSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.setChatPromptPreset(c.req.param("chatId"), body.promptPresetId));
    })
    .post("/api/chats/:chatId/fork", (c) => {
      return c.json(runtime.forkBranch(c.req.param("chatId")));
    })
    .post("/api/chats/:chatId/branches/:branchId/activate", (c) => {
      return c.json(runtime.activateBranch(c.req.param("chatId"), c.req.param("branchId")));
    })
    .delete("/api/chats/:chatId/branches/:branchId", (c) => {
      return c.json(runtime.deleteBranch(c.req.param("chatId"), c.req.param("branchId")));
    })
    .delete("/api/chats/:chatId", (c) => {
      runtime.deleteChat(c.req.param("chatId"));
      return c.body(null, 204);
    })
    .patch("/api/chats/:chatId/title", zValidator("json", schemas.renameChatSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.renameChat(c.req.param("chatId"), body.title));
    })
    .patch("/api/characters/:characterId/archive", (c) => {
      return c.json(runtime.archiveCharacter(c.req.param("characterId")));
    })
    .patch("/api/characters/:characterId/unarchive", (c) => {
      return c.json(runtime.unarchiveCharacter(c.req.param("characterId")));
    })
    .patch("/api/characters/:characterId", zValidator("json", schemas.updateCharacterSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await runtime.updateCharacter(c.req.param("characterId"), body),
      );
    })
    .delete("/api/characters/:characterId", (c) => {
      runtime.deleteCharacter(c.req.param("characterId"));
      return c.body(null, 204);
    })
    .patch("/api/personas/:personaId", zValidator("json", schemas.updatePersonaSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(
        runtime.updatePersona(c.req.param("personaId"), body),
      );
    })
    .delete("/api/personas/:personaId", (c) => {
      runtime.deletePersona(c.req.param("personaId"));
      return c.body(null, 204);
    })
    .get("/api/personas/:personaId/personal-lorebook", (c) => {
      return c.json(runtime.getPersonalLorebookStatus(c.req.param("personaId")));
    })
    .put("/api/personas/:personaId/personal-lorebook", zValidator("json", schemas.setPersonalLorebookSchema), (c) => {
      const body = c.req.valid("json");
      const enabled = body.enabled === true;
      return c.json(runtime.setPersonalLorebookEnabled(c.req.param("personaId"), enabled));
    })
    .patch("/api/lorebooks/:lorebookId", zValidator("json", schemas.updateLorebookSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(
        runtime.updateLorebook(c.req.param("lorebookId"), body),
      );
    })
    .post("/api/lorebooks/:lorebookId/test-activation", zValidator("json", schemas.testActivationSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(
        runtime.testLoreActivation(c.req.param("lorebookId"), body),
      );
    })
    .get("/api/lorebooks/:lorebookId/entries", (c) => {
      return c.json(runtime.listLoreEntries(c.req.param("lorebookId")));
    })
    .post("/api/lorebooks/:lorebookId/entries", zValidator("json", schemas.createLoreEntrySchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.createLoreEntry(c.req.param("lorebookId"), body));
    })
    .patch("/api/lorebooks/:lorebookId/entries/:entryId", zValidator("json", schemas.updateLoreEntrySchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.updateLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"), body));
    })
    .delete("/api/lorebooks/:lorebookId/entries/:entryId", (c) => {
      runtime.deleteLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"));
      return c.json({ ok: true });
    })
    .get("/api/prompt-presets", (c) => {
      return c.json(runtime.listPromptPresets());
    })
    .post("/api/prompt-presets", zValidator("json", schemas.createPromptPresetSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.createPromptPreset(body), 201);
    })
    .patch("/api/prompt-presets/:presetId", zValidator("json", schemas.updatePromptPresetSchema), (c) => {
      const body = c.req.valid("json");
      return c.json(runtime.updatePromptPreset(c.req.param("presetId"), body));
    })
    .delete("/api/prompt-presets/:presetId", (c) => {
      runtime.deletePromptPreset(c.req.param("presetId"));
      return c.body(null, 204);
    })
    .get("/api/providers", (c) => {
      return c.json(runtime.listProviderProfiles());
    })
    .get("/api/providers/:providerId", (c) => {
      return c.json(runtime.fetchProviderProfile(c.req.param("providerId")));
    })
    .delete("/api/providers/:providerId", (c) => {
      runtime.deleteProviderProfile(c.req.param("providerId"));
      return c.json({ ok: true });
    })
    .patch("/api/providers/:providerId", zValidator("json", schemas.updateProviderProfileSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.updateProviderProfile(c.req.param("providerId"), body));
    })
    .post("/api/providers/test", zValidator("json", schemas.testProviderDraftSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.testProviderDraft(body as any));
    })
    .post("/api/import/json", zValidator("json", schemas.importJsonSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.importJson(body));
    })
    .post("/api/providers", zValidator("json", schemas.saveProviderDraftSchema), async (c) => {
      const body = c.req.valid("json");
      return c.json(await runtime.saveProviderDraft(body));
    })
    .post("/api/providers/:providerId/activate", (c) => {
      return c.json(runtime.activateProviderProfile(c.req.param("providerId")));
    })
    .post("/api/providers/fetch-models", zValidator("json", schemas.fetchModelsSchema), async (c) => {
      const body = c.req.valid("json");
      const baseUrl = body?.baseUrl ?? "";
      const apiKey = body?.apiKey ?? "";
      if (!baseUrl.trim()) {
        return c.json({ error: "baseUrl is required." }, 400);
      }
      try {
        const normalized = deps.normalizeOpenAiCompatibleBaseUrl(baseUrl);
        const models = await deps.listProviderModels({ baseUrl: normalized, apiKey: apiKey ?? "" });
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
      return c.json(await deps.testProviderChat({ baseUrl, apiKey, model }));
    })
    .post("/api/providers/:providerId/models", (c) => {
      return c.json(runtime.fetchProviderModels(c.req.param("providerId")));
    })
    .post("/api/providers/:providerId/test", (c) => {
      return c.json(runtime.testProviderProfile(c.req.param("providerId")));
    })
    .post("/api/providers/:providerId/test-chat", zValidator("json", schemas.testChatProfileSchema), async (c) => {
      const body = c.req.valid("json");
      const model = body.model;
      if (!model) {
        return c.json({ error: "model is required." }, 400);
      }
      const profile = await deps.getRequiredProviderProfile(c.req.param("providerId"));
      return c.json(await deps.testProviderChat({
        baseUrl: profile.endpoint,
        apiKey: profile.apiKey ?? "",
        model,
      }));
    });
}

export type AppType = ReturnType<typeof createApiRouter>;
