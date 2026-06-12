import type { ChatGenerationStatus } from "../api/types.js";

export interface ParseSSEStreamOptions {
  response: Response;
  signal?: AbortSignal;
  onStatus: (status: ChatGenerationStatus) => void;
  onChunk: (delta: string) => void;
  onReasoningChunk?: (delta: string) => void;
  onReasoningDone?: (info: { durationMs: number | null; redacted: boolean }) => void;
}

export async function parseSSEStream(opts: ParseSSEStreamOptions): Promise<{
  finishReason: string;
  usage?: Record<string, number>;
}> {
  const reader = opts.response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason = "stop";
  let usage: Record<string, number> | undefined;
  let currentEvent = "";

  // Early exit if already aborted
  if (opts.signal?.aborted) {
    opts.onStatus("cancelled");
    return { finishReason: "cancelled", usage };
  }

  // When the caller aborts, cancel the reader AND reject the pending read
  // via Promise.race. reader.cancel() alone is unreliable in Bun.
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

  while (true) {
    if (opts.signal?.aborted) {
      opts.onStatus("cancelled");
      return { finishReason: "cancelled", usage };
    }
    const { done, value } = await Promise.race([reader.read(), abortPromise]) as IteratorResult<Uint8Array, undefined>;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      // Track event type
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        continue;
      }

      // Process data lines
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          if (currentEvent === "error") {
            opts.onStatus("failed");
            const message = typeof parsed.message === "string" && parsed.message.trim()
              ? parsed.message
              : "Provider request failed";
            throw new Error(message);
          } else if (currentEvent === "reasoning-delta") {
            if (parsed.delta !== undefined && opts.onReasoningChunk) {
              opts.onReasoningChunk(parsed.delta);
            }
          } else if (currentEvent === "reasoning-done") {
            if (opts.onReasoningDone) {
              opts.onReasoningDone({
                durationMs: parsed.durationMs ?? null,
                redacted: parsed.redacted ?? false,
              });
            }
          } else {
            // text-delta or default
            if (parsed.delta !== undefined) opts.onChunk(parsed.delta);
            if (parsed.finishReason) finishReason = parsed.finishReason;
            if (parsed.usage) usage = parsed.usage;
          }
        } catch (error) {
          if (currentEvent === "error") {
            opts.onStatus("failed");
            throw error instanceof Error ? error : new Error(data || "Provider request failed");
          }
          /* skip malformed */
        }

        currentEvent = "";
        continue;
      }

      // Handle abort event (no data line needed)
      if (line.startsWith("event: abort") || currentEvent === "abort") {
        opts.onStatus("cancelled");
        return { finishReason: "cancelled", usage };
      }

      // Reset event on empty lines (SSE separator)
      if (line.trim() === "") {
        currentEvent = "";
      }
    }
  }

  opts.onStatus("idle");
  return { finishReason, usage };
}
