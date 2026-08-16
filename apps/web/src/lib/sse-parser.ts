import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { ChatGenerationStatus } from "../api/types.js";
import type { ProviderErrorCategory } from "@vibe-tavern/api-contracts";
import { ProviderStreamError } from "../api/provider-stream-error.js";

export interface ParseSSEStreamOptions {
  response: Response;
  signal?: AbortSignal;
  onStatus: (status: ChatGenerationStatus) => void;
  onChunk: (delta: string) => void;
  onReasoningChunk?: (delta: string) => void;
  onReasoningDone?: (info: { durationMs: number | null; redacted: boolean }) => void;
  /** Co-author tool calls. The backend (drainStream) emits these four wire events; they carry the AI's proposed edits. Optional so RP chat callers are unaffected. */
  onToolCall?: (info: { toolCallId: string; toolName: string; args: unknown }) => void;
  onToolInputStart?: (info: { toolCallId: string; toolName: string }) => void;
  onToolInputDelta?: (info: { toolCallId: string; delta: string }) => void;
  onToolResult?: (info: { toolCallId: string; toolName: string; output: unknown; isError: boolean }) => void;
  onCoauthorModule?: (info: { moduleId: string; skillId?: string }) => void;
}

/**
 * Sentinel thrown from inside the parser's `onEvent` callback to unwind the
 * read loop when the server signals a mid-stream cancel (`event: abort`).
 * eventsource-parser invokes `onEvent` synchronously inside `parser.feed`, so
 * throwing here propagates straight out of `feed` — where the loop catches it
 * and resolves the stream as cancelled (mirroring the pre-library behaviour of
 * returning `{ finishReason: "cancelled" }` without rethrowing).
 */
class AbortSentinel extends Error {}

/**
 * Parse a Server-Sent Events stream from a `fetch` Response, dispatching each
 * event to the relevant callback. SSE frame parsing (buffering partial chunks,
 * splitting on blank lines, decoding `event:` / `data:` fields, joining
 * multi-line `data:`) is delegated to `eventsource-parser`'s spec-compliant
 * `createParser`; this function owns only the connection lifecycle (abort
 * handling) and the chat-specific event dispatch table.
 *
 * Why not `@microsoft/fetch-event-source`: that library owns the `fetch` itself
 * and turns on auto-reconnect by default — both wrong for one-shot chat streams
 * (reconnect would re-POST and generate a duplicate reply; owning fetch would
 * collapse the clean `fetch → response.ok → ProviderStreamError` boundary in
 * `stream.ts`). `eventsource-parser` is a pure frame parser with no connection
 * semantics, so it slots in below the existing structure without reshaping it.
 */
export async function parseSSEStream(opts: ParseSSEStreamOptions): Promise<{
  finishReason: string;
  usage?: Record<string, number>;
  /** The copilot finish event's segmented context metrics (CM-4), when the
   *  server emitted them. RP-chat streams never carry this — it stays undefined. */
  metrics?: unknown;
}> {
  const reader = opts.response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let finishReason = "stop";
  let usage: Record<string, number> | undefined;
  let metrics: unknown;

  // Early exit if already aborted.
  if (opts.signal?.aborted) {
    opts.onStatus("cancelled");
    return { finishReason: "cancelled", usage };
  }

  // When the caller aborts, cancel the reader AND reject the pending read via
  // Promise.race. reader.cancel() alone is unreliable in Bun.
  let abortReject: ((e: Error) => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });

  if (opts.signal) {
    opts.signal.addEventListener(
      "abort",
      () => {
        void reader.cancel();
        abortReject?.(new DOMException("The user aborted a request.", "AbortError"));
      },
      { once: true },
    );
  }

  const parser = createParser({
    onEvent(ev: EventSourceMessage) {
      // Server-relayed cancel (the request abort was bounced back through the
      // orchestrator). Resolve as cancelled without throwing an error.
      if (ev.event === "abort") throw new AbortSentinel();

      const data = ev.data;
      if (!data || data === "[DONE]") return;

      let parsed: { delta?: unknown; finishReason?: string; usage?: Record<string, number> } & Record<string, unknown>;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Malformed payload. On an error event we still surface a typed
        // ProviderStreamError so the UI gets a category; anything else is
        // silently dropped (matches the previous swallow-malformed behaviour).
        if (ev.event === "error") {
          opts.onStatus("failed");
          throw new ProviderStreamError(data || "Provider request failed", "unknown");
        }
        return;
      }

      if (ev.event === "error") {
        opts.onStatus("failed");
        const message =
          typeof parsed.message === "string" && parsed.message.trim()
            ? parsed.message
            : "Provider request failed";
        const category =
          typeof parsed.category === "string"
            ? (parsed.category as ProviderErrorCategory)
            : "unknown";
        // A dice commit conflict rides the same error event with a structured
        // `code` (stale_revision / unresolved_choose) — surface it so the send
        // path can refresh pending + keep the draft instead of erroring out.
        const code = typeof parsed.code === "string" ? parsed.code : undefined;
        throw new ProviderStreamError(message, category, code);
      } else if (ev.event === "reasoning-delta") {
        if (parsed.delta !== undefined && opts.onReasoningChunk) {
          opts.onReasoningChunk(parsed.delta as string);
        }
      } else if (ev.event === "reasoning-done") {
        if (opts.onReasoningDone) {
          opts.onReasoningDone({
            durationMs: (parsed.durationMs as number | null | undefined) ?? null,
            redacted: (parsed.redacted as boolean | undefined) ?? false,
          });
        }
      } else if (ev.event === "tool-call") {
        if (opts.onToolCall) {
          opts.onToolCall({
            toolCallId: parsed.toolCallId as string,
            toolName: parsed.toolName as string,
            args: parsed.args,
          });
        }
      } else if (ev.event === "tool-input-start") {
        if (opts.onToolInputStart) {
          opts.onToolInputStart({
            toolCallId: parsed.toolCallId as string,
            toolName: parsed.toolName as string,
          });
        }
      } else if (ev.event === "tool-input-delta") {
        if (opts.onToolInputDelta && typeof parsed.delta === "string") {
          opts.onToolInputDelta({ toolCallId: parsed.toolCallId as string, delta: parsed.delta });
        }
      } else if (ev.event === "tool-result") {
        if (opts.onToolResult) {
          opts.onToolResult({
            toolCallId: parsed.toolCallId as string,
            toolName: parsed.toolName as string,
            output: parsed.output,
            isError: (parsed.isError as boolean | undefined) ?? false,
          });
        }
      } else if (ev.event === "coauthor-module") {
        if (opts.onCoauthorModule) {
          opts.onCoauthorModule({
            moduleId: parsed.moduleId as string,
            skillId: parsed.skillId as string | undefined,
          });
        }
      } else {
        // Default text-delta (no `event:` field) or any unrecognised event
        // (including `finish`).
        if (parsed.delta !== undefined) opts.onChunk(parsed.delta as string);
        if (parsed.finishReason) finishReason = parsed.finishReason;
        if (parsed.usage) usage = parsed.usage;
        if (parsed.metrics !== undefined) metrics = parsed.metrics;
      }
    },
  });

  while (true) {
    if (opts.signal?.aborted) {
      opts.onStatus("cancelled");
      return { finishReason: "cancelled", usage };
    }
    const { done, value } = (await Promise.race([reader.read(), abortPromise])) as IteratorResult<
      Uint8Array,
      undefined
    >;
    if (done) break;
    try {
      parser.feed(decoder.decode(value, { stream: true }));
    } catch (error) {
      if (error instanceof AbortSentinel) {
        opts.onStatus("cancelled");
        return { finishReason: "cancelled", usage };
      }
      // ProviderStreamError (from the error-event branch) propagates as-is;
      // anything unexpected also escapes — neither is swallowed.
      throw error;
    }
  }

  opts.onStatus("idle");
  return { finishReason, usage, metrics };
}
