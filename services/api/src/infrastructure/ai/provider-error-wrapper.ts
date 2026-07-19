/**
 * Wrap an arbitrary error thrown during provider execution into a
 * {@link ProviderExecutionError} at the execution boundary.
 *
 * This is Layer 2 of the provider-error-categorization reanimation: it
 * composes the Layer 1 outputs (category + statusCode + message, produced by
 * {@link classifyProviderError}, {@link extractProviderErrorStatusCode}, and
 * {@link extractProviderErrorMessage}) with the caller's providerType into the
 * normalized error class that travels as structured data to the SSE/HTTP emit
 * sites and the global error handler. Both provider executors (streaming and
 * non-streaming) call this so the assembly logic lives in exactly one place.
 *
 * Extracted from the two executors' catch blocks so the boundary contract is
 * testable directly — without mocking the `ai` package (which is process-global
 * under bun:test and would leak into every other test file in the run).
 *
 * See `vibe_tavern_plan/reports/provider-error-categorization-reanimation.md`.
 */

import { normalizeProviderType } from "@vibe-tavern/domain";
import { ProviderExecutionError } from "./provider-execution-types.js";
import { classifyProviderError, extractProviderErrorStatusCode } from "./provider-error-classifier.js";
import { extractProviderErrorMessage } from "./provider-error-message.js";

/**
 * Normalize an error raised inside a provider executor into a
 * {@link ProviderExecutionError}, preserving the original as `cause`.
 *
 * Does NOT handle the abort short-circuit — callers check `input.signal?.aborted`
 * (and, for streaming, the `vercel.ai.error` NoOutputGenerated case) before
 * calling this, so those paths never reach here.
 */
export function wrapProviderExecutionError(
  error: unknown,
  providerPreset: string,
): ProviderExecutionError {
  return new ProviderExecutionError(
    extractProviderErrorMessage(error),
    classifyProviderError(error),
    normalizeProviderType(providerPreset),
    { statusCode: extractProviderErrorStatusCode(error), cause: error },
  );
}
