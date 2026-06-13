import { getGatewayBaseUrl, getMobileToken } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";
import { parseSSEStream } from "../lib/sse-parser.js";
import type { ChatGenerationStatus } from "./types.js";
import type { RpcErrorBody } from "./unwrap.js";
import type { z } from "zod";
import type { attachmentSchema } from "@vibe-tavern/api-contracts";

export interface StreamOpts {
  signal?: AbortSignal;
  onStatus: (status: ChatGenerationStatus) => void;
  onChunk: (delta: string) => void;
  onReasoningChunk?: (delta: string) => void;
  onReasoningDone?: (info: { durationMs: number | null; redacted: boolean }) => void;
}

/**
 * Unified SSE streaming helper for chat endpoints.
 * Replaces the 3 duplicated fetch+parseSSEStream blocks in app-client.ts.
 */
export async function streamChatEndpoint(
  url: string,
  body: unknown,
  opts: StreamOpts,
): Promise<{ finishReason: string; usage?: Record<string, number> }> {
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  opts.onStatus("preparing");

  const response = await fetch(appendTokenQuery(`${baseUrl}${url}`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) {
    opts.onStatus("failed");
    const errBody = await response.json().catch(() => null) as RpcErrorBody | null;
    const error = errBody?.error;
    if (error && typeof error === "object" && error.code === "VISION_NOT_SUPPORTED") {
      throw new Error("VISION_NOT_SUPPORTED");
    }
    const message =
      (typeof error === "object" ? error?.message : undefined)
      || (typeof error === "string" ? error : undefined)
      || `Stream request failed: ${response.status}`;
    throw new Error(message);
  }

  opts.onStatus("streaming");
  return parseSSEStream({
    response,
    signal: opts.signal,
    onStatus: opts.onStatus,
    onChunk: opts.onChunk,
    onReasoningChunk: opts.onReasoningChunk,
    onReasoningDone: opts.onReasoningDone,
  });
}

/** Convenience: send message stream */
export const sendStream = (
  chatId: string,
  input: { content: string; attachments?: z.infer<typeof attachmentSchema>[] },
  opts: StreamOpts,
) => streamChatEndpoint(`/api/chats/${chatId}/messages/stream`, input, opts);

/** Convenience: regenerate message stream */
export const regenerateStream = (
  chatId: string,
  messageId: string,
  opts: StreamOpts,
) => streamChatEndpoint(`/api/chats/${chatId}/messages/${messageId}/regenerate/stream`, {}, opts);

/** Convenience: generate reply stream */
export const generateReplyStream = (
  chatId: string,
  opts: StreamOpts,
) => streamChatEndpoint(`/api/chats/${chatId}/generate-reply/stream`, {}, opts);
