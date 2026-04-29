import type { AssemblePromptResponse } from "@rp-platform/api-contracts";
import * as https from "node:https";
import * as http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logSendDebug } from "./send-debug-log.js";

export interface ProviderConnectionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  minP?: number | null;
  topK?: number | null;
  typicalP?: number | null;
  repPen?: number | null;
  freqPen?: number | null;
  presPen?: number | null;
  stopSeq?: string | null;
  seed?: number | string | null;
  reasoningEffort?: string | null;
}

export interface ProviderModelOption {
  id: string;
  label: string;
}

const PROBE_TIMEOUT_MS = 5_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;
const CHAT_COMPLETION_TIMEOUT_MS = 90_000;
const TEST_CHAT_TIMEOUT_MS = 15_000;

export interface ProviderProbeResult {
  success: boolean;
  error?: string;
  modelCount?: number;
}

type ChatCompletionRole = "system" | "user" | "assistant" | "tool";

interface ChatCompletionMessage {
  role: ChatCompletionRole;
  content: string;
}

interface OpenAiModelRecord {
  id?: string;
  name?: string;
  owned_by?: string;
}

interface OpenAiModelsResponse {
  data?: OpenAiModelRecord[];
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    text?: string;
  }>;
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  if (normalized.endsWith("/chat/completions")) {
    return normalized.slice(0, -"/chat/completions".length);
  }

  return normalized;
}

export async function probeProviderConnection(
  input: { baseUrl: string; apiKey: string },
): Promise<ProviderProbeResult> {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  if (!baseUrl) {
    return { success: false, error: "Provider endpoint is required." };
  }
  const parsed = tryParseUrl(baseUrl);
  if (!parsed) {
    return { success: false, error: "Provider endpoint is invalid." };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { success: false, error: "Provider endpoint must use http or https." };
  }

  let response: Response;
  try {
    response = await fetch(buildModelsUrl(baseUrl), {
      method: "GET",
      headers: buildHeaders(input.apiKey),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      success: false,
      error: `Network error during probe: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.ok) {
    let modelCount: number | undefined;
    try {
      const payload = (await response.json()) as OpenAiModelsResponse;
      modelCount = Array.isArray(payload.data) ? payload.data.length : undefined;
    } catch {
      modelCount = undefined;
    }
    return { success: true, modelCount };
  }

  if (response.status === 401 || response.status === 403) {
    return { success: false, error: `Authentication rejected (${response.status} ${response.statusText}).` };
  }
  if (response.status === 404) {
    return { success: false, error: "Provider does not expose a /models endpoint." };
  }
  return { success: false, error: `Probe failed: ${response.status} ${response.statusText}` };
}

export interface TestChatResult {
  success: boolean;
  reply?: string;
  error?: string;
}

export async function testProviderChat(
  input: ProviderConnectionInput,
): Promise<TestChatResult> {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  if (!baseUrl) return { success: false, error: "Provider endpoint is required." };
  if (!input.model) return { success: false, error: "Model is required." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_CHAT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(input.apiKey, true),
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 64,
        temperature: 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return { success: false, error: `${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ""}` };
    }

    const payload = (await response.json()) as OpenAiChatCompletionResponse;
    const content = extractChoiceContent(payload.choices?.[0]);
    return { success: true, reply: content || "(empty response)" };
  } catch (error) {
    clearTimeout(timer);
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof Error && (error.name === "TimeoutError" || /aborted/i.test(error.message))) {
      return { success: false, error: `Timed out after ${Math.floor(TEST_CHAT_TIMEOUT_MS / 1000)}s.` };
    }
    return { success: false, error: msg };
  }
}

export async function listProviderModels(
  input: Omit<ProviderConnectionInput, "model">,
): Promise<ProviderModelOption[]> {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  const url = buildModelsUrl(baseUrl);
  let response: Response;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(input.apiKey),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    clearTimeout(timer);
    throw wrapProviderNetworkError(error, {
      operation: "Model list request",
      timeoutMs: MODEL_LIST_TIMEOUT_MS,
    });
  }

  if (!response.ok) {
    throw new Error(`Model list request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as OpenAiModelsResponse;
  const records = Array.isArray(payload.data) ? payload.data : [];

  return records
    .map((record) => {
      const id = (record.id ?? record.name ?? "").trim();
      if (!id) {
        return null;
      }

      return {
        id,
        label: record.owned_by ? `${id} - ${record.owned_by}` : id,
      };
    })
    .filter((record): record is ProviderModelOption => Boolean(record))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function generateProviderReply(
  input: ProviderConnectionInput,
  prompt: AssemblePromptResponse,
): Promise<string> {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  const messages = extractChatCompletionMessages(prompt);

  // Build request body from profile settings — no hardcoded values.
  // Omit max_tokens entirely if not set, letting the model decide.
  const bodyParams: Record<string, unknown> = {
    model: input.model,
    messages,
    stream: false,
  };
  if (input.maxTokens != null && input.maxTokens > 0) {
    bodyParams.max_tokens = input.maxTokens;
  }
  if (input.temperature != null) {
    bodyParams.temperature = input.temperature;
  }
  if (input.topP != null) {
    bodyParams.top_p = input.topP;
  }
  if (input.minP != null) {
    bodyParams.min_p = input.minP;
  }
  if (input.topK != null) {
    bodyParams.top_k = input.topK;
  }
  if (input.typicalP != null) {
    bodyParams.typical_p = input.typicalP;
  }
  if (input.repPen != null) {
    bodyParams.repetition_penalty = input.repPen;
  }
  if (input.freqPen != null) {
    bodyParams.frequency_penalty = input.freqPen;
  }
  if (input.presPen != null) {
    bodyParams.presence_penalty = input.presPen;
  }
  if (input.stopSeq && input.stopSeq.trim()) {
    bodyParams.stop = input.stopSeq.trim();
  }
  if (input.seed != null && String(input.seed).trim()) {
    const seedNum = Number(input.seed);
    if (!isNaN(seedNum)) bodyParams.seed = seedNum;
  }
  if (input.reasoningEffort && input.reasoningEffort.trim()) {
    bodyParams.reasoning_effort = input.reasoningEffort.trim();
  }

  const body = JSON.stringify(bodyParams);

  logSendDebug("provider.generate.rawRequest", {
    url: `${baseUrl}/chat/completions`,
    bodyLength: body.length,
    messageCount: messages.length,
  });

  const response = await httpRequest("POST", `${baseUrl}/chat/completions`, {
    Authorization: `Bearer ${input.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  }, body, CHAT_COMPLETION_TIMEOUT_MS);

  if (response.status >= 300) {
    throw new Error(
      `Chat completion failed: ${response.status} ${response.statusText ?? ""}${response.body ? ` - ${response.body.slice(0, 500)}` : ""}`,
    );
  }

  // Dump raw response body to file for inspection (robust — no JSON.stringify)
  try {
    const dumpPath = resolve(process.cwd(), "logs/provider-response-dump.txt");
    mkdirSync(dirname(dumpPath), { recursive: true });
    const pos = response.body.indexOf("\n") >= 0 || response.body.indexOf("\r") >= 0
      ? `CONTAINS_RAW_NEWLINES=true`
      : `CONTAINS_RAW_NEWLINES=false`;
    writeFileSync(dumpPath, [
      `=== Provider Response Dump ${new Date().toISOString()} ===`,
      `Body length: ${response.body.length} bytes`,
      `First parse attempt...`,
      pos,
      "",
      "--- RAW BODY ---",
      response.body,
      "--- END RAW BODY ---",
      "",
    ].join("\n"), "utf8");
  } catch {
    // dump is best-effort
  }

  let payload: OpenAiChatCompletionResponse;
  try {
    payload = JSON.parse(response.body) as OpenAiChatCompletionResponse;
  } catch (parseError) {
    const posMatch = parseError instanceof Error
      ? /position\s+(\d+)/i.exec(parseError.message)
      : null;
    const errorPos = posMatch ? Number(posMatch[1]) : null;

    // Write detailed parse error context to a separate file
    if (errorPos != null) {
      try {
        const errDumpPath = resolve(process.cwd(), "logs/provider-parse-error.txt");
        const contextRadius = 150;
        const before = response.body.slice(Math.max(0, errorPos - contextRadius), errorPos);
        const after = response.body.slice(errorPos, errorPos + contextRadius);

        let hexDump = "";
        const dumpStart = Math.max(0, errorPos - 30);
        const dumpEnd = Math.min(response.body.length, errorPos + 30);
        for (let i = dumpStart; i < dumpEnd; i++) {
          const code = response.body.charCodeAt(i);
          const ch = response.body[i];
          const marker = i === errorPos ? " <<< ERROR HERE" : "";
          hexDump += `  [${i}] 0x${code.toString(16).padStart(2, "0")} (${code}) '${code < 32 ? "?" : ch}'${marker}\n`;
        }

        writeFileSync(errDumpPath, [
          `=== JSON Parse Error ${new Date().toISOString()} ===`,
          `Error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          `Body length: ${response.body.length}`,
          `Error position: ${errorPos}`,
          "",
          "--- BEFORE ERROR POSITION ---",
          before,
          "",
          "--- AT/AFTER ERROR POSITION ---",
          after,
          "",
          "--- HEX DUMP AROUND ERROR ---",
          hexDump,
          "--- END ---",
        ].join("\n"), "utf8");
      } catch {
        // dump is best-effort
      }
    }

    // Fallback: nanogpt (and similar providers behind Vercel) may truncate
    // chunked responses when the model generates reasoning tokens. The
    // "content" field always appears before "reasoning" in the JSON, so we
    // can extract it from the truncated body.
    const recoveredContent = tryExtractContentFromTruncatedJson(response.body);
    if (recoveredContent) {
      logSendDebug("provider.generate.truncatedRecovery", {
        bodyLength: response.body.length,
        recoveredContentLength: recoveredContent.length,
        errorPos,
      });
      return recoveredContent;
    }

    throw parseError;
  }

  const choice = payload.choices?.[0];
  const content = extractChoiceContent(choice);

  if (!content) {
    throw new Error("Chat completion returned empty content.");
  }

  return content;
}

function buildHeaders(apiKey: string, withBody = false): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (withBody) {
    headers["Content-Type"] = "application/json";
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildModelsUrl(baseUrl: string): string {
  return `${baseUrl}/models`;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractChatCompletionMessages(
  prompt: AssemblePromptResponse,
): ChatCompletionMessage[] {
  const payload = prompt.finalPayload as { messages?: unknown };
  const records = Array.isArray(payload.messages) ? payload.messages : [];

  return records
    .map((record) => {
      if (!record || typeof record !== "object") {
        return null;
      }

      const role = typeof record.role === "string" ? record.role : null;
      const content = typeof record.content === "string" ? record.content : null;

      if (!role || !content || !isChatCompletionRole(role)) {
        return null;
      }

      return {
        role,
        content,
      };
    })
    .filter((record): record is ChatCompletionMessage => Boolean(record));
}

function isChatCompletionRole(role: string): role is ChatCompletionRole {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function extractChoiceContent(
  choice:
    | {
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
        text?: string;
      }
    | undefined,
): string {
  if (!choice) {
    return "";
  }

  if (typeof choice.message?.content === "string") {
    return choice.message.content.trim();
  }

  if (Array.isArray(choice.message?.content)) {
    return choice.message.content
      .map((part) => (part.type === "text" ? part.text ?? "" : ""))
      .join("")
      .trim();
  }

  return (choice.text ?? "").trim();
}

/**
 * Attempts to extract the "content" string from a truncated JSON response.
 *
 * Some providers (nanogpt via Vercel) truncate the chunked HTTP body when
 * the model generates large reasoning/thinking tokens. The "content" field
 * always appears before "reasoning" in the response, so we can recover it
 * by scanning for the "content" key and unescaping its string value.
 */
function tryExtractContentFromTruncatedJson(body: string): string | null {
  // Look for "content":"..." in the body.
  // The content value may contain escaped characters (\n, \", \\, etc.)
  // but should not contain raw control characters in valid JSON.
  const contentKeyIdx = body.indexOf('"content":"');
  if (contentKeyIdx < 0) {
    return null;
  }

  const valueStart = contentKeyIdx + '"content":"'.length;

  // Walk the string, respecting JSON escape sequences, to find the closing quote.
  let i = valueStart;
  const parts: string[] = [];
  let current = "";

  while (i < body.length) {
    const ch = body[i];

    if (ch === "\\") {
      // Escape sequence
      if (i + 1 >= body.length) {
        // Truncated mid-escape — append what we have
        break;
      }
      const next = body[i + 1];
      switch (next) {
        case "n": current += "\n"; break;
        case "r": current += "\r"; break;
        case "t": current += "\t"; break;
        case '"': current += '"'; break;
        case "\\": current += "\\"; break;
        case "/": current += "/"; break;
        case "b": current += "\b"; break;
        case "f": current += "\f"; break;
        case "u": {
          // Unicode escape: \uXXXX
          if (i + 5 < body.length) {
            const hex = body.slice(i + 2, i + 6);
            const code = parseInt(hex, 16);
            if (!isNaN(code)) {
              current += String.fromCodePoint(code);
              i += 6;
              continue;
            }
          }
          // Truncated unicode — stop
          break;
        }
        default:
          // Unknown escape — keep as-is
          current += ch + next;
      }
      i += 2;
      continue;
    }

    if (ch === '"') {
      // End of content string
      parts.push(current);
      current = "";
      // Successfully closed — this is the full content
      return parts.join("").trim();
    }

    current += ch;
    i++;
  }

  // Reached end of body without closing quote — content was truncated
  // but we have a substantial prefix. Return it if it's meaningful.
  parts.push(current);
  const recovered = parts.join("").trim();
  if (recovered.length < 50) {
    return null; // Too short to be useful
  }

  logSendDebug("provider.generate.truncatedContentPartial", {
    recoveredLength: recovered.length,
    bodyLength: body.length,
    note: "Content string was truncated but partial text recovered",
  });

  return recovered;
}

function wrapProviderNetworkError(
  error: unknown,
  input: {
    operation: string;
    timeoutMs: number;
  },
): Error {
  const timeoutSeconds = Math.floor(input.timeoutMs / 1000);
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || /aborted due to timeout/i.test(error.message))
  ) {
    return new Error(`${input.operation} timed out after ${timeoutSeconds}s.`);
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`${input.operation} failed.`);
}

interface HttpResult {
  status: number;
  statusText: string;
  body: string;
}

function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const requestStartMs = Date.now();
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const requestOptions: https.RequestOptions = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        ...headers,
        ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
      },
    };

    let totalChunks = 0;
    let totalBytes = 0;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const BODY_IDLE_MS = 5_000; // Resolve with partial data if stream stalls for 5s

    // Shared state between response handler and timers.
    const chunks: Buffer[] = [];
    let responseStatusCode: number = 0;
    let responseStatusText: string = "";

    const finish = (result: HttpResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(absoluteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        resolve(result);
      }
    };

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(absoluteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        reject(err);
      }
    };

    const resolvePartial = (reason: string) => {
      if (settled) return;
      const partialBody = Buffer.concat(chunks).toString("utf-8");
      logSendDebug("provider.generate.httpPartialResolve", {
        reason,
        totalChunks,
        totalBytes,
        bodyLength: partialBody.length,
        elapsedMs: Date.now() - requestStartMs,
      });
      finish({
        status: responseStatusCode,
        statusText: responseStatusText,
        body: partialBody,
      });
      req.destroy();
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      // Only start idle timer after we've received headers AND some body data
      if (responseStatusCode > 0 && totalBytes > 0) {
        idleTimer = setTimeout(() => {
          resolvePartial(`body idle for ${Math.floor(BODY_IDLE_MS / 1000)}s after ${totalChunks} chunks`);
        }, BODY_IDLE_MS);
      }
    };

    const req = transport.request(requestOptions, (res) => {
      const elapsedToHeaders = Date.now() - requestStartMs;
      responseStatusCode = res.statusCode ?? 0;
      responseStatusText = res.statusMessage ?? "";

      logSendDebug("provider.generate.httpResponseHeaders", {
        status: res.statusCode,
        statusText: res.statusMessage,
        contentType: res.headers["content-type"] ?? null,
        contentLength: res.headers["content-length"] ?? null,
        transferEncoding: res.headers["transfer-encoding"] ?? null,
        connection: res.headers["connection"] ?? null,
        httpVersion: res.httpVersion,
        elapsedMs: elapsedToHeaders,
      });

      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        totalChunks++;
        totalBytes += chunk.length;
        resetIdleTimer();
      });

      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf-8");
        logSendDebug("provider.generate.httpResponseEnd", {
          status: res.statusCode,
          totalChunks,
          totalBytes,
          bodyLength: responseBody.length,
          elapsedMs: Date.now() - requestStartMs,
        });
        finish({
          status: responseStatusCode,
          statusText: responseStatusText,
          body: responseBody,
        });
      });

      res.on("error", (err) => {
        // If we have partial data, resolve with it instead of rejecting
        if (totalBytes > 0 && responseStatusCode >= 200) {
          resolvePartial(`response stream error: ${err.message}`);
          return;
        }
        logSendDebug("provider.generate.httpResponseError", {
          message: err.message,
          code: (err as NodeJS.ErrnoException).code,
          totalChunks,
          totalBytes,
          elapsedMs: Date.now() - requestStartMs,
        });
        fail(err);
      });
    });

    req.on("error", (err) => {
      if (totalBytes > 0 && responseStatusCode >= 200) {
        resolvePartial(`request error with data: ${err.message}`);
        return;
      }
      logSendDebug("provider.generate.httpError", {
        message: err.message,
        code: (err as NodeJS.ErrnoException).code,
        syscall: (err as NodeJS.ErrnoException).syscall,
        elapsedMs: Date.now() - requestStartMs,
      });
      fail(err);
    });

    // Absolute deadline (safety net)
    const absoluteTimer = setTimeout(() => {
      if (totalBytes > 0 && responseStatusCode >= 200) {
        resolvePartial("absolute timeout");
      } else {
        req.destroy(new Error(`Request timed out after ${Math.floor(timeoutMs / 1000)}s.`));
      }
    }, timeoutMs);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}
