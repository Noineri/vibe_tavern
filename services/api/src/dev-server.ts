import { Hono } from "hono";
import { cors } from "hono/cors";
import { brandId } from "@rp-platform/domain";
import type { ChatId, CharacterId, ChatBranchId, MessageId } from "@rp-platform/domain";
import { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import { SessionRuntime } from "./session-runtime.js";
import { ProviderProfileService } from "./provider-profile-service.js";
import { PromptPresetService } from "./prompt-preset-service.js";
import { ProviderOrchestrator } from "./provider-orchestrator.js";
import { listProviderModels, normalizeOpenAiCompatibleBaseUrl, probeProviderConnection, testProviderChat } from "./provider-gateway.js";
import { logSendDebug } from "./send-debug-log.js";
import { createApiRouter } from "./routes.js";
import { isDomainError, httpStatusForDomainError, domainErrorToJson, notFound, validation, internal } from "./errors.js";

import { createRuntimeStore } from "./session-runtime-store.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = process.env.RP_PLATFORM_ROOT_DIR ?? resolve(import.meta.dir, '..', '..', '..');

const host = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const port = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");

// ─── Bootstrap sequence ─────────────────────────────────────────────────────

console.log("[bootstrap] Starting RP Platform API...");

// 1. Ensure data/ directory exists
mkdirSync(resolve(rootDir, "data"), { recursive: true });

// 2. Run DB schema push (creates/updates all tables)
console.log("[bootstrap] Running DB schema push...");
try {
  const pushProc = Bun.spawn(["bunx", "drizzle-kit", "push"], {
    cwd: resolve(rootDir, "packages/db"),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await pushProc.exited;
  if (exitCode === 0) {
    console.log("[bootstrap] DB schema push complete.");
  } else {
    console.warn(`[bootstrap] DB schema push exited with code ${exitCode} (tables may already exist).`);
  }
} catch (err) {
  console.warn("[bootstrap] DB schema push failed (tables may already exist):", err instanceof Error ? err.message : err);
}

// 3. Create StoreContainer
const stores = createRuntimeStore();

// 4–7. Ensure seed data (runs async, awaited below)
async function ensureSeedData() {
  await stores.characters.getSystemCharacter();
  await stores.personas.ensureDefault();
  await stores.presets.ensureDefault();
  await stores.uiSettings.ensureDefaults();
}

// We need to run async bootstrap before starting the server.
// Use an IIFE to await the async parts.
(async () => {
  await ensureSeedData();
  console.log("[bootstrap] Seed data ensured.");

  // 8. Wire stores into services
  const providerProfileService = new ProviderProfileService(stores.providers);
  const promptPresetService = new PromptPresetService(stores.presets);

  // 9. Wire services into SessionRuntime
  const sessionRuntime = new SessionRuntime(stores, {
    getActiveProviderProfile: () => providerProfileService.resolveActiveProviderProfile(),
  });

  const providerOrchestrator = new ProviderOrchestrator(providerProfileService);
  const chatRuntime = sessionRuntime.chatRuntime;
  const liveChatOrchestrator = new LiveChatOrchestrator(chatRuntime, providerOrchestrator);

  // 10. Wire routes and start server
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
    regenerateMessage: async (chatId: string, messageId: string, _body: unknown, signal?: AbortSignal) => {
      const profile = await providerProfileService.resolveActiveProviderProfile();
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
        signal,
      });
      return result.snapshot;
    },
    regenerateMessageStream: async function*(chatId: string, messageId: string, _body: unknown, signal?: AbortSignal) {
      const profile = await providerProfileService.resolveActiveProviderProfile();
      if (!profile) {
        throw validation("No active provider profile. Activate one in Provider settings.");
      }
      if (!profile.defaultModel) {
        throw validation("Active provider profile has no default model. Pick a model and save the profile.");
      }
      yield* liveChatOrchestrator.regenerateMessageStream({
        chatId,
        messageId,
        profile,
        model: profile.defaultModel,
        signal,
      });
    },
    selectVariant: (chatId: string, messageId: string, variantIndex: number) =>
      chatRuntime.selectMessageVariant(brandId<ChatId>(chatId), brandId<MessageId>(messageId), variantIndex),
    editMessage: (chatId: string, messageId: string, content: string) =>
      chatRuntime.editMessage(brandId<ChatId>(chatId), messageId, content),
    deleteMessage: (chatId: string, messageId: string) => chatRuntime.deleteMessage(brandId<ChatId>(chatId), messageId),
    sendMessage: async (chatId: string, body: { content: string }, signal?: AbortSignal) => {
      logSendDebug("api.runtime.send.start", { chatId, contentLength: body.content?.length ?? 0 });
      const profile = await providerProfileService.resolveActiveProviderProfile();
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
        signal,
      });
      logSendDebug("api.runtime.send.success", {
        chatId,
        replyLength: result.reply.length,
        preparedMessageCount: result.preparedMessageCount,
        promptMessageCount: result.promptMessageCount,
      });
      return result.snapshot;
    },
    sendMessageStream: async function*(chatId: string, body: { content: string }, signal?: AbortSignal) {
      const profile = await providerProfileService.resolveActiveProviderProfile();
      if (!profile) {
        throw validation("No active provider profile. Activate one in Provider settings.");
      }
      if (!profile.defaultModel) {
        throw validation("Active provider profile has no default model. Pick a model and save the profile.");
      }
      yield* liveChatOrchestrator.sendMessageStream({
        chatId,
        content: body.content,
        profile,
        model: profile.defaultModel,
        signal,
      });
    },
    generateReply: async (chatId: string, signal?: AbortSignal) => {
      const profile = await providerProfileService.resolveActiveProviderProfile();
      if (!profile) {
        throw validation("No active provider profile. Activate one in Provider settings.");
      }
      if (!profile.defaultModel) {
        throw validation("Active provider profile has no default model. Pick a model and save the profile.");
      }
      const result = await liveChatOrchestrator.generateReply({
        chatId,
        profile,
        model: profile.defaultModel,
        signal,
      });
      return result.snapshot;
    },
    generateReplyStream: async function*(chatId: string, signal?: AbortSignal) {
      const profile = await providerProfileService.resolveActiveProviderProfile();
      if (!profile) {
        throw validation("No active provider profile. Activate one in Provider settings.");
      }
      if (!profile.defaultModel) {
        throw validation("Active provider profile has no default model. Pick a model and save the profile.");
      }
      yield* liveChatOrchestrator.generateReplyStream({
        chatId,
        profile,
        model: profile.defaultModel,
        signal,
      });
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
    listProviderProfiles: () => providerProfileService.listProviderProfiles(),
    fetchProviderProfile: (providerProfileId: string) => {
      const profile = providerProfileService.getProviderProfileForClient(providerProfileId);
      if (!profile) {
        throw notFound("ProviderProfile", `Provider profile '${providerProfileId}' was not found.`);
      }
      return profile;
    },
    activateProviderProfile: (providerProfileId: string) => providerProfileService.activateProviderProfile(providerProfileId),
    updateProviderProfile: (providerProfileId: string, body: unknown) =>
      providerProfileService.updateProviderProfile(providerProfileId, body as any),
    saveProviderDraft: async (body: unknown) => providerProfileService.saveProviderProfile(body as any),
    testProviderDraft: async (body: { endpoint?: string; apiKey?: string } | null) => {
      const endpoint = (body?.endpoint ?? "").trim();
      const apiKey = (body?.apiKey ?? "").trim();
      return probeProviderConnection({ baseUrl: endpoint, apiKey });
    },
    testProviderProfile: async (providerProfileId: string) => {
      const profile = await getRequiredProviderProfile(providerProfileId);
      return probeProviderConnection({
        baseUrl: profile.endpoint,
        apiKey: profile.apiKey ?? "",
      });
    },
    deleteProviderProfile: (providerProfileId: string) => providerProfileService.deleteProviderProfile(providerProfileId),
    fetchProviderModels: async (providerProfileId: string) => ({
      models: await providerOrchestrator.refreshProfileModels(await getRequiredProviderProfile(providerProfileId)),
    }),
    fetchModelsByEndpoint: async (baseUrl: string, apiKey?: string, providerType?: string) => {
      const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
      return listProviderModels({ baseUrl: normalized, apiKey: apiKey ?? "", providerType });
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
    listPromptPresets: () => promptPresetService.listPromptPresets(),
    createPromptPreset: (body: any) => promptPresetService.createPromptPreset(body),
    updatePromptPreset: (presetId: string, body: any) => promptPresetService.updatePromptPreset(presetId, body),
    deletePromptPreset: (presetId: string) => promptPresetService.deletePromptPreset(presetId),
  };

  async function getRequiredProviderProfile(providerProfileId: string) {
    const profile = await providerProfileService.getProviderProfile(providerProfileId);
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
      getProviderProfile: async (id) => {
        const p = await providerProfileService.getProviderProfile(id);
        return p ? { endpoint: p.endpoint, apiKey: p.apiKey } : null;
      },
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
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 401 | 404 | 409 | 500 | 502);
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
    idleTimeout: 255, // seconds — allows long-running non-streaming provider requests
  });

  console.log(`RP Platform API listening on http://${host}:${port}`);
})();
