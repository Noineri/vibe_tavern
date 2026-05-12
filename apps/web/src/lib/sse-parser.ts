import type { ChatGenerationStatus } from "../app-client.js";

export interface ParseSSEStreamOptions {
  response: Response;
  signal?: AbortSignal;
  onStatus: (status: ChatGenerationStatus) => void;
  onChunk: (delta: string) => void;
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.delta) opts.onChunk(parsed.delta);
          if (parsed.finishReason) finishReason = parsed.finishReason;
          if (parsed.usage) usage = parsed.usage;
        } catch { /* skip malformed */ }
      }
      if (line.startsWith("event: abort")) {
        opts.onStatus("cancelled");
        return { finishReason: "cancelled", usage };
      }
    }
  }

  opts.onStatus("idle");
  return { finishReason, usage };
}
