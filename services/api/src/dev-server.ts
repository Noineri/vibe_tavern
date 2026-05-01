import { Hono } from "hono";
import { cors } from "hono/cors";
import { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import { SessionRuntime } from "./session-runtime.js";
import { ProviderOrchestrator } from "./provider-orchestrator.js";
import { listProviderModels, normalizeOpenAiCompatibleBaseUrl, probeProviderConnection, testProviderChat } from "./provider-gateway.js";
import { ProviderManager } from "./providers/manager.js";
import { logSendDebug } from "./send-debug-log.js";

const host = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const port = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");
const sessionRuntime = new SessionRuntime();
const providerManager = new ProviderManager();
const providerOrchestrator = new ProviderOrchestrator(sessionRuntime, providerManager);
const liveChatOrchestrator = new LiveChatOrchestrator(sessionRuntime, providerOrchestrator);

const runtime = {
  bootstrap: () => sessionRuntime.getBootstrapState(),
  getChatSnapshot: (chatId: string) => sessionRuntime.getSnapshot(chatId),
  createChatForCharacter: (characterId: string) => sessionRuntime.createChatForCharacter(characterId),
  cloneChat: (chatId: string) => sessionRuntime.cloneChat(chatId),
  exportCharacter: (characterId: string) => sessionRuntime.exportCharacter(characterId),
  exportChatJsonl: (chatId: string) => sessionRuntime.exportChatJsonl(chatId),
  exportPromptTrace: (traceId: string) => sessionRuntime.exportPromptTrace(traceId),
  updateChatSettings: (
    _chatId: string,
    _body: { title: string; subtitle: string; scenario: string; systemPrompt: string },
  ) => {
    throw new Error("Chat settings route is not wired in this baseline.");
  },
  branchChat: (chatId: string, _messageId: string) => sessionRuntime.forkBranch(chatId),
  regenerateMessage: async (chatId: string, messageId: string, _body: unknown) => {
    const profile = sessionRuntime.resolveActiveProviderProfile();
    if (!profile) {
      throw new Error("No active provider profile. Activate one in Provider settings.");
    }
    if (!profile.defaultModel) {
      throw new Error("Active provider profile has no default model. Pick a model and save the profile.");
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
    sessionRuntime.selectMessageVariant(chatId, messageId, variantIndex),
  editMessage: (chatId: string, messageId: string, content: string) =>
    sessionRuntime.editMessage(chatId, messageId, content),
  deleteMessage: (chatId: string, messageId: string) => sessionRuntime.deleteMessage(chatId, messageId),
  sendMessage: async (chatId: string, body: { content: string }) => {
    logSendDebug("api.runtime.send.start", { chatId, contentLength: body.content?.length ?? 0 });
    const profile = sessionRuntime.resolveActiveProviderProfile();
    if (!profile) {
      logSendDebug("api.runtime.send.no_active_profile", { chatId });
      throw new Error("No active provider profile. Activate one in Provider settings.");
    }
    if (!profile.defaultModel) {
      logSendDebug("api.runtime.send.no_default_model", { chatId, profileId: profile.id });
      throw new Error("Active provider profile has no default model. Pick a model and save the profile.");
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
    sessionRuntime.updateCharacter(characterId, body),
  updatePersona: (personaId: string, body: { chatId?: string; name?: string; description?: string }) =>
    sessionRuntime.updatePersona(personaId, body),
  listPersonas: () => sessionRuntime.listPersonas(),
  setChatPersona: (chatId: string, personaId: string) => sessionRuntime.setChatPersona(chatId, personaId),
  setChatPromptPreset: (chatId: string, promptPresetId: string) => sessionRuntime.setChatPromptPreset(chatId, promptPresetId),
  createPersona: (body: { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }) =>
    sessionRuntime.createPersona(body),
  deletePersona: (personaId: string) => sessionRuntime.deletePersona(personaId),
  getPersonalLorebookStatus: (personaId: string) => sessionRuntime.getPersonalLorebookStatus(personaId),
  setPersonalLorebookEnabled: (personaId: string, enabled: boolean) => sessionRuntime.setPersonalLorebookEnabled(personaId, enabled),
  updateLorebook: (_lorebookId: string, _body: { chatId: string; lorebookRaw: string }) => {
    throw new Error("Lorebook patch route is not wired in this baseline.");
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
      throw new Error(`Provider profile '${providerProfileId}' was not found.`);
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
  forkBranch: (chatId: string) => sessionRuntime.forkBranch(chatId),
  activateBranch: (chatId: string, branchId: string) => sessionRuntime.activateBranch(chatId, branchId),
  deleteBranch: (chatId: string, branchId: string) => sessionRuntime.deleteBranch(chatId, branchId),
  archiveCharacter: (characterId: string) => sessionRuntime.archiveCharacter(characterId),
  unarchiveCharacter: (characterId: string) => sessionRuntime.unarchiveCharacter(characterId),
  deleteCharacter: (characterId: string) => sessionRuntime.deleteCharacter(characterId),
  deleteChat: (chatId: string) => sessionRuntime.deleteChat(chatId),
  renameChat: (chatId: string, title: string) => sessionRuntime.renameChat(chatId, title),
  listPromptPresets: () => sessionRuntime.listPromptPresets(),
  createPromptPreset: (body: any) => sessionRuntime.createPromptPreset(body),
  updatePromptPreset: (presetId: string, body: any) => sessionRuntime.updatePromptPreset(presetId, body),
  deletePromptPreset: (presetId: string) => sessionRuntime.deletePromptPreset(presetId),
};

function getRequiredProviderProfile(providerProfileId: string) {
  const profile = sessionRuntime.getProviderProfile(providerProfileId);
  if (!profile) {
    throw new Error(`Provider profile '${providerProfileId}' was not found.`);
  }
  return profile;
}

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
  return c.json(
    { error: err instanceof Error ? err.message : "Unknown server error" },
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

app.post("/api/debug/send-log", async (c) => {
  const body = await c.req.json();
  logSendDebug("web.debug", typeof body === "object" && body ? body as Record<string, unknown> : { body });
  return c.json({ ok: true });
});

app.get("/api/bootstrap", (c) => {
  return c.json(runtime.bootstrap());
});

app.get("/api/personas", (c) => {
  return c.json(runtime.listPersonas());
});

app.post("/api/personas", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.createPersona(body as { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }), 201);
});

app.get("/api/chats/:chatId", (c) => {
  return c.json(runtime.getChatSnapshot(c.req.param("chatId")));
});

app.post("/api/characters", async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const name = body.name;
  if (!name || typeof name !== "string" || !name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  return c.json(sessionRuntime.createCharacterFromScratch({
    name: name.trim(),
    description: (body as any).description ?? undefined,
    firstMessage: (body as any).firstMessage ?? undefined,
    scenario: (body as any).scenario ?? undefined,
    personalitySummary: (body as any).personalitySummary ?? undefined,
  }), 201);
});

app.post("/api/chats", async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const characterId = body.characterId;
  if (!characterId) {
    return c.json(sessionRuntime.createFreeChat());
  }
  return c.json(runtime.createChatForCharacter(characterId as string));
});

app.post("/api/chats/:chatId/clone", (c) => {
  return c.json(runtime.cloneChat(c.req.param("chatId")));
});

app.get("/api/characters/:characterId/export", (c) => {
  return c.json(runtime.exportCharacter(c.req.param("characterId")));
});

app.get("/api/chats/:chatId/export.jsonl", (c) => {
  return c.text(
    runtime.exportChatJsonl(c.req.param("chatId")),
    200,
    { "Content-Type": "application/x-ndjson; charset=utf-8" },
  );
});

app.get("/api/prompt-traces/:traceId/export", (c) => {
  return c.json(runtime.exportPromptTrace(c.req.param("traceId")));
});

app.patch("/api/chats/:chatId/settings", async (c) => {
  const body = await c.req.json();
  return c.json(
    runtime.updateChatSettings(c.req.param("chatId"), body as {
      title: string;
      subtitle: string;
      scenario: string;
      systemPrompt: string;
    }),
  );
});

app.post("/api/chats/:chatId/messages/:messageId/branch", (c) => {
  return c.json(runtime.branchChat(c.req.param("chatId"), c.req.param("messageId")));
});

app.post("/api/chats/:chatId/messages/:messageId/regenerate", async (c) => {
  const chatId = c.req.param("chatId");
  const messageId = c.req.param("messageId");
  const body = await c.req.json();
  const regenStartMs = Date.now();
  logSendDebug("api.route.regenerate.start", { chatId, messageId });
  try {
    const result = await runtime.regenerateMessage(chatId, messageId, body);
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
});

app.post("/api/chats/:chatId/messages/:messageId/variants/:variantIndex/select", (c) => {
  return c.json(
    runtime.selectVariant(
      c.req.param("chatId"),
      c.req.param("messageId"),
      Number(c.req.param("variantIndex")),
    ),
  );
});

app.patch("/api/chats/:chatId/messages/:messageId", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.editMessage(c.req.param("chatId"), c.req.param("messageId"), body.content ?? ""));
});

app.delete("/api/chats/:chatId/messages/:messageId", (c) => {
  return c.json(runtime.deleteMessage(c.req.param("chatId"), c.req.param("messageId")));
});

app.post("/api/chats/:chatId/messages", async (c) => {
  const chatId = c.req.param("chatId");
  const body = await c.req.json();
  logSendDebug("api.route.messages.post", { chatId, contentLength: body.content?.length ?? 0 });
  return c.json(await runtime.sendMessage(chatId, body as { content: string }));
});

app.post("/api/chats/:chatId/set-persona", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.setChatPersona(c.req.param("chatId"), body.personaId));
});

app.post("/api/chats/:chatId/set-prompt-preset", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.setChatPromptPreset(c.req.param("chatId"), body.promptPresetId));
});

app.post("/api/chats/:chatId/fork", (c) => {
  return c.json(runtime.forkBranch(c.req.param("chatId")));
});

app.post("/api/chats/:chatId/branches/:branchId/activate", (c) => {
  return c.json(runtime.activateBranch(c.req.param("chatId"), c.req.param("branchId")));
});

app.delete("/api/chats/:chatId/branches/:branchId", (c) => {
  return c.json(runtime.deleteBranch(c.req.param("chatId"), c.req.param("branchId")));
});

app.delete("/api/chats/:chatId", (c) => {
  runtime.deleteChat(c.req.param("chatId"));
  return c.body(null, 204);
});

app.patch("/api/chats/:chatId/title", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.renameChat(c.req.param("chatId"), body.title as string));
});

app.patch("/api/characters/:characterId/archive", (c) => {
  return c.json(runtime.archiveCharacter(c.req.param("characterId")));
});

app.patch("/api/characters/:characterId/unarchive", (c) => {
  return c.json(runtime.unarchiveCharacter(c.req.param("characterId")));
});

app.patch("/api/characters/:characterId", async (c) => {
  const body = await c.req.json();
  return c.json(
    runtime.updateCharacter(c.req.param("characterId"), body as {
      chatId: string;
      name: string;
      description: string;
      scenario: string;
      systemPrompt: string;
      mesExample?: string | null;
      alternateGreetings?: string[];
      postHistoryInstructions?: string | null;
      creatorNotes?: string | null;
    }),
  );
});

app.delete("/api/characters/:characterId", (c) => {
  runtime.deleteCharacter(c.req.param("characterId"));
  return c.body(null, 204);
});

app.patch("/api/personas/:personaId", async (c) => {
  const body = await c.req.json();
  return c.json(
    runtime.updatePersona(c.req.param("personaId"), body as {
      chatId: string;
      name: string;
      description: string;
      systemPrompt: string;
    }),
  );
});

app.delete("/api/personas/:personaId", (c) => {
  try {
    runtime.deletePersona(c.req.param("personaId"));
    return c.body(null, 204);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = /referenced by one or more chats/i.test(message) ? 409 : /not found/i.test(message) ? 404 : 500;
    return c.json({ error: message }, status as 409 | 404 | 500);
  }
});

app.get("/api/personas/:personaId/personal-lorebook", (c) => {
  try {
    return c.json(runtime.getPersonalLorebookStatus(c.req.param("personaId")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, /not found/i.test(message) ? 404 : 500);
  }
});

app.put("/api/personas/:personaId/personal-lorebook", async (c) => {
  const body = await c.req.json();
  const enabled = body.enabled === true;
  try {
    return c.json(runtime.setPersonalLorebookEnabled(c.req.param("personaId"), enabled));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, /not found/i.test(message) ? 404 : 500);
  }
});

app.patch("/api/lorebooks/:lorebookId", async (c) => {
  const body = await c.req.json();
  return c.json(
    runtime.updateLorebook(c.req.param("lorebookId"), body as { chatId: string; lorebookRaw: string }),
  );
});

app.post("/api/lorebooks/:lorebookId/test-activation", async (c) => {
  const body = await c.req.json();
  return c.json(
    runtime.testLoreActivation(c.req.param("lorebookId"), body as { text: string }),
  );
});

app.get("/api/lorebooks/:lorebookId/entries", (c) => {
  return c.json(runtime.listLoreEntries(c.req.param("lorebookId")));
});

app.post("/api/lorebooks/:lorebookId/entries", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.createLoreEntry(c.req.param("lorebookId"), body));
});

app.patch("/api/lorebooks/:lorebookId/entries/:entryId", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.updateLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"), body));
});

app.delete("/api/lorebooks/:lorebookId/entries/:entryId", (c) => {
  runtime.deleteLoreEntry(c.req.param("lorebookId"), c.req.param("entryId"));
  return c.json({ ok: true });
});

app.get("/api/prompt-presets", (c) => {
  return c.json(runtime.listPromptPresets());
});

app.post("/api/prompt-presets", async (c) => {
  const body = await c.req.json();
  try {
    return c.json(runtime.createPromptPreset(body as any), 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, /required/i.test(message) ? 400 : 500);
  }
});

app.patch("/api/prompt-presets/:presetId", async (c) => {
  const body = await c.req.json();
  try {
    return c.json(runtime.updatePromptPreset(c.req.param("presetId"), body as any));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, /not found/i.test(message) ? 404 : 500);
  }
});

app.delete("/api/prompt-presets/:presetId", (c) => {
  try {
    runtime.deletePromptPreset(c.req.param("presetId"));
    return c.body(null, 204);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, /not found/i.test(message) ? 404 : 500);
  }
});

app.get("/api/providers", (c) => {
  return c.json(runtime.listProviderProfiles());
});

app.get("/api/providers/:providerId", (c) => {
  return c.json(runtime.fetchProviderProfile(c.req.param("providerId")));
});

app.delete("/api/providers/:providerId", (c) => {
  runtime.deleteProviderProfile(c.req.param("providerId"));
  return c.json({ ok: true });
});

app.patch("/api/providers/:providerId", async (c) => {
  const body = await c.req.json();
  return c.json(await runtime.updateProviderProfile(c.req.param("providerId"), body));
});

app.post("/api/providers/test", async (c) => {
  const body = await c.req.json();
  return c.json(await runtime.testProviderDraft(body as any));
});

app.post("/api/import/json", async (c) => {
  const body = await c.req.json();
  return c.json(runtime.importJson(body as { fileName: string; jsonText: string; chatId?: string }));
});

app.post("/api/providers", async (c) => {
  const body = await c.req.json();
  return c.json(await runtime.saveProviderDraft(body as any));
});

app.post("/api/providers/:providerId/activate", (c) => {
  return c.json(runtime.activateProviderProfile(c.req.param("providerId")));
});

app.post("/api/providers/fetch-models", async (c) => {
  const body = await c.req.json();
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
  if (!baseUrl.trim()) {
    return c.json({ error: "baseUrl is required." }, 400);
  }
  try {
    const models = await runtime.fetchModelsByEndpoint(baseUrl, apiKey);
    return c.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch models.";
    return c.json({ error: message }, 502);
  }
});

app.post("/api/providers/test-chat", async (c) => {
  const body = await c.req.json();
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
  const model = typeof body?.model === "string" ? body.model : "";
  if (!baseUrl || !model) {
    return c.json({ error: "baseUrl and model are required." }, 400);
  }
  return c.json(await testProviderChat({ baseUrl, apiKey, model }));
});

app.post("/api/providers/:providerId/models", (c) => {
  return c.json(runtime.fetchProviderModels(c.req.param("providerId")));
});

app.post("/api/providers/:providerId/test", (c) => {
  return c.json(runtime.testProviderProfile(c.req.param("providerId")));
});

app.post("/api/providers/:providerId/test-chat", async (c) => {
  const body = await c.req.json();
  const model = typeof body?.model === "string" ? body.model : "";
  if (!model) {
    return c.json({ error: "model is required." }, 400);
  }
  const profile = getRequiredProviderProfile(c.req.param("providerId"));
  return c.json(await testProviderChat({
    baseUrl: profile.endpoint,
    apiKey: profile.apiKey ?? "",
    model,
  }));
});

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
