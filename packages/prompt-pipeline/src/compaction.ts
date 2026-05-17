import type { Message } from "@rp-platform/domain";

export interface CompactionConfig {
  preserveRecentMessages: number;
  maxEstimatedTokens: number;
}

/**
 * Injectable token-counting function.
 *
 * Accepts text and an optional model name so the runtime can pick
 * a model-specific tokenizer (e.g. tiktoken for OpenAI, web-tokenizers
 * for Claude/Llama, etc).
 *
 * Default heuristic: `ceil(charLength / 4)` — a rough approximation.
 * Replace at runtime with a real tokenizer via {@link setTokenCountFn}.
 */
let tokenCountFn: (text: string, model?: string) => number = (text: string) => {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
};

/** Current model hint passed to the token-counting function. */
let currentModel: string | undefined;

/**
 * Replace the token counting function with a real tokenizer.
 *
 * The function receives the text to count and an optional model name
 * so it can select the appropriate tokenizer.
 */
export function setTokenCountFn(fn: (text: string, model?: string) => number): void {
  tokenCountFn = fn;
}

/**
 * Set the model hint used by {@link estimateTokens}.
 * Called once per prompt assembly to ensure consistent token counts.
 */
export function setModelHint(model: string | undefined): void {
  currentModel = model;
}

/**
 * Counts tokens using the injected tokenizer (or char-length heuristic as fallback).
 *
 * Automatically passes the model hint set via {@link setModelHint}.
 */
export function estimateTokens(text: string): number {
  return tokenCountFn(text, currentModel);
}

/**
 * Calculates the total token footprint of an array of messages.
 */
export function estimateMessageArrayTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => total + estimateTokens(msg.content), 0);
}

/**
 * Determines the safest index at which to split the message array for compaction.
 * Based on the claw-code boundary safety algorithm.
 *
 * It ensures that we DO NOT split a tool-call and its corresponding tool-result.
 * In the OpenAI API (and most others), a "tool" role message must be immediately
 * preceded by an "assistant" message containing the tool calls.
 *
 * @param messages The full array of chat messages.
 * @param preserveCount The minimum number of recent messages to preserve.
 * @returns The index of the first message to be preserved (everything before it can be summarized).
 */
export function findSafeCompactionBoundary(
  messages: Message[],
  preserveCount: number
): number {
  const totalLength = messages.length;

  if (totalLength <= preserveCount) {
    return 0; // Not enough messages to compact
  }

  let rawKeepFrom = totalLength - preserveCount;
  let keepFrom = rawKeepFrom;

  // Boundary Safety Loop
  // We walk backwards if the proposed cut-off point breaks an assistant/tool relationship.
  while (keepFrom > 0) {
    const firstPreserved = messages[keepFrom];

    // If the first preserved message is NOT a tool result, the boundary is safe.
    if (firstPreserved.role !== "tool") {
      break;
    }

    // The first preserved message IS a tool result.
    // We must check the message immediately preceding it.
    const preceding = messages[keepFrom - 1];

    if (preceding.role === "assistant") {
      // The preceding message is the assistant that made the tool call.
      // We must include it in the preserved block, so we move the boundary back by 1.
      keepFrom -= 1;
      break;
    } else {
      // The preceding message is NOT an assistant (this is a technically orphaned tool result).
      // We keep walking back to try and find the assistant message.
      keepFrom -= 1;
    }
  }

  return keepFrom;
}
