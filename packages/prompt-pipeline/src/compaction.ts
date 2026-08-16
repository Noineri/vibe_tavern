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
 * **Must be set at startup** via {@link setTokenCountFn} before any prompt
 * assembly occurs. The server entry points call
 * `setTokenCountFn(countTokens)` during bootstrap.
 *
 * There is no default — if unset, estimateTokens always returns 0.
 */
let tokenCountFn: ((text: string, model?: string) => number) | null = null;

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
  if (!text) return 0;
  if (!tokenCountFn) {
    console.warn("[prompt-pipeline] estimateTokens called before setTokenCountFn — returning 0. Ensure the server calls setTokenCountFn(countTokens) during startup.");
    return 0;
  }
  return tokenCountFn(text, currentModel);
}

/**
 * Calculates the total token footprint of an array of messages.
 */
export function estimateMessageArrayTokens(messages: Array<{ content: string }>): number {
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
 * It equally refuses to start the preserved block with an assistant message
 * that carries tool calls: providers that require a user turn before a
 * function-call turn (Gemini via OpenAI-compat bridges, Anthropic) reject such
 * a history outright, because the user request that triggered the calls was
 * cut away by the boundary. Plain assistant text heads stay allowed — they are
 * valid for every provider VT ships.
 *
 * @param messages The full array of chat messages.
 * @param preserveCount The minimum number of recent messages to preserve.
 * @returns The index of the first message to be preserved (everything before it can be summarized).
 */
/**
 * Duck-typed tool-call detector for the boundary walk: callers pass role-tagged
 * messages whose assistant entries may carry `toolCalls` (copilot history) or
 * `tool_calls` (OpenAI-shaped) — either spelling marks the message as a
 * function-call carrier. Role-generic histories without these fields are
 * unaffected.
 */
function carriesToolCalls(message: { role: string }): boolean {
  const candidate = message as { toolCalls?: unknown; tool_calls?: unknown };
  const calls = candidate.toolCalls ?? candidate.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

export interface HistoryCompactionPlan<T> {
  messages: T[];
  fullHistoryTokens: number;
  preservedHistoryTokens: number;
  totalBeforeCompaction: number;
  responseReserve: number;
}

/**
 * Plans the largest safe suffix of history that fits the complete prompt
 * budget. The supplied counter must measure the exact history representation
 * the caller will send, including role labels and separators.
 *
 * Returns `null` when no history needs dropping. When even the required two
 * most-recent messages do not fit, it preserves them anyway; callers can then
 * surface truthful accounting instead of splitting a conversational pair.
 */
export function planHistoryCompaction<T extends { role: string }>(input: {
  messages: ReadonlyArray<T>;
  nonHistoryTokens: number;
  contextBudget: number | null | undefined;
  responseReserve?: number;
  countHistoryTokens: (messages: ReadonlyArray<T>) => number;
  minPreservedMessages?: number;
}): HistoryCompactionPlan<T> | null {
  const { messages, nonHistoryTokens, contextBudget, countHistoryTokens } = input;
  const responseReserve = Math.max(0, input.responseReserve ?? 0);
  const minPreservedMessages = Math.max(1, input.minPreservedMessages ?? 2);

  if (typeof contextBudget !== "number" || contextBudget <= 0 || messages.length <= minPreservedMessages) {
    return null;
  }

  const fullHistoryTokens = countHistoryTokens(messages);
  const totalBeforeCompaction = nonHistoryTokens + fullHistoryTokens;
  if (totalBeforeCompaction + responseReserve <= contextBudget) {
    return null;
  }

  const historyBudget = Math.max(0, contextBudget - nonHistoryTokens - responseReserve);
  let keepCount = minPreservedMessages;
  for (let candidateCount = minPreservedMessages + 1; candidateCount <= messages.length; candidateCount++) {
    const candidate = messages.slice(messages.length - candidateCount);
    if (countHistoryTokens(candidate) > historyBudget) break;
    keepCount = candidateCount;
  }

  const keepFrom = findSafeCompactionBoundary(messages, keepCount);
  if (keepFrom <= 0) {
    return null;
  }

  const preservedMessages = messages.slice(keepFrom);
  return {
    messages: preservedMessages,
    fullHistoryTokens,
    preservedHistoryTokens: countHistoryTokens(preservedMessages),
    totalBeforeCompaction,
    responseReserve,
  };
}

export function findSafeCompactionBoundary(
  messages: ReadonlyArray<{ role: string }>,
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

    // An assistant head carrying tool calls is an unsafe boundary for
    // functionCall-after-user providers (see doc comment) — step back so the
    // triggering user message (or whatever precedes the call run) survives.
    if (firstPreserved.role === "assistant" && carriesToolCalls(firstPreserved)) {
      keepFrom -= 1;
      continue;
    }

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
      // Re-loop (no break): the newly exposed head is now that assistant — if
      // IT carries tool calls, the functionCall-after-user rule walks further back.
      keepFrom -= 1;
    } else {
      // The preceding message is NOT an assistant (this is a technically orphaned tool result).
      // We keep walking back to try and find the assistant message.
      keepFrom -= 1;
    }
  }

  return keepFrom;
}
