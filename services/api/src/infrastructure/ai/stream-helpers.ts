/**
 * Helpers extracted from stream-provider-executor for testability.
 *
 * These operate on AI SDK result types and fullStream parts without
 * depending on the full executor pipeline.
 */

import { logSendDebug } from "../../shared/send-debug-log.js";
import { extractProviderErrorMessage } from "./provider-error-message.js";
import { cancelled, providerError } from "../../shared/errors.js";
import { REASONING_START_MARKER, REASONING_END_MARKER } from "../../domain/providers/openai-reasoning-fetch.js";
import type { ProviderMetadata } from "ai";
import type { ProviderResponseTrace } from "@vibe-tavern/domain";
import type { ProviderStreamChunk, ProviderStreamFinish } from "./provider-execution-types.js";
import { serializeProviderResponseStep, toTraceJsonValue } from "./provider-response-trace.js";

// ─── createMappedStream ──────────────────────────────────────────────────

/**
 * Map the Vercel AI SDK fullStream into our ProviderStreamChunk iterable.
 *
 * Filters for `text-delta` and `reasoning` parts only.
 * Tracks whether a `redacted-reasoning` part was seen (e.g. Claude extended thinking).
 *
 * Also retains compatibility with the legacy REASONING_START/REASONING_END
 * marker protocol. Current OpenAI-compatible providers flow through AI SDK's
 * native `reasoning_content` / `reasoning` support instead.
 */
export function createMappedStream(
  fullStream: AsyncIterable<unknown>,
): {
  stream: AsyncGenerator<ProviderStreamChunk>;
  state: {
    hasRedacted: boolean;
    providerResponse: ProviderResponseTrace;
  };
} {
  const state = {
    hasRedacted: false,
    providerResponse: { mode: "stream", steps: [] } as ProviderResponseTrace,
  };
  let inReasoning = false;
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
      const p = part as { type: string };
      chunkCount++;
      partTypes.add(p.type);

      // ── Provider error in stream ──
      if (p.type === "error") {
        const pErr = part as { type: string; errorText?: string; error?: unknown };
        const errMsg = pErr.errorText ?? extractProviderErrorMessage(pErr.error);
        logSendDebug("reasoning.stream-error", { chunkCount, error: errMsg, partTypes: [...partTypes].sort() });
        throw providerError(errMsg);
      }

      // ── Raw provider response capture, grouped by AI SDK model step ──
      if (p.type === "start-step") {
        state.providerResponse.steps.push({ rawChunks: [] });
        currentStepIndex = state.providerResponse.steps.length - 1;
        continue;
      }
      if (p.type === "raw") {
        const raw = part as { type: "raw"; rawValue: unknown };
        const step = state.providerResponse.steps[ensureCurrentStep()];
        step?.rawChunks?.push(toTraceJsonValue(raw.rawValue));
        continue;
      }
      if (p.type === "finish-step") {
        const finishedStep = part as {
          type: "finish-step";
          response: {
            id?: string;
            timestamp?: Date | string;
            modelId?: string;
            headers?: Record<string, string>;
            body?: unknown;
          };
          usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
          finishReason?: string;
          rawFinishReason?: string;
          providerMetadata?: ProviderMetadata;
        };
        const index = ensureCurrentStep();
        const rawChunks = state.providerResponse.steps[index]?.rawChunks ?? [];
        state.providerResponse.steps[index] = serializeProviderResponseStep(
          {
            response: finishedStep.response,
            usage: finishedStep.usage,
            finishReason: finishedStep.finishReason,
            rawFinishReason: finishedStep.rawFinishReason,
            providerMetadata: finishedStep.providerMetadata,
          },
          rawChunks,
        );
        currentStepIndex = -1;
        continue;
      }

      // ── Tool calls (informational — AI SDK handles execution) ──
      // fullStream `tool-call` part carries the fully-parsed `input` (the parsed tool args).
      if (p.type === "tool-call") {
        const tc = part as {
          type: string;
          toolCallId?: string;
          toolName?: string;
          input?: unknown;
          providerMetadata?: ProviderMetadata;
        };
        if (tc.toolCallId && tc.toolName) {
          // AI SDK v6 fullStream uses `input` for parsed arguments and
          // `providerMetadata` for replay-critical provider data. ModelMessage
          // expects that same data under `providerOptions`; Gemini 3 stores its
          // thoughtSignature here and rejects/warns when history drops it.
          const args = (typeof tc.input === "object" && tc.input !== null ? tc.input : {}) as Record<string, unknown>;
          yield {
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args,
            ...(tc.providerMetadata ? { providerOptions: tc.providerMetadata } : {}),
          };
          continue;
        }
      }

      // ── Progressive tool-arg streaming (so the UI can render the model writing the document) ──
      // AI SDK emits tool-input-start (with toolName) then a series of tool-input-delta parts
      // (inputTextDelta) as the args JSON streams in, before the final tool-call/tool-result.
      if (p.type === "tool-input-start") {
        const tis = part as { type: string; id?: string; toolCallId?: string; toolName?: string };
        const id = tis.toolCallId ?? tis.id;
        if (id && tis.toolName) {
          yield { type: "tool-input-start", toolCallId: id, toolName: tis.toolName };
          continue;
        }
      }
      if (p.type === "tool-input-delta") {
        const tid = part as { type: string; id?: string; toolCallId?: string; inputTextDelta?: string; delta?: string };
        const id = tid.toolCallId ?? tid.id;
        const delta = tid.inputTextDelta ?? tid.delta;
        if (id && delta) {
          yield { type: "tool-input-delta", toolCallId: id, inputTextDelta: delta };
          continue;
        }
      }

      // ── Tool results (forwarded for SSE, WITH the execute() output payload) ──
      // AI SDK v6 splits failures into a separate `tool-error` part (no `isError` flag on
      // tool-result); we normalize both into a tool-result chunk, setting isError + carrying
      // the error on the error branch and the execute() output on the success branch.
      if (p.type === "tool-result") {
        const tr = part as { type: string; toolCallId?: string; toolName?: string; output?: unknown };
        if (tr.toolCallId) {
          yield { type: "tool-result", toolCallId: tr.toolCallId, toolName: String(tr.toolName ?? ""), output: tr.output };
          continue;
        }
      }
      if (p.type === "tool-error") {
        const te = part as { type: string; toolCallId?: string; toolName?: string; error?: unknown };
        if (te.toolCallId) {
          yield {
            type: "tool-result",
            toolCallId: te.toolCallId,
            toolName: String(te.toolName ?? ""),
            output: te.error instanceof Error ? { error: te.error.message } : { error: String(te.error ?? "tool error") },
            isError: true,
          };
          continue;
        }
      }

      // AI SDK v5/v6 fullStream part fields:
      //   text-delta     → `text` (string)
      //   reasoning-delta → `delta` (string)
      const p2 = part as { type: string; text?: string; delta?: string };

      if (p.type === "text-delta" && p2.text) {
        // ── Marker protocol (OpenAI Chat Completions reasoning) ──
        if (p2.text === REASONING_START_MARKER) {
          inReasoning = true;
          reasoningCount++;
          logSendDebug("reasoning.marker.start", { chunkCount });
          continue;
        }
        if (p2.text === REASONING_END_MARKER) {
          inReasoning = false;
          logSendDebug("reasoning.marker.end", { chunkCount, reasoningCount });
          continue;
        }

        if (inReasoning) {
          reasoningCount++;
          yield { type: "reasoning-delta", textDelta: p2.text };
        } else {
          yield { type: "text-delta", delta: p2.text };
        }
      } else if (p.type === "reasoning-delta") {
        // ── Native reasoning parts (AI SDK v5+: reasoning-start/reasoning-delta/reasoning-end) ──
        // v7 TextStreamReasoningDeltaPart carries the text in `text` (same field as
        // text-delta); older builds used `delta`. A hand-cast hiding the rename made
        // this branch dead in v7 — ALL reasoning was silently dropped, so thinking
        // models looked hung until the SSE idle timeout killed the connection.
        const reasoningText = p2.text ?? p2.delta;
        if (reasoningText) {
          reasoningCount++;
          yield { type: "reasoning-delta", textDelta: reasoningText };
        }
      } else if (p.type === "redacted-reasoning") {
        state.hasRedacted = true;
      }
      // reasoning-start, reasoning-end, text-start, text-end, source, etc. — silently ignored
    }

    logSendDebug("reasoning.stream-complete", {
      totalChunks: chunkCount,
      reasoningChunks: reasoningCount,
      partTypes: [...partTypes].sort(),
      hasRedacted: state.hasRedacted,
    });
  }

  return { stream: walk(), state };
}

// ─── mapFinish ───────────────────────────────────────────────────────────

/**
 * Map the Vercel AI SDK result into our ProviderStreamFinish promise.
 */
export function mapFinish(
  result: { finishReason: PromiseLike<unknown>; usage: PromiseLike<unknown> },
  signal?: AbortSignal,
): Promise<ProviderStreamFinish> {
  return Promise.all([result.finishReason, result.usage]).then(([reason, usage]) => {
    const usageRecord = usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    let finishReason: ProviderStreamFinish["finishReason"] = "stop";
    if (reason === "length") finishReason = "length";
    else if (reason === "content-filter") finishReason = "content-filter";
    else if (reason === "tool-calls") finishReason = "tool-calls";
    else if (reason === "error" || reason === "unknown") finishReason = "error";

    return {
      finishReason,
      usage: usageRecord ? {
        inputTokens: usageRecord.inputTokens,
        outputTokens: usageRecord.outputTokens,
        totalTokens: usageRecord.totalTokens,
      } : undefined,
    };
  }).catch((error) => {
    if (signal?.aborted || isNoOutputGeneratedError(error)) return { finishReason: "cancelled" };
    logSendDebug("stream.finish-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return { finishReason: "error" };
  });
}

// ─── Error classification ────────────────────────────────────────────────

export function isNoOutputGeneratedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AI_NoOutputGeneratedError" || error.name === "NoOutputGeneratedError" || error.message.includes("No output generated");
}

// ─── Safe promise wrappers ───────────────────────────────────────────────

export function safeStreamTextPromise(promise: PromiseLike<string>, signal?: AbortSignal): Promise<string> {
  return Promise.resolve(promise).catch((error: unknown) => {
    if (signal?.aborted || isNoOutputGeneratedError(error)) return "";
    logSendDebug("stream.text-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return "";
  });
}

export function safeReasoningPromise(promise: PromiseLike<string | undefined>, signal?: AbortSignal): Promise<string | undefined> {
  return Promise.resolve(promise).catch((error: unknown) => {
    if (signal?.aborted || isNoOutputGeneratedError(error)) return undefined;
    logSendDebug("stream.reasoning-promise-error", { message: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
}
