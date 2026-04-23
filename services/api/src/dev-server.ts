import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { LiveChatOrchestrator } from "./live-chat-orchestrator.js";
import { PrototypeSessionRuntime } from "./prototype-session-runtime.js";
import { ProviderOrchestrator } from "./provider-orchestrator.js";
import { ProviderManager } from "./providers/manager.js";

const host = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const port = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");
const sessionRuntime = new PrototypeSessionRuntime();
const providerManager = new ProviderManager();
const providerOrchestrator = new ProviderOrchestrator(sessionRuntime, providerManager);
const liveChatOrchestrator = new LiveChatOrchestrator(sessionRuntime, providerOrchestrator);

const runtime = {
  bootstrap: () => sessionRuntime.getBootstrapState(),
  getChatSnapshot: (chatId: string) => sessionRuntime.getSnapshot(chatId),
  createChat: (_sourceChatId?: string) => {
    throw new Error("Chat creation route is not wired in this baseline.");
  },
  updateChatSettings: (
    _chatId: string,
    _body: { title: string; subtitle: string; scenario: string; systemPrompt: string },
  ) => {
    throw new Error("Chat settings route is not wired in this baseline.");
  },
  branchChat: (chatId: string, _messageId: string) => sessionRuntime.forkBranch(chatId),
  regenerateMessage: async (chatId: string, messageId: string, body: { providerProfileId: string; model: string }) => {
    const profile = getRequiredProviderProfile(body.providerProfileId);
    const result = await liveChatOrchestrator.regenerateMessage({ chatId, messageId, profile, model: body.model });
    return result.snapshot;
  },
  selectVariant: (chatId: string, messageId: string, variantIndex: number) =>
    sessionRuntime.selectMessageVariant(chatId, messageId, variantIndex),
  editMessage: (chatId: string, messageId: string, content: string) =>
    sessionRuntime.editMessage(chatId, messageId, content),
  deleteMessage: (chatId: string, messageId: string) => sessionRuntime.deleteMessage(chatId, messageId),
  sendMessage: async (chatId: string, body: { content: string; providerProfileId: string; model: string }) => {
    const profile = getRequiredProviderProfile(body.providerProfileId);
    const result = await liveChatOrchestrator.sendMessage({ chatId, content: body.content, profile, model: body.model });
    return result.snapshot;
  },
  updateCharacter: (characterId: string, body: { chatId?: string; name?: string; description?: string; scenario?: string; systemPrompt?: string }) =>
    sessionRuntime.updateCharacter(characterId, body),
  updatePersona: (personaId: string, body: { chatId?: string; name?: string; description?: string }) =>
    sessionRuntime.updatePersona(personaId, body),
  updateLorebook: (_lorebookId: string, _body: { chatId: string; lorebookRaw: string }) => {
    throw new Error("Lorebook patch route is not wired in this baseline.");
  },
  listProviderProfiles: () => sessionRuntime.listProviderProfiles(),
  fetchProviderProfile: (providerProfileId: string) => {
    const profile = sessionRuntime.getProviderProfileForClient(providerProfileId);
    if (!profile) {
      throw new Error(`Provider profile '${providerProfileId}' was not found.`);
    }
    return profile;
  },
  connectProviderProfile: async (providerProfileId: string) =>
    providerOrchestrator.connectProfile(getRequiredProviderProfile(providerProfileId)),
  saveProviderDraft: async (body: unknown) => sessionRuntime.saveProviderProfile(body),
  testProviderDraft: async (_body: unknown) => ({
    success: false,
    models: [],
    error: "Provider draft test is not wired in this baseline.",
  }),
  deleteProviderProfile: (providerProfileId: string) => sessionRuntime.deleteProviderProfile(providerProfileId),
  fetchProviderModels: async (providerProfileId: string) => ({
    models: await providerOrchestrator.refreshProfileModels(getRequiredProviderProfile(providerProfileId)),
  }),
  importJson: (body: { fileName: string; jsonText: string; chatId?: string }) => sessionRuntime.importJson(body),
  forkBranch: (chatId: string) => sessionRuntime.forkBranch(chatId),
  activateBranch: (chatId: string, branchId: string) => sessionRuntime.activateBranch(chatId, branchId),
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

  if (method === "GET" && /^\/api\/chats\/[^/]+$/.test(url.pathname)) {
    const chatId = url.pathname.split("/").pop()!;
    writeJson(response, 200, runtime.getChatSnapshot(chatId));
    return;
  }

  if (method === "POST" && url.pathname === "/api/chats") {
    const body = await readJsonBody(request);
    writeJson(response, 200, runtime.createChat(body.sourceChatId));
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
        body as { providerProfileId: string; model: string },
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
        body as { content: string; providerProfileId: string; model: string },
      ),
    );
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
        personality: string;
        tags: string[];
      }),
    );
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

  const providerConnectMatch = /^\/api\/providers\/([^/]+)\/connect$/.exec(url.pathname);
  if (method === "POST" && providerConnectMatch) {
    writeJson(response, 200, await runtime.connectProviderProfile(providerConnectMatch[1]));
    return;
  }

  const providerModelsMatch = /^\/api\/providers\/([^/]+)\/models$/.exec(url.pathname);
  if (method === "POST" && providerModelsMatch) {
    writeJson(response, 200, await runtime.fetchProviderModels(providerModelsMatch[1]));
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

function getRequiredProviderProfile(providerProfileId: string) {
  const profile = sessionRuntime.getProviderProfile(providerProfileId);
  if (!profile) {
    throw new Error(`Provider profile '${providerProfileId}' was not found.`);
  }
  return profile;
}
