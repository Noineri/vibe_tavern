import type { AiAssistantChunk, AiAssistantRequestBody, AiAssistantTokenCount } from "./types.js";
import { getGatewayBaseUrl } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

export async function countAiAssistantTokens(
  body: AiAssistantRequestBody,
  options?: { signal?: AbortSignal },
): Promise<AiAssistantTokenCount> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/ai-assistant/tokens`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<AiAssistantTokenCount>;
}

export async function* streamAiAssistant(
  body: AiAssistantRequestBody,
  options?: { signal?: AbortSignal },
): AsyncGenerator<AiAssistantChunk> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/ai-assistant`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    yield { type: "error", error: `HTTP ${response.status}: ${response.statusText}` };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let chunk: AiAssistantChunk;
      try {
        chunk = JSON.parse(line.slice(6));
      } catch (error) {
        console.warn("[ai-assistant] skipping malformed SSE line", error);
        continue;
      }
      yield chunk;
      if (chunk.type === "done" || chunk.type === "error") return;
    }
  }
}
