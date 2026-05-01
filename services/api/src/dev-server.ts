import { Hono } from "hono";
import { cors } from "hono/cors";
import { brandId } from "@rp-platform/domain";
import type { ChatId, CharacterId, ChatBranchId, MessageId } from "@rp-platform/domain";
import { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import { SessionRuntime } from "./session-runtime.js";
import { ProviderOrchestrator } from "./provider-orchestrator.js";
import { listProviderModels, normalizeOpenAiCompatibleBaseUrl, probeProviderConnection, testProviderChat } from "./provider-gateway.js";
import { ProviderManager } from "./providers/manager.js";
import { logSendDebug } from "./send-debug-log.js";
import { createApiRouter } from "./routes.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson, notFound, validation, internal } from "./errors.js";

const host = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const port = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");
const sessionRuntime = new SessionRuntime();
const providerManager = new ProviderManager();
const providerOrchestrator = new ProviderOrchestrator(sessionRuntime, providerManager);
const chatRuntime = sessionRuntime.chatRuntime;
const liveChatOrchestrator = new LiveChatOrchestrator(chatRuntime, providerOrchestrator);

const runtime = {
  bootstrap: () => sessionRuntime.getBootstrapState(),
  getChatSnapshot: (chatId: string) => sessionRuntime.getSnapshot(brandId<ChatId>(chatId)),
  createChatForCharacter: (characterId: string) => sessionRuntime.createChatForCharacter(characterId),
  cloneChat: (chatId: string) => chatRuntime.cloneChat(chatId),
  exportCharacter: (characterId: string) => sessionRuntime.exportCharacter(characterId),
  exportChatJsonl: (chatId: string) => sessionRuntime.exportChatJsonl(chatId),
  exportPromptTrace: (traceId: string) => sessionRuntime.exportPromptTrace(traceId),
  updateChatSettings: (
    _chatId: string,
    _body: { title: string; subtitle: string; scenario: string; systemPrompt: string },
  ) => {
    throw internal("Chat settings route is not wired in this baseline.");
  },
  branchChat: (chatId: string, _messageId: string) => chatRuntime.forkBranch(brandId<ChatId>(chatId)),
  regenerateMessage: async (chatId: string, messageId: string, _body: unknown) => {
    const profile = sessionRuntime.resolveActiveProviderProfile();
    if (!profile) {
      throw validation("No active provider profile. Activate one in Provider settings.");
    }
    if (!profile.defaultModel) {
      throw validation("Active provider profile has no default model. Pick a model and save the profile.");
    }
    const result = await liveChatOrchestrator.regenerateMessage({
      chatId,
      messageId,
      profile,
      model: profile.defaultModel,
    });
    return result.snapshot;
  },
  selectVariant: (chatId: string, messageId: string, variantIndex: number) =>
    chatRuntime.selectMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex),
  editMessage: (chatId: string, messageId: string, content: string) =>
    chatRuntime.editMessage(brandId<ChatId>(chatId), messageId, content),
  deleteMessage: (chatId: string, messageId: string) => chatRuntime.deleteMessage(brandId<ChatId>(chatId), messageId),
  sendMessage: async (chatId: string, body: { content: string }) => {
    logSendDebug("api.runtime.send.start", { chatId, contentLength: body.content?.length ?? 0 });
    const profile = sessionRuntime.resolveActiveProviderProfile();
    if (!profile) {
      logSendDebug("api.runtime.send.no_active_profile", { chatId });
      throw validation("No active provider profile. Activate one in Provider settings.");
    }
    if (!profile.defaultModel) {
      logSendDebug("api.runtime.send.no_default_model", { chatId, profileId: profile.id });
      throw validation("Active provider profile has no default model. Pick a model and save the profile.");
    }
    logSendDebug("api.runtime.send.profile", {
      chatId,
      profileId: profile.id,
      providerType: profile.type,
      endpoint: profile.endpoint,
      model: profile.defaultModel,
      contextBudget: profile.contextBudget,
    });
    const result = await liveChatOrchestrator.sendMessage({
      chatId,
      content: body.content,
      profile,
      model: profile.defaultModel,
    });
    logSendDebug("api.runtime.send.success", {
      chatId,
      replyLength: result.reply.length,
      preparedMessageCount: result.preparedMessageCount,
      promptMessageCount: result.promptMessageCount,
    });
    return result.snapshot;
  },
  updateCharacter: (characterId: string, body: { chatId?: string; name?: string; description?: string; scenario?: string; systemPrompt?: string; mesExample?: string | null; alternateGreetings?: string[]; postHistoryInstructions?: string | null; creatorNotes?: string | null }) =>
    sessionRuntime.updateCharacter(brandId<CharacterId>(characterId), { ...body, chatId: body.chatId != null ? brandId<ChatId>(body.chatId) : undefined }),
  updatePersona: (personaId: string, body: { chatId?: string; name?: string; description?: string }) =>
    sessionRuntime.updatePersona(personaId, { ...body, chatId: body.chatId != null ? brandId<ChatId>(body.chatId) : undefined }),
  listPersonas: () => sessionRuntime.listPersonas(),
  setChatPersona: (chatId: string, personaId: string) => sessionRuntime.setChatPersona(brandId<ChatId>(chatId), personaId),
  setChatPromptPreset: (chatId: string, promptPresetId: string) => sessionRuntime.setChatPromptPreset(brandId<ChatId>(chatId), promptPresetId),
  createPersona: (body: { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }) =>
    sessionRuntime.createPersona(body),
  deletePersona: (personaId: string) => sessionRuntime.deletePersona(personaId),
  getPersonalLorebookStatus: (personaId: string) => sessionRuntime.getPersonalLorebookStatus(personaId),
  setPersonalLorebookEnabled: (personaId: string, enabled: boolean) => sessionRuntime.setPersonalLorebookEnabled(personaId, enabled),
  updateLorebook: (_lorebookId: string, _body: { chatId: string; lorebookRaw: string }) => {
    throw internal("Lorebook patch route is not wired in this baseline.");
  },
  createLoreEntry: (lorebookId: string, body: any) => sessionRuntime.createLoreEntry(lorebookId, body),
  updateLoreEntry: (lorebookId: string, entryId: string, body: any) => sessionRuntime.updateLoreEntry(lorebookId, entryId, body),
  deleteLoreEntry: (lorebookId: string, entryId: string) => sessionRuntime.deleteLoreEntry(lorebookId, entryId),
  listLoreEntries: (lorebookId: string) => sessionRuntime.listLoreEntries(lorebookId),
  testLoreActivation: (lorebookId: string, body: { text: string }) =>
    sessionRuntime.testLoreActivation(lorebookId, body.text),
  listProviderProfiles: () => sessionRuntime.listProviderProfiles(),
  fetchProviderProfile: (providerProfileId: string) => {
    const profile = sessionRuntime.getProviderProfileForClient(providerProfileId);
    if (!profile) {
      throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
    }
    return profile;
  },
  activateProviderProfile: (providerProfileId: string) => sessionRuntime.activateProviderProfile(providerProfileId),
  updateProviderProfile: (providerProfileId: string, body: unknown) =>
    sessionRuntime.updateProviderProfile(providerProfileId, body as any),
  saveProviderDraft: async (body: unknown) => sessionRuntime.saveProviderProfile(body),
  testProviderDraft: async (body: { endpoint?: string; apiKey?: string } | null) => {
    const endpoint = (body?.endpoint ?? "").trim();
    const apiKey = (body?.apiKey ?? "").trim();
    return probeProviderConnection({ baseUrl: endpoint, apiKey });
  },
  testProviderProfile: async (providerProfileId: string) => {
    const profile = getRequiredProviderProfile(providerProfileId);
    return probeProviderConnection({
      baseUrl: profile.endpoint,
      apiKey: profile.apiKey ?? "",
    });
  },
  deleteProviderProfile: (providerProfileId: string) => sessionRuntime.deleteProviderProfile(providerProfileId),
  fetchProviderModels: async (providerProfileId: string) => ({
    models: await providerOrchestrator.refreshProfileModels(getRequiredProviderProfile(providerProfileId)),
  }),
  fetchModelsByEndpoint: async (baseUrl: string, apiKey?: string) => {
    const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
    return listProviderModels({ baseUrl: normalized, apiKey: apiKey ?? "" });
  },
  importJson: (body: { fileName: string; jsonText: string; chatId?: string }) => sessionRuntime.importJson(body),
  forkBranch: (chatId: string) => chatRuntime.forkBranch(brandId<ChatId>(chatId)),
  activateBranch: (chatId: string, branchId: string) => chatRuntime.activateBranch(brandId<ChatId>(chatId), brandId<ChatBranchId>(branchId)),
  deleteBranch: (chatId: string, branchId: string) => chatRuntime.deleteBranch(chatId, branchId),
  archiveCharacter: (characterId: string) => sessionRuntime.archiveCharacter(characterId),
  unarchiveCharacter: (characterId: string) => sessionRuntime.unarchiveCharacter(characterId),
  deleteCharacter: (characterId: string) => sessionRuntime.deleteCharacter(characterId),
  deleteChat: (chatId: string) => chatRuntime.deleteChat(chatId),
  renameChat: (chatId: string, title: string) => chatRuntime.renameChat(chatId, title),
  listPromptPresets: () => sessionRuntime.listPromptPresets(),
  createPromptPreset: (body: any) => sessionRuntime.createPromptPreset(body),
  updatePromptPreset: (presetId: string, body: any) => sessionRuntime.updatePromptPreset(presetId, body),
  deletePromptPreset: (presetId: string) => sessionRuntime.deletePromptPreset(presetId),
};

function getRequiredProviderProfile(providerProfileId: string) {
  const profile = sessionRuntime.getProviderProfile(providerProfileId);
  if (!profile) {
    throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
  }
  return profile;
}

const apiRouter = createApiRouter(runtime, {
  getRequiredProviderProfile,
  sessionRuntime: {
    createCharacterFromScratch: (body) => sessionRuntime.createCharacterFromScratch(body),
    createFreeChat: () => sessionRuntime.createFreeChat(),
    getProviderProfile: (id) => sessionRuntime.getProviderProfile(id),
  },
  providerOrchestrator,
  listProviderModels,
  normalizeOpenAiCompatibleBaseUrl,
  probeProviderConnection,
  testProviderChat,
});

const app = new Hono();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type"],
}));

app.use("*", async (c, next) => {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength) > 1024 * 1024) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

app.onError((err, c) => {
  const url = c.req.url;
  const method = c.req.method;
  if (url.includes("/messages") || url.includes("/debug/send-log")) {
    logSendDebug("api.route.error", {
      method,
      url,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
    });
  }
  if (isDomainError(err)) {
    return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 401 | 404 | 409 | 499 | 500 | 502);
  }
  console.error("[unhandled]", err);
  return c.json(
    { error: { kind: "Internal" as const, message: err instanceof Error ? err.message : "Unknown server error" } },
    500,
  );
});

app.get("/health", (c) => {
  return c.json({
    ok: true,
    service: "rp-platform-api",
    time: new Date().toISOString(),
  });
});

app.route("/", apiRouter);

app.all("*", (c) => {
  const url = new URL(c.req.url);
  return c.json({ error: `Route not found: ${c.req.method} ${url.pathname}` }, 404);
});

Bun.serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

console.log(`RP Platform API listening on http://${host}:${port}`);
