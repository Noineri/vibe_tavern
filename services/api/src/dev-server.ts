import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import { SessionRuntime } from "./session-runtime.js";
import { ProviderOrchestrator } from "./provider-orchestrator.js";
import { probeProviderConnection } from "./provider-gateway.js";
import { ProviderManager } from "./providers/manager.js";

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
    const profile = sessionRuntime.resolveActiveProviderProfile();
    if (!profile) {
      throw new Error("No active provider profile. Activate one in Provider settings.");
    }
    if (!profile.defaultModel) {
      throw new Error("Active provider profile has no default model. Pick a model and save the profile.");
    }
    const result = await liveChatOrchestrator.sendMessage({
      chatId,
      content: body.content,
      profile,
      model: profile.defaultModel,
    });
    return result.snapshot;
  },
  updateCharacter: (characterId: string, body: { chatId?: string; name?: string; description?: string; scenario?: string; systemPrompt?: string; mesExample?: string | null; alternateGreetings?: string[]; postHistoryInstructions?: string | null; creatorNotes?: string | null }) =>
    sessionRuntime.updateCharacter(characterId, body),
  updatePersona: (personaId: string, body: { chatId?: string; name?: string; description?: string }) =>
    sessionRuntime.updatePersona(personaId, body),
  listPersonas: () => sessionRuntime.listPersonas(),
  setChatPersona: (chatId: string, personaId: string) => sessionRuntime.setChatPersona(chatId, personaId),
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
  importJson: (body: { fileName: string; jsonText: string; chatId?: string }) => sessionRuntime.importJson(body),
  forkBranch: (chatId: string) => sessionRuntime.forkBranch(chatId),
  activateBranch: (chatId: string, branchId: string) => sessionRuntime.activateBranch(chatId, branchId),
  mergeBranch: (chatId: string, sourceBranchId: string, targetBranchId: string) =>
    sessionRuntime.mergeBranch(chatId, sourceBranchId, targetBranchId),
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

const server = createServer(async (request, response) => {
  try {
    await routeRequest(request, response);
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

server.listen(port, host, () => {
  console.log(`RP Platform API listening on http://${host}:${port}`);
});

async function routeRequest(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (method === "OPTIONS") {
    writeEmpty(response, 204);
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "rp-platform-api",
      time: new Date().toISOString(),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    writeJson(response, 200, runtime.bootstrap());
    return;
  }

  if (method === "GET" && url.pathname === "/api/personas") {
    writeJson(response, 200, runtime.listPersonas());
    return;
  }

  if (method === "POST" && url.pathname === "/api/personas") {
    const body = await readJsonBody(request);
    writeJson(response, 201, runtime.createPersona(body as { name: string; description: string; pronouns?: string | null; defaultForNewChats?: boolean }));
    return;
  }

  if (method === "GET" && /^\/api\/chats\/[^/]+$/.test(url.pathname)) {
    const chatId = url.pathname.split("/").pop()!;
    writeJson(response, 200, runtime.getChatSnapshot(chatId));
    return;
  }

  if (method === "POST" && url.pathname === "/api/chats") {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.createChatForCharacter(body.characterId as string));
    return;
  }

  const chatCloneMatch = /^\/api\/chats\/([^/]+)\/clone$/.exec(url.pathname);
  if (method === "POST" && chatCloneMatch) {
    writeJson(response, 200, runtime.cloneChat(chatCloneMatch[1]));
    return;
  }

  const characterExportMatch = /^\/api\/characters\/([^/]+)\/export$/.exec(url.pathname);
  if (method === "GET" && characterExportMatch) {
    writeJson(response, 200, runtime.exportCharacter(characterExportMatch[1]));
    return;
  }

  const chatExportJsonlMatch = /^\/api\/chats\/([^/]+)\/export\.jsonl$/.exec(url.pathname);
  if (method === "GET" && chatExportJsonlMatch) {
    writeText(response, 200, "application/x-ndjson; charset=utf-8", runtime.exportChatJsonl(chatExportJsonlMatch[1]));
    return;
  }

  const promptTraceExportMatch = /^\/api\/prompt-traces\/([^/]+)\/export$/.exec(url.pathname);
  if (method === "GET" && promptTraceExportMatch) {
    writeJson(response, 200, runtime.exportPromptTrace(promptTraceExportMatch[1]));
    return;
  }

  const chatSettingsMatch = /^\/api\/chats\/([^/]+)\/settings$/.exec(url.pathname);
  if (method === "PATCH" && chatSettingsMatch) {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      runtime.updateChatSettings(chatSettingsMatch[1], body as {
        title: string;
        subtitle: string;
        scenario: string;
        systemPrompt: string;
      }),
    );
    return;
  }

  const messageBranchMatch = /^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/branch$/.exec(url.pathname);
  if (method === "POST" && messageBranchMatch) {
    writeJson(response, 200, runtime.branchChat(messageBranchMatch[1], messageBranchMatch[2]));
    return;
  }

  const messageRegenerateMatch = /^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/regenerate$/.exec(url.pathname);
  if (method === "POST" && messageRegenerateMatch) {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      await runtime.regenerateMessage(
        messageRegenerateMatch[1],
        messageRegenerateMatch[2],
        body,
      ),
    );
    return;
  }

  const messageVariantMatch = /^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/variants\/(\d+)\/select$/.exec(url.pathname);
  if (method === "POST" && messageVariantMatch) {
    writeJson(response, 200, runtime.selectVariant(messageVariantMatch[1], messageVariantMatch[2], Number(messageVariantMatch[3])));
    return;
  }

  const messageMatch = /^\/api\/chats\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && messageMatch) {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.editMessage(messageMatch[1], messageMatch[2], body.content ?? ""));
    return;
  }

  if (method === "DELETE" && messageMatch) {
    writeJson(response, 200, runtime.deleteMessage(messageMatch[1], messageMatch[2]));
    return;
  }

  const messagesCreateMatch = /^\/api\/chats\/([^/]+)\/messages$/.exec(url.pathname);
  if (method === "POST" && messagesCreateMatch) {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      await runtime.sendMessage(
        messagesCreateMatch[1],
        body as { content: string },
      ),
    );
    return;
  }

  const setPersonaMatch = /^\/api\/chats\/([^/]+)\/set-persona$/.exec(url.pathname);
  if (method === "POST" && setPersonaMatch) {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.setChatPersona(setPersonaMatch[1], body.personaId));
    return;
  }

  const forkChatMatch = /^\/api\/chats\/([^/]+)\/fork$/.exec(url.pathname);
  if (method === "POST" && forkChatMatch) {
    writeJson(response, 200, runtime.forkBranch(forkChatMatch[1]));
    return;
  }

  const activateBranchMatch = /^\/api\/chats\/([^/]+)\/branches\/([^/]+)\/activate$/.exec(url.pathname);
  if (method === "POST" && activateBranchMatch) {
    writeJson(response, 200, runtime.activateBranch(activateBranchMatch[1], activateBranchMatch[2]));
    return;
  }

  const branchMergeMatch = /^\/api\/chats\/([^/]+)\/branches\/merge$/.exec(url.pathname);
  if (method === "POST" && branchMergeMatch) {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.mergeBranch(branchMergeMatch[1], body.sourceBranchId as string, body.targetBranchId as string));
    return;
  }

  const branchDeleteMatch = /^\/api\/chats\/([^/]+)\/branches\/([^/]+)$/.exec(url.pathname);
  if (method === "DELETE" && branchDeleteMatch) {
    writeJson(response, 200, runtime.deleteBranch(branchDeleteMatch[1], branchDeleteMatch[2]));
    return;
  }

  const chatRootMatch = /^\/api\/chats\/([^/]+)$/.exec(url.pathname);
  if (method === "DELETE" && chatRootMatch) {
    runtime.deleteChat(chatRootMatch[1]);
    writeEmpty(response, 204);
    return;
  }

  const renameChatMatch = /^\/api\/chats\/([^/]+)\/title$/.exec(url.pathname);
  if (method === "PATCH" && renameChatMatch) {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.renameChat(renameChatMatch[1], body.title as string));
    return;
  }

  const archiveCharMatch = /^\/api\/characters\/([^/]+)\/archive$/.exec(url.pathname);
  if (method === "PATCH" && archiveCharMatch) {
    writeJson(response, 200, runtime.archiveCharacter(archiveCharMatch[1]));
    return;
  }

  const unarchiveCharMatch = /^\/api\/characters\/([^/]+)\/unarchive$/.exec(url.pathname);
  if (method === "PATCH" && unarchiveCharMatch) {
    writeJson(response, 200, runtime.unarchiveCharacter(unarchiveCharMatch[1]));
    return;
  }

  const characterMatch = /^\/api\/characters\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && characterMatch) {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      runtime.updateCharacter(characterMatch[1], body as {
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
    return;
  }

  if (method === "DELETE" && characterMatch) {
    runtime.deleteCharacter(characterMatch[1]);
    writeEmpty(response, 204);
    return;
  }

  const personaMatch = /^\/api\/personas\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && personaMatch) {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      runtime.updatePersona(personaMatch[1], body as {
        chatId: string;
        name: string;
        description: string;
        systemPrompt: string;
      }),
    );
    return;
  }

  if (method === "DELETE" && personaMatch) {
    try {
      runtime.deletePersona(personaMatch[1]);
      writeEmpty(response, 204);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = /referenced by one or more chats/i.test(message) ? 409 : /not found/i.test(message) ? 404 : 500;
      writeJson(response, status, { error: message });
    }
    return;
  }

  const personaPersonalLorebookMatch = /^\/api\/personas\/([^/]+)\/personal-lorebook$/.exec(url.pathname);
  if (method === "GET" && personaPersonalLorebookMatch) {
    try {
      writeJson(response, 200, runtime.getPersonalLorebookStatus(personaPersonalLorebookMatch[1]));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(response, /not found/i.test(message) ? 404 : 500, { error: message });
    }
    return;
  }
  if (method === "PUT" && personaPersonalLorebookMatch) {
    const body = await readJsonBody(request);
    const enabled = body.enabled === true;
    try {
      writeJson(response, 200, runtime.setPersonalLorebookEnabled(personaPersonalLorebookMatch[1], enabled));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(response, /not found/i.test(message) ? 404 : 500, { error: message });
    }
    return;
  }

  const lorebookMatch = /^\/api\/lorebooks\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && lorebookMatch) {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      runtime.updateLorebook(lorebookMatch[1], body as { chatId: string; lorebookRaw: string }),
      );
    return;
  }

  const testActivationMatch = /^\/api\/lorebooks\/([^/]+)\/test-activation$/.exec(url.pathname);
  if (method === "POST" && testActivationMatch) {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      runtime.testLoreActivation(testActivationMatch[1], body as { text: string }),
    );
    return;
  }

  const createLoreEntryMatch = /^\/api\/lorebooks\/([^/]+)\/entries$/.exec(url.pathname);
  if (method === "GET" && createLoreEntryMatch) {
    writeJson(response, 200, runtime.listLoreEntries(createLoreEntryMatch[1]));
    return;
  }
  if (method === "POST" && createLoreEntryMatch) {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.createLoreEntry(createLoreEntryMatch[1], body));
    return;
  }

  const updateLoreEntryMatch = /^\/api\/lorebooks\/([^/]+)\/entries\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && updateLoreEntryMatch) {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.updateLoreEntry(updateLoreEntryMatch[1], updateLoreEntryMatch[2], body));
    return;
  }
  if (method === "DELETE" && updateLoreEntryMatch) {
    runtime.deleteLoreEntry(updateLoreEntryMatch[1], updateLoreEntryMatch[2]);
    writeJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && url.pathname === "/api/prompt-presets") {
    writeJson(response, 200, runtime.listPromptPresets());
    return;
  }
  if (method === "POST" && url.pathname === "/api/prompt-presets") {
    const body = await readJsonBody(request);
    try {
      writeJson(response, 201, runtime.createPromptPreset(body as any));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(response, /required/i.test(message) ? 400 : 500, { error: message });
    }
    return;
  }
  const promptPresetMatch = /^\/api\/prompt-presets\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && promptPresetMatch) {
    const body = await readJsonBody(request);
    try {
      writeJson(response, 200, runtime.updatePromptPreset(promptPresetMatch[1], body as any));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(response, /not found/i.test(message) ? 404 : 500, { error: message });
    }
    return;
  }
  if (method === "DELETE" && promptPresetMatch) {
    try {
      runtime.deletePromptPreset(promptPresetMatch[1]);
      writeEmpty(response, 204);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(response, /not found/i.test(message) ? 404 : 500, { error: message });
    }
    return;
  }

  if (method === "GET" && url.pathname === "/api/providers") {
    writeJson(response, 200, runtime.listProviderProfiles());
    return;
  }

  const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && providerMatch) {
    writeJson(response, 200, runtime.fetchProviderProfile(providerMatch[1]));
    return;
  }

  if (method === "DELETE" && providerMatch) {
    runtime.deleteProviderProfile(providerMatch[1]);
    writeJson(response, 200, { ok: true });
    return;
  }

  if (method === "PATCH" && providerMatch) {
    const body = await readJsonBody(request);
    writeJson(response, 200, await runtime.updateProviderProfile(providerMatch[1], body));
    return;
  }

  if (method === "POST" && url.pathname === "/api/providers/test") {
    const body = await readJsonBody(request);
    writeJson(response, 200, await runtime.testProviderDraft(body as any));
    return;
  }

  if (method === "POST" && url.pathname === "/api/import/json") {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      runtime.importJson(body as { fileName: string; jsonText: string; chatId?: string }),
    );
    return;
  }

  if (method === "POST" && url.pathname === "/api/providers") {
    const body = await readJsonBody(request);
    writeJson(response, 200, await runtime.saveProviderDraft(body as any));
    return;
  }

  const providerActivateMatch = /^\/api\/providers\/([^/]+)\/activate$/.exec(url.pathname);
  if (method === "POST" && providerActivateMatch) {
    writeJson(response, 200, runtime.activateProviderProfile(providerActivateMatch[1]));
    return;
  }

  const providerModelsMatch = /^\/api\/providers\/([^/]+)\/models$/.exec(url.pathname);
  if (method === "POST" && providerModelsMatch) {
    writeJson(response, 200, await runtime.fetchProviderModels(providerModelsMatch[1]));
    return;
  }

  const providerTestSavedMatch = /^\/api\/providers\/([^/]+)\/test$/.exec(url.pathname);
  if (method === "POST" && providerTestSavedMatch) {
    writeJson(response, 200, await runtime.testProviderProfile(providerTestSavedMatch[1]));
    return;
  }

  writeJson(response, 404, { error: `Route not found: ${method} ${url.pathname}` });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as Record<string, any>;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function writeEmpty(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.end();
}

function writeText(response: ServerResponse, statusCode: number, contentType: string, payload: string) {
  response.statusCode = statusCode;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Content-Type", contentType);
  response.end(payload);
}

function getRequiredProviderProfile(providerProfileId: string) {
  const profile = sessionRuntime.getProviderProfile(providerProfileId);
  if (!profile) {
    throw new Error(`Provider profile '${providerProfileId}' was not found.`);
  }
  return profile;
}
