import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import {
  generateProviderReply,
  listProviderModels,
  normalizeOpenAiCompatibleBaseUrl,
} from "./prototype-provider-gateway.js";
import { PrototypeSessionRuntime } from "./prototype-session-runtime.js";
import { ProviderManager } from "./providers/manager.js";

interface ProviderProfileGenerateRequest {
  model?: string;
  prompt?: AssemblePromptResponse;
}

interface ContentRequest {
  content?: string;
}

interface SendMessageRequest extends ContentRequest {
  providerProfileId?: string;
  model?: string;
}

interface AssemblePromptRequest {
  excludeMessageId?: string;
}

interface MessageVariantRequest {
  content?: string;
  finishReason?: string | null;
}

interface PrototypeImportRequest {
  fileName?: string;
  jsonText?: string;
  chatId?: string;
}

interface CharacterUpdateRequest {
  chatId?: string;
  name?: string;
  description?: string;
  scenario?: string;
}

const host = process.env.RP_PLATFORM_API_HOST ?? "127.0.0.1";
const port = Number(process.env.RP_PLATFORM_API_PORT ?? "8787");
const prototypeRuntime = new PrototypeSessionRuntime();
const providerManager = new ProviderManager();

const server = createServer(async (request, response) => {
  const requestId = createRequestId();
  const method = request.method ?? "GET";
  const path = request.url ?? "/";

  try {
    await routeRequest(request, response, requestId);
  } catch (error) {
    logError("request.unhandled", { requestId, method, path }, error);
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

server.on("error", (error) => {
  console.error("RP Platform API server error:", error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`RP Platform API listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    shutdownServer(signal);
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
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

  if (method === "GET" && url.pathname === "/api/providers") {
    writeJson(response, 200, prototypeRuntime.listProviderProfiles());
    return;
  }

  if (method === "POST" && url.pathname === "/api/providers") {
    const body = await readJsonBody(request);
    const saved = await prototypeRuntime.saveProviderProfile(body);
    writeJson(response, 200, saved);
    return;
  }

  if (method === "GET" && /^\/api\/providers\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split("/").pop()!;
    const profile = prototypeRuntime.getProviderProfileForClient(id);
    if (!profile) {
      writeJson(response, 404, { error: "Provider profile not found" });
      return;
    }
    writeJson(response, 200, profile);
    return;
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/providers/")) {
    const id = url.pathname.split("/").pop()!;
    prototypeRuntime.deleteProviderProfile(id);
    writeJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname.endsWith("/connect")) {
    // Expected path: /api/providers/:id/connect
    const parts = url.pathname.split("/");
    const id = parts[parts.length - 2];
    if (id) {
      const profile = prototypeRuntime.getProviderProfile(id);
      if (!profile) {
        logInfo("provider.connect.rejected", {
          requestId,
          providerProfileId: id,
          reason: "profile_not_found",
        });
        writeJson(response, 404, { error: "Provider profile not found" });
        return;
      }

      logInfo("provider.connect.start", {
        requestId,
        providerProfileId: profile.id,
        providerType: profile.type,
        endpoint: profile.endpoint,
        hasApiKey: Boolean(profile.apiKey?.trim()),
      });

      const result = await providerManager.testProfileConnection({
        id: profile.id,
        name: profile.name,
        type: profile.type as "openai_compat" | "anthropic" | "google" | "cohere",
        endpoint: profile.endpoint,
        api_key: profile.apiKey ?? "",
        default_model: profile.defaultModel ?? null,
        context_budget: profile.contextBudget ?? 8192,
      });

      logInfo("provider.connect.result", {
        requestId,
        providerProfileId: profile.id,
        success: result.success,
        modelCount: result.models.length,
        error: result.error ?? null,
      });

      writeJson(response, 200, result);
      return;
    }
  }

  const savedModelsMatch = /^\/api\/providers\/([^/]+)\/models$/.exec(url.pathname);
  if (method === "POST" && savedModelsMatch) {
    const profile = prototypeRuntime.getProviderProfile(savedModelsMatch[1]);
    if (!profile) {
      logInfo("provider.models.rejected", {
        requestId,
        providerProfileId: savedModelsMatch[1],
        reason: "profile_not_found",
      });
      writeJson(response, 404, { error: "Provider profile not found" });
      return;
    }

    const baseUrl = normalizeOpenAiCompatibleBaseUrl(profile.endpoint ?? "");
    if (!baseUrl) {
      logInfo("provider.models.rejected", {
        requestId,
        providerProfileId: profile.id,
        reason: "missing_endpoint",
      });
      writeJson(response, 400, {
        error: "Saved profile is missing endpoint.",
      });
      return;
    }

    logInfo("provider.models.start", {
      requestId,
      providerProfileId: profile.id,
      endpoint: baseUrl,
      hasApiKey: Boolean(profile.apiKey?.trim()),
    });

    const models = await listProviderModels({
      apiKey: profile.apiKey?.trim() ?? "",
      baseUrl,
    });

    logInfo("provider.models.result", {
      requestId,
      providerProfileId: profile.id,
      modelCount: models.length,
    });

    writeJson(response, 200, {
      models,
    });
    return;
  }

  const savedGenerateMatch = /^\/api\/providers\/([^/]+)\/generate$/.exec(url.pathname);
  if (method === "POST" && savedGenerateMatch) {
    const profile = prototypeRuntime.getProviderProfile(savedGenerateMatch[1]);
    if (!profile) {
      logInfo("provider.generate.rejected", {
        requestId,
        providerProfileId: savedGenerateMatch[1],
        reason: "profile_not_found",
      });
      writeJson(response, 404, { error: "Provider profile not found" });
      return;
    }

    const body = (await readJsonBody(request)) as ProviderProfileGenerateRequest;
    const prompt = body.prompt;
    const model = body.model?.trim() || profile.defaultModel?.trim() || "";
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(profile.endpoint ?? "");

    if (!baseUrl || !model || !prompt) {
      logInfo("provider.generate.rejected", {
        requestId,
        providerProfileId: profile.id,
        reason: "missing_endpoint_model_or_prompt",
        hasPrompt: Boolean(prompt),
        model,
      });
      writeJson(response, 400, {
        error: "Saved profile endpoint, model, and prompt are required.",
      });
      return;
    }

    logInfo("provider.generate.start", {
      requestId,
      providerProfileId: profile.id,
      model,
      promptMessageCount: countPromptMessages(prompt),
    });

    const reply = await generateProviderReply(
      {
        apiKey: profile.apiKey?.trim() ?? "",
        baseUrl,
        model,
      },
      prompt,
    );

    logInfo("provider.generate.result", {
      requestId,
      providerProfileId: profile.id,
      model,
      replyLength: reply.length,
    });

    writeJson(response, 200, {
      content: reply,
    });
    return;
  }

  if (method === "GET" && (url.pathname === "/api/bootstrap" || url.pathname === "/prototype/bootstrap")) {
    writeJson(response, 200, prototypeRuntime.getBootstrapState());
    return;
  }

  if (method === "POST" && (url.pathname === "/api/import/json" || url.pathname === "/prototype/import/json")) {
    const body = (await readJsonBody(request)) as PrototypeImportRequest;
    writeJson(
      response,
      200,
      prototypeRuntime.importJson({
        fileName: body.fileName ?? "import.json",
        jsonText: body.jsonText ?? "",
        chatId: body.chatId,
      }),
    );
    return;
  }

  const characterMatch =
    /^\/api\/characters\/([^/]+)$/.exec(url.pathname) ??
    /^\/prototype\/characters\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && characterMatch) {
    const body = (await readJsonBody(request)) as CharacterUpdateRequest;
    writeJson(
      response,
      200,
      prototypeRuntime.updateCharacter(characterMatch[1], {
        chatId: body.chatId,
        name: body.name,
        description: body.description,
        scenario: body.scenario,
      }),
    );
    return;
  }

  const chatMatch =
    /^\/api\/chats\/([^/]+)$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && chatMatch) {
    writeJson(response, 200, prototypeRuntime.switchChat(chatMatch[1]));
    return;
  }

  const promptTraceLatestMatch =
    /^\/api\/chats\/([^/]+)\/prompt-traces\/latest$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/prompt-traces\/latest$/.exec(url.pathname);
  if (method === "GET" && promptTraceLatestMatch) {
    writeJson(
      response,
      200,
      prototypeRuntime.getLatestPromptTrace(
        promptTraceLatestMatch[1],
        readOptionalBranchId(url),
      ),
    );
    return;
  }

  const promptTraceHistoryMatch =
    /^\/api\/chats\/([^/]+)\/prompt-traces$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/prompt-traces$/.exec(url.pathname);
  if (method === "GET" && promptTraceHistoryMatch) {
    writeJson(
      response,
      200,
      prototypeRuntime.getPromptTraceHistory(
        promptTraceHistoryMatch[1],
        readOptionalBranchId(url),
        readOptionalLimit(url),
      ),
    );
    return;
  }

  const sendMatch =
    /^\/api\/chats\/([^/]+)\/messages$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/messages$/.exec(url.pathname);
  if (method === "POST" && sendMatch) {
    const body = (await readJsonBody(request)) as SendMessageRequest;
    const content = body.content?.trim() ?? "";
    if (!content) {
      logInfo("chat.send.skipped", {
        requestId,
        chatId: sendMatch[1],
        reason: "empty_content",
      });
      writeJson(response, 200, prototypeRuntime.getSnapshot(sendMatch[1]));
      return;
    }

    const providerProfileId = body.providerProfileId?.trim() ?? "";
    const model = body.model?.trim() ?? "";
    if (!providerProfileId || !model) {
      logInfo("chat.send.rejected", {
        requestId,
        chatId: sendMatch[1],
        providerProfileId,
        model,
        reason: "missing_provider_or_model",
      });
      writeJson(response, 400, {
        error: "providerProfileId and model are required for live message sending.",
      });
      return;
    }

    const profile = prototypeRuntime.getProviderProfile(providerProfileId);
    if (!profile) {
      logInfo("chat.send.rejected", {
        requestId,
        chatId: sendMatch[1],
        providerProfileId,
        model,
        reason: "profile_not_found",
      });
      writeJson(response, 404, { error: "Provider profile not found." });
      return;
    }

    const baseUrl = normalizeOpenAiCompatibleBaseUrl(profile.endpoint ?? "");
    if (!baseUrl) {
      logInfo("chat.send.rejected", {
        requestId,
        chatId: sendMatch[1],
        providerProfileId,
        model,
        reason: "missing_endpoint",
      });
      writeJson(response, 400, {
        error: "Saved profile is missing endpoint.",
      });
      return;
    }

    logInfo("chat.send.start", {
      requestId,
      chatId: sendMatch[1],
      providerProfileId,
      model,
      contentLength: content.length,
      hasApiKey: Boolean(profile.apiKey?.trim()),
    });

    const prepared = prototypeRuntime.prepareLiveTurn(sendMatch[1], content);
    logInfo("chat.send.prepared", {
      requestId,
      chatId: sendMatch[1],
      providerProfileId,
      model,
      promptMessageCount: countPromptMessages(prepared.prompt),
      messageCountAfterUserAppend: prepared.snapshot.messages.length,
    });

    const reply = await generateProviderReply(
      {
        apiKey: profile.apiKey?.trim() ?? "",
        baseUrl,
        model,
      },
      prepared.prompt,
    );

    logInfo("chat.send.generated", {
      requestId,
      chatId: sendMatch[1],
      providerProfileId,
      model,
      replyLength: reply.length,
    });

    const snapshot = prototypeRuntime.appendAssistantReply(sendMatch[1], reply);
    const lastMessage = snapshot.messages[snapshot.messages.length - 1] ?? null;
    logInfo("chat.send.completed", {
      requestId,
      chatId: sendMatch[1],
      providerProfileId,
      model,
      finalMessageCount: snapshot.messages.length,
      lastMessageId: lastMessage?.id ?? null,
      lastMessageRole: lastMessage?.role ?? null,
      lastMessageLength: lastMessage?.content.length ?? null,
    });

    writeJson(response, 200, snapshot);
    return;
  }

  const prepareMatch =
    /^\/api\/chats\/([^/]+)\/prepare-live-turn$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/prepare-live-turn$/.exec(url.pathname);
  if (method === "POST" && prepareMatch) {
    const body = (await readJsonBody(request)) as ContentRequest;
    writeJson(response, 200, prototypeRuntime.prepareLiveTurn(prepareMatch[1], body.content ?? ""));
    return;
  }

  const assemblePromptMatch =
    /^\/api\/chats\/([^/]+)\/assemble-prompt$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/assemble-prompt$/.exec(url.pathname);
  if (method === "POST" && assemblePromptMatch) {
    const body = (await readJsonBody(request)) as AssemblePromptRequest;
    writeJson(
      response,
      200,
      prototypeRuntime.assemblePromptPreview(assemblePromptMatch[1], {
        excludeMessageId: body.excludeMessageId,
      }),
    );
    return;
  }

  const messageVariantMatch =
    /^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/variants$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/messages\/([^/]+)\/variants$/.exec(url.pathname);
  if (method === "POST" && messageVariantMatch) {
    const body = (await readJsonBody(request)) as MessageVariantRequest;
    writeJson(
      response,
      200,
      prototypeRuntime.appendMessageVariant(messageVariantMatch[1], messageVariantMatch[2], {
        content: body.content ?? "",
        finishReason: body.finishReason ?? null,
      }),
    );
    return;
  }

  const selectVariantMatch =
    /^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/variants\/(\d+)\/select$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/messages\/([^/]+)\/variants\/(\d+)\/select$/.exec(url.pathname);
  if (method === "POST" && selectVariantMatch) {
    writeJson(
      response,
      200,
      prototypeRuntime.selectMessageVariant(
        selectVariantMatch[1],
        selectVariantMatch[2],
        Number(selectVariantMatch[3]),
      ),
    );
    return;
  }

  const assistantMatch =
    /^\/api\/chats\/([^/]+)\/assistant$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/assistant$/.exec(url.pathname);
  if (method === "POST" && assistantMatch) {
    const body = (await readJsonBody(request)) as ContentRequest;
    writeJson(response, 200, prototypeRuntime.appendAssistantReply(assistantMatch[1], body.content ?? ""));
    return;
  }

  const editMatch =
    /^\/api\/chats\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
  if (method === "PATCH" && editMatch) {
    const body = (await readJsonBody(request)) as ContentRequest;
    writeJson(response, 200, prototypeRuntime.editMessage(editMatch[1], editMatch[2], body.content ?? ""));
    return;
  }

  if (method === "DELETE" && editMatch) {
    writeJson(response, 200, prototypeRuntime.deleteMessage(editMatch[1], editMatch[2]));
    return;
  }

  const forkMatch =
    /^\/api\/chats\/([^/]+)\/fork$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/fork$/.exec(url.pathname);
  if (method === "POST" && forkMatch) {
    writeJson(response, 200, prototypeRuntime.forkBranch(forkMatch[1]));
    return;
  }

  const sleepMatch =
    /^\/api\/chats\/([^/]+)\/sleep$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/sleep$/.exec(url.pathname);
  if (method === "POST" && sleepMatch) {
    writeJson(response, 200, prototypeRuntime.sleepBranch(sleepMatch[1]));
    return;
  }

  const refreshMatch =
    /^\/api\/chats\/([^/]+)\/refresh-prompt$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/refresh-prompt$/.exec(url.pathname);
  if (method === "POST" && refreshMatch) {
    writeJson(response, 200, prototypeRuntime.refreshPrompt(refreshMatch[1]));
    return;
  }

  const activateBranchMatch =
    /^\/api\/chats\/([^/]+)\/branches\/([^/]+)\/activate$/.exec(url.pathname) ??
    /^\/prototype\/chats\/([^/]+)\/branches\/([^/]+)\/activate$/.exec(url.pathname);
  if (method === "POST" && activateBranchMatch) {
    writeJson(response, 200, prototypeRuntime.activateBranch(activateBranchMatch[1], activateBranchMatch[2]));
    return;
  }

  writeJson(response, 404, {
    error: "Route not found.",
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  return JSON.parse(text) as unknown;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "DELETE,GET,OPTIONS,PATCH,POST",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function writeEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "DELETE,GET,OPTIONS,PATCH,POST",
    "Access-Control-Allow-Origin": "*",
  });
  response.end();
}

function readOptionalBranchId(url: URL): string | undefined {
  return url.searchParams.get("branchId") ?? undefined;
}

function readOptionalLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function createRequestId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function countPromptMessages(prompt: AssemblePromptResponse): number {
  const payload = prompt.finalPayload as { messages?: unknown };
  return Array.isArray(payload.messages) ? payload.messages.length : 0;
}

function logInfo(event: string, payload: Record<string, unknown>): void {
  console.log(`[${event}] ${JSON.stringify(payload)}`);
}

function logError(event: string, payload: Record<string, unknown>, error: unknown): void {
  const serializedError =
    error instanceof Error
      ? {
          message: error.message,
          stack: error.stack ?? null,
        }
      : {
          message: String(error),
          stack: null,
        };

  console.error(`[${event}] ${JSON.stringify({ ...payload, error: serializedError })}`);
}

let isShuttingDown = false;

function shutdownServer(signal: string): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}. Shutting down RP Platform API...`);

  server.close((error) => {
    if (error) {
      console.error("Failed to close RP Platform API cleanly:", error);
      process.exit(1);
      return;
    }

    console.log("RP Platform API stopped.");
    process.exit(0);
  });

  server.closeIdleConnections?.();

  const forceExitTimer = setTimeout(() => {
    console.error("Forcing RP Platform API shutdown after timeout.");
    server.closeAllConnections?.();
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();
}
