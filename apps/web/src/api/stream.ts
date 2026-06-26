import { getGatewayBaseUrl, getMobileToken } from "./client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";
import { parseSSEStream } from "../lib/sse-parser.js";
import type { ProviderErrorCategory } from "@vibe-tavern/api-contracts";
import { ProviderStreamError } from "./provider-stream-error.js";
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
async function streamChatEndpoint(
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
    const errorObj = typeof error === "object" ? error : undefined;
    const message =
      errorObj?.message
      || (typeof error === "string" ? error : undefined)
      || `Stream request failed: ${response.status}`;
    const category = typeof errorObj?.details?.category === "string"
      ? (errorObj.details.category as ProviderErrorCategory)
      : "unknown";
    throw new ProviderStreamError(message, category);
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
  /** Optional per-request { model?, promptPresetId? } override (chat generation queue). Undefined → legacy empty body. */
  override?: { model?: string; promptPresetId?: string },
) => streamChatEndpoint(`/api/chats/${chatId}/messages/${messageId}/regenerate/stream`, override ?? {}, opts);

/** Convenience: generate reply stream */
export const generateReplyStream = (
  chatId: string,
  opts: StreamOpts,
) => streamChatEndpoint(`/api/chats/${chatId}/generate-reply/stream`, {}, opts);
