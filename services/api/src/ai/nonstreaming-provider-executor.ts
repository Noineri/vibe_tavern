/**
 * Non-streaming provider executor — convenience wrapper around the streaming executor.
 *
 * Collects the full text from the stream and returns a single GenerationResult.
 * Used by code paths that do not need progressive/chunked delivery.
 */

import type { GenerationResult } from "./provider-execution-types.js";
import { streamProviderExecutor } from "./stream-provider-executor.js";

/**
 * Execute a provider request and return the full collected text.
 *
 * This is a convenience wrapper that awaits the streaming executor's text promise.
 * Cancellation, error handling, and provider-kind resolution all flow through
 * the canonical streaming path in stream-provider-executor.ts.
 */
export async function nonstreamingProviderExecute(
  input: Parameters<typeof streamProviderExecutor>[0],
): Promise<GenerationResult> {
  const streamResult = await streamProviderExecutor(input);
  const text = await streamResult.text;
  const finish = await streamResult.finished;

  return {
    text,
    usage: finish.usage
      ? {
          promptTokens: finish.usage.promptTokens,
          completionTokens: finish.usage.completionTokens,
          totalTokens: finish.usage.totalTokens,
        }
      : undefined,
  };
}
