import type { ChatGenerationStatus } from "../app-client.js";

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

  while (true) {
    const { done, value } = await reader.read();
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

          if (currentEvent === "reasoning-delta") {
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
        } catch { /* skip malformed */ }

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
