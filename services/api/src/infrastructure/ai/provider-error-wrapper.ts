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
import { VisionNotSupportedError } from "./vision-gate.js";
import { VoiceTranscribeUnavailableError } from "./stt-gate.js";

/**
 * Normalize an error raised inside a provider executor into a
 * {@link ProviderExecutionError}, preserving the original as `cause` — EXCEPT
 * the typed attachment-gate errors (vision / voice transcribe), which pass
 * through unchanged so their route-level `instanceof` surfacing keeps working.
 *
 * Does NOT handle the abort short-circuit — callers check `input.signal?.aborted`
 * (and, for streaming, the `vercel.ai.error` NoOutputGenerated case) before
 * calling this, so those paths never reach here.
 */
export function wrapProviderExecutionError(
  error: unknown,
  providerPreset: string,
): Error {
  // Typed attachment-gate errors (vision / voice transcribe) already carry
  // their own route-level surfacing (422 `type` body / SSE `type` event,
  // matched by `instanceof` in routes/chat.ts and chat-adapter). Wrapping them
  // here would orphan that contract — the route checks would never fire and
  // a missing vision/STT profile would read as a generic 502 provider
  // failure. Pass them through untouched, like the abort short-circuit.
  if (error instanceof VisionNotSupportedError || error instanceof VoiceTranscribeUnavailableError) {
    return error;
  }
  return new ProviderExecutionError(
    extractProviderErrorMessage(error),
    classifyProviderError(error),
    normalizeProviderType(providerPreset),
    { statusCode: extractProviderErrorStatusCode(error), cause: error },
  );
}
