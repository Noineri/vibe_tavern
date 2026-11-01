import type { CopilotStreamOpts } from "../../../lib/agent-host-registry.js";

export function isAgentRunActiveError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "AGENT_RUN_ACTIVE";
}

/** One ownership gate for every projection callback, including provider mocks
 * that ignore cancellation. A detached reader can never mutate another view. */
export function guardAgentStreamCallbacks(callbacks: CopilotStreamOpts, current: () => boolean): CopilotStreamOpts {
  return {
    ...callbacks,
    onStatus: (value) => { if (current()) callbacks.onStatus(value); },
    onChunk: (value) => { if (current()) callbacks.onChunk(value); },
    onReasoningChunk: (value) => { if (current()) callbacks.onReasoningChunk?.(value); },
    onReasoningDone: (value) => { if (current()) callbacks.onReasoningDone?.(value); },
    onToolCall: (value) => { if (current()) callbacks.onToolCall?.(value); },
    onToolInputStart: (value) => { if (current()) callbacks.onToolInputStart?.(value); },
    onToolInputDelta: (value) => { if (current()) callbacks.onToolInputDelta?.(value); },
    onToolResult: (value) => { if (current()) callbacks.onToolResult?.(value); },
    onGenerationMetadata: (value) => { if (current()) callbacks.onGenerationMetadata?.(value); },
    onEventId: (value) => current() ? callbacks.onEventId?.(value) : false,
  };
}
