/**
 * CPF-2b — Continue prefill fallback: the fallback attempts + stream-drain
 * types, extracted from `live-chat-orchestrator.ts` (file-size ratchet).
 *
 * Backends that refuse a trailing-assistant (prefill) message (Gemini via
 * aggregators, Google native generateContent) reject every prefill-mode
 * Continue attempt. This module carries the ALTERNATIVE request shape and the
 * stitching for the two Continue seams:
 *
 *  - the target message STAYS in history — the prompt is assembled WITHOUT
 *    `excludeMessageId`, but still traced (`setPendingTrace`, so the variant
 *    keeps its model/preset attribution and the saved trace describes the
 *    request that actually rode on the wire);
 *  - the executor request carries `continuationFallback: true` (no prefill —
 *    `prepareSdkMessages` appends the trailing user instruction and throws on
 *    a combined prefill);
 *  - the reply is stitched onto the original variant text with
 *    `mergeContinuation` (overlap-trimmed) — NOT `ensurePrefillInResponse`,
 *    which is the prefill path's echo seam.
 *
 * The orchestrator owns mode selection (rejection memory), the retry-once
 * decision, and the prefill attempt; the functions here run once that
 * decision is made, parameterized by STRUCTURAL slices of the orchestrator's
 * seams (this module must not import api/ or runtime/ — the architecture gate
 * allows those edges only in the grandfathered orchestrator file, so the
 * runtime/prompt/variant types are declared structurally and inferred at the
 * orchestrator's call sites).
 */

import { brandId, effectiveContextBudget, normalizeProviderType } from "@vibe-tavern/domain";
import type { AssemblePromptResponse, ChatId, CoauthorTransport, MessageId, PromptPresetId, ProviderResponseTrace, StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ToolSet } from "ai";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ExtractedToolCall, ExtractedToolResult, GenerationResult, ProviderStreamResult } from "../../infrastructure/ai/provider-execution-types.js";
import { detectPrefillRejection } from "../../infrastructure/ai/prefill-rejection-detector.js";
import { mergeContinuation } from "../../infrastructure/ai/merge-continuation.js";
import { extractThinkingTags } from "../../infrastructure/ai/extract-thinking-tags.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { resolveProtocol } from "../providers/protocol-registry.js";

// ─── Shared structural types ────────────────────────────────────────────────

/** What the stream drain needs from a finalized turn: the wire snapshot's
 *  message list (finish event) + the lorebook overflow-alert channel (P21). */
export type DrainFinalSnapshot = {
  messages: unknown[];
  lorebookOverflows?: Array<{ name: string; dropped: number }>;
};

/** Input of the orchestrator's stream-start helper. Exported here (not in the
 *  orchestrator) so this module can type the fallback's stream seams without
 *  importing api/runtime types. */
export interface StreamStartInput {
  chatId: string;
  profile: StoredProviderProfileRecord;
  model: string;
  transport?: CoauthorTransport;
  signal?: AbortSignal;
  prefill?: string;
  /** CPF-2b: ride the request as a user-role continuation instead of a
   *  prefill (mutually exclusive — `prepareSdkMessages` throws on both;
   *  when set, the prompt-cascade prefill is suppressed too). */
  continuationFallback?: boolean;
  tools?: ToolSet;
  maxSteps?: number;
  visionAssets?: { cachedModels: CachedModelEntry[]; visionModel: string | null; assetLoader: (assetId: string) => Promise<Buffer | null>; visionDescribePrompt?: string };
  /** STT_PLAN ST-6: profile-bound transcriber for voice-note attachments. */
  voiceTranscriber?: import("../../infrastructure/ai/provider-execution-types.js").ProviderExecutionInput["voiceTranscriber"];
  onAttachmentDescriptions?: import("../../infrastructure/ai/provider-execution-types.js").ProviderExecutionInput["onAttachmentDescriptions"];
}

/** Input of the orchestrator's stream-drain helper (generic over what
 *  `onFinal` returns — every seam returns its own snapshot intersection). */
export interface DrainStreamInput<TFinal extends DrainFinalSnapshot> {
  chatId: string;
  streamResult: ProviderStreamResult;
  signal?: AbortSignal | undefined;
  startedAt: number;
  debugLabel: string;
  omitMessageCountInFinish?: boolean;
  prefill?: string;
  onAbort: (text: string, reasoning: string, reasoningDurationMs: number | undefined, latencyMs: number) => Promise<void>;
  /** P21: the final return carries the wire snapshot PLUS the lorebook
   *  overflow-alert channel (alert-on books that overflowed this turn) —
   *  drainStream forwards it on the `finish` SSE event so the client can
   *  toast without a refetch. */
  onFinal: (text: string, reasoning: string | undefined, reasoningDurationMs: number | undefined, latencyMs: number, toolCalls?: ExtractedToolCall[], toolResults?: ExtractedToolResult[]) => Promise<TFinal>;
}

/** Cached-model entry shape the stream-start vision assets use (structural —
 *  mirrors the executor type without importing it as a value). */
interface CachedModelEntry {
  modelSlug: string;
  capabilities?: { vision?: boolean };
}

/** Prompt shape returned by the runtime's preview assembly (structural slice
 *  of the ChatRuntime method's return type). */
export interface ContinueFallbackPrompt extends AssemblePromptResponse {
  tools?: ToolSet;
  maxSteps?: number;
  coauthorModuleId?: string;
  coauthorSkillId?: string | null;
}

/** Variant-append result slice the fallback stitching needs (the concrete
 *  snapshot type is inferred from the real ChatRuntime at the call site). */
export type FallbackVariantSnapshot = {
  messages: unknown[];
  overflowAlerts?: Array<{ name: string; dropped: number }>;
};

/** Structural slice of ChatRuntime the fallback attempts run on. */
export interface ContinueFallbackRuntime<TSnapshot extends FallbackVariantSnapshot> {
  assemblePromptPreview(chatId: ChatId, options: { excludeMessageId?: MessageId; model: string; contextBudget?: number | null; responseReserve?: number; presetId?: PromptPresetId; setPendingTrace?: boolean }): Promise<ContinueFallbackPrompt>;
  patchPendingTrace(chatId: ChatId, patch: { sentConfig?: AssemblePromptResponse["sentConfig"]; providerResponse?: ProviderResponseTrace; prefill?: string | null }): void;
  discardPendingPromptTrace(chatId: ChatId): void;
  appendMessageVariant(chatId: ChatId, messageId: MessageId, input: { content: string; latencyMs: number; reasoning?: string; reasoningDurationMs?: number; toolCalls?: ExtractedToolCall[]; toolResults?: ExtractedToolResult[] }): Promise<TSnapshot>;
}

/** The Continue-seam input slice the fallback attempts consume. */
export interface ContinueFallbackAttemptInput {
  chatId: string;
  messageId: string;
  /** The selected variant's text — the continuation start + stitch base. */
  continuationText: string;
  transport?: CoauthorTransport;
  signal?: AbortSignal;
}

// ─── Rejection memory ────────────────────────────────────────────────────────

/** CPF-2b in-memory rejection memory (server-session lifetime): which
 *  `profileId:model` pairs rejected a trailing-assistant prefill. A hit
 *  sends the Continue fallback DIRECTLY — the doomed prefill attempt is
 *  skipped entirely. Aggregator profiles vary per model, so the pair (not
 *  the profile alone) is the unit. */
export class ContinueFallbackMemory {
  private readonly rejected = new Map<string, true>();

  static key(profile: { id: string }, model: string): string {
    return `${profile.id}:${model}`;
  }

  has(key: string): boolean {
    return this.rejected.has(key);
  }

  record(key: string): void {
    this.rejected.set(key, true);
  }
}

// ─── Prefill capability policy (LS-4) ───────────────────────────────

/** LS-4: drop a prefill candidate on protocols without the prefill
 *  capability. Without this gate a capability-less provider's prefill would
 *  never reach the model (prepareSdkMessages refuses the push), yet
 *  `ensurePrefillInResponse` would still PREPEND it to the stored reply —
 *  silently corrupting the variant with text the model never wrote. */
export function resolveEffectivePrefill(profile: StoredProviderProfileRecord, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  if (!resolveProtocol(normalizeProviderType(profile.providerPreset)).capabilities.prefill) return undefined;
  return candidate;
}

/** CPF-3 — prefill-capability predicate (replaces the LS-4a throwing gate):
 *  `prefill: false` protocols (google, anthropic, …) enter the Continue
 *  fallback DIRECTLY instead of hard-refusing — the user pressed
 *  "continue" by hand, so a user-role continuation is always attempted. */
export function protocolSupportsPrefill(profile: StoredProviderProfileRecord): boolean {
  return resolveProtocol(normalizeProviderType(profile.providerPreset)).capabilities.prefill;
}

/** CPF-3 — why a Continue ran in fallback mode: a rejection-memory hit
 *  skips the doomed prefill, a clean rejection retries once, and a
 *  `prefill: false` protocol enters directly (owner: the user pressed
 *  "continue" by hand — no hard refusal). Rides the `logSendDebug` entry
 *  lines of both attempt functions. */
export type ContinueFallbackReason = "memory-hit" | "rejection-retry" | "capability";

/** CPF-3 — Continue entry selection (the mode funnel BOTH continue seams
 *  share): `prefill: false` protocols enter the fallback DIRECTLY
 *  ("capability" — the user pressed "continue" by hand, so no hard refusal);
 *  otherwise a rejection-memory hit skips the doomed prefill ("memory-hit");
 *  otherwise the prefill attempt runs (`null`). Capability is checked FIRST —
 *  it takes precedence over memory. */
export function selectContinueEntry(profile: StoredProviderProfileRecord, memoryHas: boolean): ContinueFallbackReason | null {
  if (!protocolSupportsPrefill(profile)) return "capability";
  if (memoryHas) return "memory-hit";
  return null;
}

// ─── Shared non-streaming continue tail ─────────────────────────────

/** The post-executor tail BOTH continue non-streaming paths share (prefill
 *  and fallback): thinking-tag extraction, RX-8/RX-10 regex seams, latency
 *  measurement, variant append, and the return shape. */
export async function appendContinueVariant<TSnapshot extends FallbackVariantSnapshot>(
  deps: {
    chatRuntime: ContinueFallbackRuntime<TSnapshot>;
    applyRegexLayer: (hook: "AI_OUTPUT" | "REASONING", chatId: string, text: string) => Promise<string>;
  },
  input: ContinueFallbackAttemptInput,
  prompt: ContinueFallbackPrompt,
  rawReply: string,
  reasoning: string | undefined,
  startedAt: number,
): Promise<{
  promptMessageCount: number;
  reply: string;
  snapshot: TSnapshot;
}> {
  // Extract thinking tags from content (some models embed <thinking> in text)
  const { mainContent: contText, reasoning: contReasoning } = extractThinkingTags(rawReply, reasoning);
  let reply = contText;
  let finalReasoning = contReasoning;
  // RX-10 regex seam: REASONING transform (persist-mode presets, reasoning only; guarded so undefined/empty never fires the hook).
  if (finalReasoning) finalReasoning = await deps.applyRegexLayer("REASONING", input.chatId, finalReasoning);

  const latencyMs = Date.now() - startedAt;
  logSendDebug("live.continue.provider.done", { chatId: input.chatId, latencyMs, replyLength: reply.length });
  // RX-8 regex seam: AI_OUTPUT transform (persist-mode presets, main content only). The variant is created already-transformed.
  reply = await deps.applyRegexLayer("AI_OUTPUT", input.chatId, reply);
  const snapshot = await deps.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
    content: reply,
    latencyMs,
    reasoning: finalReasoning,
  });
  logSendDebug("live.continue.append.done", { chatId: input.chatId, messageId: input.messageId, messageCount: snapshot.messages.length });

  return {
    promptMessageCount: countPromptMessages(prompt),
    reply,
    snapshot,
  };
}

// ─── Fallback attempts ───────────────────────────────────────────────────────

/** Non-streaming fallback attempt — see the module doc for the request shape. */
export async function runContinueFallback<TSnapshot extends FallbackVariantSnapshot>(
  deps: {
    chatRuntime: ContinueFallbackRuntime<TSnapshot>;
    executeNonstreaming: typeof nonstreamingProviderExecute;
    applyRegexLayer: (hook: "AI_OUTPUT" | "REASONING", chatId: string, text: string) => Promise<string>;
    withTokenContext: <T>(provider: { profile: StoredProviderProfileRecord; model: string }, fn: () => Promise<T>) => Promise<T>;
  },
  input: ContinueFallbackAttemptInput,
  provider: { profile: StoredProviderProfileRecord; model: string },
  reason: ContinueFallbackReason,
): Promise<{
  promptMessageCount: number;
  reply: string;
  snapshot: TSnapshot;
}> {
  logSendDebug("live.continue.fallback.entry", { chatId: input.chatId, messageId: input.messageId, model: provider.model, reason });
  const prompt = await deps.withTokenContext(provider, () =>
    deps.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      model: provider.model,
      contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
      responseReserve: provider.profile.maxTokens,
      setPendingTrace: true,
    }),
  );
  const startedAt = Date.now();
  let result: GenerationResult;
  try {
    result = await deps.executeNonstreaming({
      profile: provider.profile,
      model: provider.model,
      transport: input.transport,
      prompt,
      signal: input.signal,
      continuationFallback: true,
      tools: prompt.tools,
      maxSteps: prompt.maxSteps,
    });
  } catch (err) {
    deps.chatRuntime.discardPendingPromptTrace(brandId<ChatId>(input.chatId));
    throw err;
  }
  // Trace honesty: the pending trace describes THIS request — the fallback's
  // wire data, and NO prefill rode (null clears a preset prefill the draft
  // may carry; patchPendingTrace ignores `undefined`).
  deps.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
    ...(result.sentConfig ? { sentConfig: result.sentConfig } : {}),
    providerResponse: result.providerResponse,
    prefill: null,
  });
  // Stitching seam: overlap-trimmed merge replaces the prefill echo seam.
  const merged = mergeContinuation(input.continuationText, result.text);
  logSendDebug("live.continue.fallback.stitch", { chatId: input.chatId, messageId: input.messageId, overlapLength: merged.overlapLength });
  // The merge runs BEFORE thinking-tag extraction, mirroring the prefill
  // path (ensurePrefillInResponse also runs before extraction).
  return await appendContinueVariant(deps, input, prompt, merged.content, result.reasoning, startedAt);
}

/** Streaming fallback attempt — see the module doc for the request shape.
 *  Deltas stream the RAW continuation (the same echo asymmetry the prefill
 *  mode shows); the FINAL text is stitched with `mergeContinuation` inside
 *  the `onFinal` closure, before the variant append. */
export async function* runContinueFallbackStream<TSnapshot extends FallbackVariantSnapshot>(
  deps: {
    chatRuntime: ContinueFallbackRuntime<TSnapshot>;
    startStream: (input: StreamStartInput, prompt: AssemblePromptResponse) => Promise<{ streamResult: ProviderStreamResult; startedAt: number }>;
    drainStream: <TFinal extends DrainFinalSnapshot>(input: DrainStreamInput<TFinal>) => AsyncGenerator<{ event: string; data: string }>;
    withTokenContext: <T>(provider: { profile: StoredProviderProfileRecord; model: string }, fn: () => Promise<T>) => Promise<T>;
  },
  input: ContinueFallbackAttemptInput,
  provider: { profile: StoredProviderProfileRecord; model: string },
  reason: ContinueFallbackReason,
): AsyncGenerator<{ event: string; data: string }> {
  logSendDebug("live.continue-stream.fallback.entry", { chatId: input.chatId, messageId: input.messageId, model: provider.model, reason });
  const prompt = await deps.withTokenContext(provider, () =>
    deps.chatRuntime.assemblePromptPreview(brandId<ChatId>(input.chatId), {
      model: provider.model,
      contextBudget: effectiveContextBudget(provider.profile.contextBudget, provider.profile.tokenPadding),
      responseReserve: provider.profile.maxTokens,
      setPendingTrace: true,
    }),
  );
  const { streamResult, startedAt } = await deps.startStream({ ...input, ...provider, continuationFallback: true, tools: prompt.tools, maxSteps: prompt.maxSteps }, prompt);
  // Trace honesty: the pending trace describes THIS request — the fallback's
  // wire data, and NO prefill rode (null clears a preset prefill).
  deps.chatRuntime.patchPendingTrace(brandId<ChatId>(input.chatId), {
    ...(streamResult.sentConfig ? { sentConfig: streamResult.sentConfig } : {}),
    providerResponse: streamResult.providerResponse,
    prefill: null,
  });

  if (prompt.coauthorModuleId) {
    yield {
      event: "coauthor-module",
      data: JSON.stringify({
        moduleId: prompt.coauthorModuleId,
        skillId: prompt.coauthorSkillId,
      }),
    };
  }

  yield* deps.drainStream({
    chatId: input.chatId,
    streamResult,
    signal: input.signal,
    startedAt,
    debugLabel: "live.continue-stream",
    omitMessageCountInFinish: true,
    // No prefill on the fallback path — the drain's echo seam is a no-op
    // (ensurePrefillInResponse returns `text` unchanged for `undefined`).
    prefill: undefined,
    onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
      if (text) {
        await deps.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
          content: text,
          latencyMs,
          reasoning: reasoning || undefined,
          reasoningDurationMs,
        });
      }
    },
    onFinal: async (text, reasoning, reasoningDurationMs, latencyMs, toolCalls, toolResults) => {
      // Stitching seam: overlap-trimmed merge of the RAW final continuation
      // onto the original variant text — BEFORE the variant append.
      const merged = mergeContinuation(input.continuationText, text);
      logSendDebug("live.continue-stream.fallback.stitch", { chatId: input.chatId, messageId: input.messageId, overlapLength: merged.overlapLength });
      const snapshot = await deps.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
        content: merged.content,
        latencyMs,
        reasoning,
        reasoningDurationMs,
        toolCalls,
        toolResults,
      });
      logSendDebug("live.continue-stream.done", { chatId: input.chatId, messageId: input.messageId, latencyMs, overlapLength: merged.overlapLength });
      return { ...snapshot, lorebookOverflows: snapshot.overflowAlerts };
    },
  });
}

// ─── Retry-once detection relay (stream seam) ────────────────────────────────

// ─── Retry-once detection relay (stream seam) ────────────────────────

/** The prefill attempt's stream drain for the Continue seam: drains with the
 *  standard variant-append closures (raw continuation — the same echo
 *  asymmetry the prefill mode always had) while relaying through
 *  {@link relayStreamWithRejectionDetection}: a CLEAN prefill rejection is
 *  swallowed and reported via `onCleanRejection` so the caller can re-issue
 *  as a user-role continuation; everything else forwards byte-identical. */
export async function* drainContinuePrefillWithRetry<TSnapshot extends FallbackVariantSnapshot>(
  deps: {
    chatRuntime: ContinueFallbackRuntime<TSnapshot>;
    drainStream: <TFinal extends DrainFinalSnapshot>(input: DrainStreamInput<TFinal>) => AsyncGenerator<{ event: string; data: string }>;
  },
  input: ContinueFallbackAttemptInput,
  startedAt: number,
  streamResult: ProviderStreamResult,
  prefill: string,
  onCleanRejection: (message: string) => void,
): AsyncGenerator<{ event: string; data: string }> {
  yield* relayStreamWithRejectionDetection(
    deps.drainStream({
      chatId: input.chatId,
      streamResult,
      signal: input.signal,
      startedAt,
      debugLabel: "live.continue-stream",
      omitMessageCountInFinish: true,
      prefill,
      onAbort: async (text, reasoning, reasoningDurationMs, latencyMs) => {
        if (text) {
          await deps.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
            content: text,
            latencyMs,
            reasoning: reasoning || undefined,
            reasoningDurationMs,
          });
        }
      },
      onFinal: async (text, reasoning, reasoningDurationMs, latencyMs, toolCalls, toolResults) => {
        const snapshot = await deps.chatRuntime.appendMessageVariant(brandId<ChatId>(input.chatId), brandId<MessageId>(input.messageId), {
          content: text,
          latencyMs,
          reasoning,
          reasoningDurationMs,
          toolCalls,
          toolResults,
        });
        logSendDebug("live.continue-stream.done", { chatId: input.chatId, messageId: input.messageId, latencyMs });
        return { ...snapshot, lorebookOverflows: snapshot.overflowAlerts };
      },
    }),
    onCleanRejection,
  );
}

/**
 * CPF-2b stream retry detection: forwards drainStream's SSE events, but a
 * CLEAN prefill rejection — the FIRST `error` event with ZERO content events
 * before it (text/reasoning deltas, tool calls or results) whose message
 * matches the detector — is SWALLOWED instead of forwarded (the client saw
 * nothing of the rejected attempt) and reported through `onCleanRejection`
 * so the caller can re-issue as a user-role continuation.
 *
 * Why an event relay and not a try/catch around startStream: `streamText` is
 * lazy — a provider 400 rides the stream as its first part (surfacing inside
 * the drain loop as an `error` event), not as a throw from the executor
 * call. Zero content events is what makes the retry clean.
 */
export async function* relayStreamWithRejectionDetection(
  events: AsyncGenerator<{ event: string; data: string }>,
  onCleanRejection: (message: string) => void,
): AsyncGenerator<{ event: string; data: string }> {
  let sawContent = false;
  for await (const event of events) {
    if (event.event === "error" && !sawContent) {
      const message = readStreamErrorMessage(event.data);
      if (message !== undefined && detectPrefillRejection({ message })) {
        onCleanRejection(message);
        return; // swallow the error event — no SSE byte of the rejected attempt reaches the client
      }
    }
    if (event.event === "text-delta" || event.event === "reasoning-delta" || event.event === "tool-call" || event.event === "tool-result") {
      sawContent = true;
    }
    yield event;
  }
}

/** CPF-2b: the SSE `error` event's JSON payload → its message field. On the
 *  stream path the wire status is already lost by the time drainStream emits
 *  the event (the executor's error is flattened to a message), so the message
 *  pattern is the detector's only signal there. */
function readStreamErrorMessage(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

/** Extracts the message count from a prompt's finalPayload. Declared here
 *  (not in the orchestrator) so both modules share one derivation without a
 *  runtime import cycle: the orchestrator imports this module, never the
 *  reverse. */
export function countPromptMessages(prompt: { finalPayload?: unknown }): number {
  const payload = prompt.finalPayload as { messages?: unknown };
  return Array.isArray(payload?.messages) ? payload.messages.length : 0;
}
