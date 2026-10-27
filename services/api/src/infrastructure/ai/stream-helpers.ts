/**
 * Helpers extracted from stream-provider-executor for testability.
 *
 * These operate on AI SDK result types and fullStream parts without
 * depending on the full executor pipeline.
 */

import { logSendDebug } from "../../shared/send-debug-log.js";
import { extractProviderErrorMessage } from "./provider-error-message.js";
import { providerError } from "../../shared/errors.js";
import { NoOutputGeneratedError, type FinishReason, type TextStreamPart, type ToolSet } from "ai";
import { isRecord, type ProviderResponseTrace } from "@vibe-tavern/domain";
import type { GenerationUsage, ProviderStreamChunk, ProviderStreamFinish } from "./provider-execution-types.js";
import { serializeProviderResponseStep, toTraceJsonValue } from "./provider-response-trace.js";

// ─── createMappedStream ──────────────────────────────────────────────────

/**
 * Map the AI SDK fullStream into our ProviderStreamChunk iterable while
 * retaining per-step provider response traces.
 */
export function createMappedStream<TOOLS extends ToolSet>(
  fullStream: AsyncIterable<TextStreamPart<TOOLS>>,
): {
  stream: AsyncGenerator<ProviderStreamChunk>;
  state: {
    providerResponse: ProviderResponseTrace;
  };
} {
  const state = {
    providerResponse: { mode: "stream", steps: [] } as ProviderResponseTrace,
  };
  let currentStepIndex = -1;

  const ensureCurrentStep = (): number => {
    if (currentStepIndex >= 0) return currentStepIndex;
    state.providerResponse.steps.push({ rawChunks: [] });
    currentStepIndex = state.providerResponse.steps.length - 1;
    return currentStepIndex;
  };

  async function* walk(): AsyncGenerator<ProviderStreamChunk> {
    let chunkCount = 0;
    let reasoningCount = 0;
    const partTypes = new Set<string>();

    for await (const part of fullStream) {
      chunkCount++;
      partTypes.add(part.type);

      if (part.type === "error") {
        const errMsg = extractProviderErrorMessage(part.error);
        logSendDebug("reasoning.stream-error", { chunkCount, error: errMsg, partTypes: [...partTypes].sort() });
        throw providerError(errMsg);
      }
      if (part.type === "finish" && part.finishReason === "interrupted") {
        throw providerError("Provider response stream ended before completion");
      }

      if (part.type === "start-step") {
        state.providerResponse.steps.push({ rawChunks: [] });
        currentStepIndex = state.providerResponse.steps.length - 1;
        continue;
      }
      if (part.type === "raw") {
        state.providerResponse.steps[ensureCurrentStep()]?.rawChunks?.push(toTraceJsonValue(part.rawValue));
        continue;
      }
      if (part.type === "finish-step") {
        const index = ensureCurrentStep();
        const rawChunks = state.providerResponse.steps[index]?.rawChunks ?? [];
        state.providerResponse.steps[index] = serializeProviderResponseStep(
          {
            response: part.response,
            usage: part.usage,
            finishReason: part.finishReason,
            rawFinishReason: part.rawFinishReason,
            providerMetadata: part.providerMetadata,
          },
          rawChunks,
        );
        currentStepIndex = -1;
        continue;
      }

      if (part.type === "tool-call") {
        const args = isRecord(part.input) ? part.input : {};
        yield {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args,
          // Gemini replay requires thoughtSignature carried in provider metadata.
          ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
        };
        continue;
      }
      if (part.type === "tool-input-start") {
        yield { type: "tool-input-start", toolCallId: part.id, toolName: part.toolName };
        continue;
      }
      if (part.type === "tool-input-delta") {
        yield { type: "tool-input-delta", toolCallId: part.id, inputTextDelta: part.delta };
        continue;
      }
      if (part.type === "tool-result") {
        yield {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
        };
        continue;
      }
      if (part.type === "tool-error") {
        yield {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { error: part.error instanceof Error ? part.error.message : String(part.error ?? "tool error") },
          isError: true,
        };
        continue;
      }
      if (part.type === "text-delta") {
        yield { type: "text-delta", delta: part.text };
        continue;
      }
      if (part.type === "reasoning-delta") {
        reasoningCount++;
        yield { type: "reasoning-delta", textDelta: part.text };
      }
    }

    logSendDebug("reasoning.stream-complete", {
      totalChunks: chunkCount,
      reasoningChunks: reasoningCount,
      partTypes: [...partTypes].sort(),
    });
  }

  return { stream: walk(), state };
}

// ─── mapFinish ───────────────────────────────────────────────────────────

/**
 * Map the Vercel AI SDK result into our ProviderStreamFinish promise.
 */
export function mapFinish(
  result: { finishReason: PromiseLike<FinishReason>; usage: PromiseLike<GenerationUsage | undefined> },
  signal?: AbortSignal,
): Promise<ProviderStreamFinish> {
  return Promise.all([result.finishReason, result.usage]).then(([reason, usageRecord]) => {
    const finishReason = reason === "interrupted" || reason === "other" ? "error" : reason;

    return {
      finishReason,
      usage: usageRecord ? {
        inputTokens: usageRecord.inputTokens,
        outputTokens: usageRecord.outputTokens,
        totalTokens: usageRecord.totalTokens,
      } : undefined,
    };
  }).catch((error) => {
    if (signal?.aborted) return { finishReason: "cancelled" };
    logSendDebug("stream.finish-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return { finishReason: "error" };
  });
}

// ─── Safe promise wrappers ───────────────────────────────────────────────

export function safeStreamTextPromise(promise: PromiseLike<string>, signal?: AbortSignal): Promise<string> {
  return Promise.resolve(promise).catch((error) => {
    if (signal?.aborted || NoOutputGeneratedError.isInstance(error)) return "";
    logSendDebug("stream.text-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return "";
  });
}

export function safeReasoningPromise(promise: PromiseLike<string | undefined>, signal?: AbortSignal): Promise<string | undefined> {
  return Promise.resolve(promise).catch((error) => {
    if (signal?.aborted || NoOutputGeneratedError.isInstance(error)) return undefined;
    logSendDebug("stream.reasoning-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
}
