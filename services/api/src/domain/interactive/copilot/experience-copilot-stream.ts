/**
 * Experience-Copilot streaming — the core runtime (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 2 / ER-6).
 *
 * Takes a request, loads the thread context via the ER-3 store, fetches the
 * current rules/visual/bound-visuals by `thread.scriptId`, assembles the prompt
 * via ER-5, builds the tools via ER-4, and streams via Vercel AI SDK
 * `streamText()`. The output is an `AsyncGenerator<{ event, data }>` of
 * SSE-shaped chunks that the route emits verbatim through `streamSSE` (same
 * contract as `runtime.sendMessageStream`).
 *
 * SINGLE-MODE: the copilot proposes rules/visual edits + runs tests; it is NOT
 * the multi-mode AI-assistant and NOT a chat-mode. It mirrors the AI-assistant's
 * CORE (standalone `streamText`, direct provider/model resolution) but emits the
 * SAME SSE event vocabulary as the chat stream (`text-delta`, `reasoning-delta`,
 * `tool-call`, `tool-result`, `finish`, `error`) so the frontend's
 * `parseSSEStream` consumes it unchanged. The tool-enabled chunk normalization
 * reuses the proven `createMappedStream` / `mapFinish` from `stream-helpers`
 * (the same helpers the chat executor uses), which already handle reasoning
 * stripping (both the marker protocol and native reasoning parts) AND tool
 * parts in one pass — so `splitReasoningFromText` is not needed separately here.
 */

import { streamText, isStepCount } from "ai";
import type { LanguageModel, ModelMessage, AssistantContent, ToolCallPart, ToolResultPart } from "ai";
import type { ToolSet } from "ai";
import type { ProviderProfile, ScriptRow, ExperienceVisualRow } from "@vibe-tavern/db";
import type {
  ExperienceCopilotStore,
  ExperienceCopilotMessage,
} from "@vibe-tavern/db";
import type { ProviderFetch } from "../../providers/provider-fetch-factory.js";
import { resolveProviderFetchForProfile } from "../../providers/provider-fetch-factory.js";
import { createMappedStream, mapFinish } from "../../../infrastructure/ai/stream-helpers.js";
import type { ProviderStreamChunk } from "../../../infrastructure/ai/provider-execution-types.js";
import { classifyProviderError } from "../../../infrastructure/ai/provider-error-classifier.js";
import { extractProviderErrorMessage } from "../../../infrastructure/ai/provider-error-message.js";
import { logSendDebug } from "../../../shared/send-debug-log.js";
import { notFound } from "../../../shared/errors.js";
import {
  assembleExperienceCopilotPrompt,
  type ExperienceCopilotHistoryMessage,
  type ExperienceCopilotPromptMessage,
  type ExperienceCopilotStep,
  type ExperienceCopilotTestFeedback,
} from "./experience-copilot-prompt.js";
import { buildExperienceCopilotTools } from "./experience-copilot-tools.js";

// ─── Request / response types ────────────────────────────────────────────────

export interface ExperienceCopilotStreamRequest {
  /** The copilot thread id (path param on the route). */
  threadId: string;
  /** User's message text for this turn. */
  content: string;
  /** Provider profile ID to use. */
  providerProfileId: string;
  /** Model name override (optional, uses profile default). */
  model?: string;
  /** The current authoring step (inline 3-step creation flow). Default "rules". */
  step?: ExperienceCopilotStep;
  /** The LIVE rules draft the user is editing (the editor sends the current
   *  unsaved source). Preferred over the last-persisted buffer so the model is
   *  never blind to in-progress edits. */
  rules?: string;
  /** The LIVE visual draft the user is editing (see `rules`). */
  visual?: string;
  /** The latest test/simulate digest the user sent back from the test panel.
   *  Loosely typed on the wire (`Record<string, unknown>`) because the digest
   *  shapes live in the backend domain — ER-7 will lift them into wire
   *  contracts. Cast to {@link ExperienceCopilotTestFeedback} at the assembler. */
  testFeedback?: Record<string, unknown> | null;
}

/** SSE event the route forwards verbatim via `streamSSE`. */
export interface ExperienceCopilotStreamEvent {
  event: string;
  data: string;
}

/** Persisted tool-call row, serialized into `tool_calls_json` on an assistant
 *  message. `providerOptions` are intentionally omitted — they are not needed
 *  for cross-turn history (the SDK re-derives them from the live model). */
interface PersistedToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Persisted tool-result payload, serialized into the `content` of a tool
 *  message row. Carries `toolName` so the round-trip back to a
 *  `ToolResultPart` (which the SDK requires) does not need a side lookup. */
interface PersistedToolResult {
  toolName: string;
  output: unknown;
}

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface ExperienceCopilotStreamDeps {
  /** The ER-3 store (thread + message persistence). */
  readonly store: ExperienceCopilotStore;
  /** Fetch a script by id (rules source). Null when missing. */
  readonly getScript: (scriptId: string) => Promise<ScriptRow | null>;
  /** List the visual ids bound to a script (the bound-visuals set). */
  readonly getBoundVisualIds: (scriptId: string) => Promise<string[]>;
  /** Fetch one visual resource by id. Null when missing. */
  readonly getVisual: (id: string) => Promise<ExperienceVisualRow | null>;
  /** Resolve a raw provider profile by id. */
  readonly getProviderProfile: (id: string) => Promise<ProviderProfile | null>;
  /** Resolve the effective profile (base + per-model overlay). */
  readonly getEffectiveProviderProfile: (id: string, model: string) => Promise<ProviderProfile>;
  /** Resolve a `LanguageModel` from a profile + model name. */
  readonly resolveModel: (
    profile: { providerPreset: string; endpoint: string; apiKey: string | null },
    model: string,
    fetch?: ProviderFetch,
  ) => LanguageModel;
  /** Roots for the reused `read_skill_file` tool. Empty when no skill library
   *  is wired (the tool then rejects reads; the other four tools work). */
  readonly skillRoots?: readonly string[];
  /** Max tool-loop steps for the multi-step loop (mirrors co-author maxSteps).
   *  Default {@link DEFAULT_MAX_STEPS}. */
  readonly maxSteps?: number;
}

/** Max tool-loop steps when none is configured. Mirrors COAUTHOR_MAX_STEPS_DEFAULT. */
const DEFAULT_MAX_STEPS = 20;

// ─── History conversion (store ↔ prompt ↔ SDK) ───────────────────────────────

/** Convert stored copilot messages (ER-3) into the history shape ER-5 expects.
 *  Round-trips the {@link storeHistoryToSdk} serialization: assistant rows carry
 *  parsed `toolCalls`; tool rows carry a reconstructed `ToolResultPart`. */
function storeMessagesToHistory(
  messages: readonly ExperienceCopilotMessage[],
): ExperienceCopilotHistoryMessage[] {
  return messages.map((m): ExperienceCopilotHistoryMessage => {
    if (m.role === "tool") {
      // Reconstruct the ToolResultPart from the stored payload. The store row
      // carries the serialized `{ toolName, output }` wrapper in `content` +
      // `toolCallId`; the SDK ToolResultPart.output is a discriminated union,
      // so the output is wrapped as a text value (the model reads it as text,
      // same as the co-author history round-trip).
      let toolName = "";
      let outputText = m.content;
      try {
        const parsed = JSON.parse(m.content) as PersistedToolResult;
        toolName = parsed.toolName ?? "";
        outputText = JSON.stringify(parsed.output);
      } catch {
        // Invalid JSON — use the raw content as the output text.
      }
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId ?? "",
            toolName,
            output: { type: "text", value: outputText },
          },
        ],
      };
    }
    const msg: ExperienceCopilotHistoryMessage = {
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    };
    if (m.toolCallsJson) {
      try {
        const parsed = JSON.parse(m.toolCallsJson) as unknown;
        if (Array.isArray(parsed)) msg.toolCalls = parsed as ToolCallPart[];
      } catch {
        // Invalid JSON — skip tool calls for this message.
      }
    }
    return msg;
  });
}

/** Convert the ER-5 assembled prompt messages into AI SDK `ModelMessage[]`.
 *  Mirrors `prepareSdkMessages`'s assistant branch: the SDK has NO top-level
 *  `toolCalls` field on an assistant message — tool calls live INSIDE `content`
 *  as `ToolCallPart[]` (AssistantContent). Without this fold the SDK silently
 *  ignores the `toolCalls` field and the model loses its cross-turn tool-call
 *  context. */
function toModelMessages(
  messages: ReadonlyArray<ExperienceCopilotPromptMessage>,
): ModelMessage[] {
  return messages.map((msg): ModelMessage => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };
      case "user":
        return { role: "user", content: msg.content };
      case "assistant": {
        if (msg.toolCalls?.length) {
          const parts: AssistantContent = [...msg.toolCalls];
          if (msg.content) parts.push({ type: "text", text: msg.content });
          return { role: "assistant", content: parts };
        }
        return { role: "assistant", content: msg.content };
      }
      case "tool":
        return { role: "tool", content: msg.content };
    }
  });
}

// ─── Context loading (rules / visual / bound visuals by scriptId) ────────────

interface CopilotContext {
  rules: string;
  visual: string | undefined;
  boundVisuals: Array<{ id: string; name: string; kind: string }>;
}

/** Load the turn-start context package by `thread.scriptId`. When `scriptId` is
 *  null (a draft, pre-save), rules/visual are empty so the model writes fresh.
 *  Bound-visual metadata is best-effort: a missing visual id is skipped, never
 *  fatal (mirrors the loader-skip convention used elsewhere). */
async function loadCopilotContext(
  scriptId: string | null,
  deps: ExperienceCopilotStreamDeps,
): Promise<CopilotContext> {
  if (scriptId === null) {
    return { rules: "", visual: undefined, boundVisuals: [] };
  }
  const [script, boundVisualIds] = await Promise.all([
    deps.getScript(scriptId),
    deps.getBoundVisualIds(scriptId),
  ]);

  // Rules source = the script's code. A missing script is treated as an empty
  // draft (the thread's scriptId is a soft link that may dangle pre-save).
  const rules = script?.code ?? "";

  // Active visual = the script's defaultVisualId, resolved to its source.
  let visual: string | undefined;
  if (script?.defaultVisualId) {
    const v = await deps.getVisual(script.defaultVisualId);
    if (v) visual = v.source;
  }

  // Bound-visual metadata (id/name/kind) — metadata-only, never the source.
  const boundVisuals: CopilotContext["boundVisuals"] = [];
  for (const id of boundVisualIds) {
    const v = await deps.getVisual(id);
    if (v) boundVisuals.push({ id: v.id, name: v.name, kind: "visual" });
  }

  return { rules, visual, boundVisuals };
}

// ─── Main streaming function ─────────────────────────────────────────────────

/**
 * Stream one experience-copilot turn. Loads the thread context, assembles the
 * prompt (ER-5), builds the tools (ER-4), streams via `streamText`, and yields
 * SSE-shaped `{ event, data }` chunks. After the stream completes, the turn
 * (user message + tool calls/results + final assistant text) is persisted to the
 * ER-3 store so history reloads next turn.
 *
 * @throws {@link notFound} when the thread does not exist (surfaces as HTTP 404
 *   via the global error handler, before any SSE headers are sent).
 */
export async function* streamExperienceCopilot(
  request: ExperienceCopilotStreamRequest,
  deps: ExperienceCopilotStreamDeps,
  signal?: AbortSignal,
): AsyncGenerator<ExperienceCopilotStreamEvent> {
  const debug = (event: string, data: Record<string, unknown>) =>
    logSendDebug(`api.experience-copilot.${event}`, data);

  // ── 1. Load thread ──
  const thread = await deps.store.getById(request.threadId);
  if (!thread) {
    throw notFound("ExperienceCopilotThread", `Copilot thread '${request.threadId}' was not found.`);
  }

  // ── 2. Load history (prior turns) + context (rules/visual/bound visuals) ──
  const [priorMessages, context] = await Promise.all([
    deps.store.listMessages(request.threadId),
    loadCopilotContext(thread.scriptId, deps),
  ]);

  const priorHistory = storeMessagesToHistory(priorMessages);

  // ── 3. Resolve provider + model ──
  const profile = await deps.getProviderProfile(request.providerProfileId);
  if (!profile) {
    throw notFound("ProviderProfile", `Provider profile '${request.providerProfileId}' was not found.`);
  }
  const modelName = request.model ?? profile.defaultModel ?? "gpt-4o-mini";
  const effectiveProfile = await deps.getEffectiveProviderProfile(request.providerProfileId, modelName);

  // ── 4. Append the user's message (persist now so it survives a crash) ──
  await deps.store.appendMessage(request.threadId, {
    role: "user",
    content: request.content,
  });

  // ── 5. Assemble the prompt (ER-5) ──
  // The new user message is appended to the prior history for assembly; it was
  // NOT in priorHistory (which is the pre-turn stored set).
  const history: ExperienceCopilotHistoryMessage[] = [
    ...priorHistory,
    { role: "user", content: request.content },
  ];
  const step: ExperienceCopilotStep = request.step ?? "rules";
  // Prefer the LIVE draft buffers the editor sent (unsaved in-progress edits)
  // over the last-persisted buffers loaded from the DB — the copilot must see
  // exactly what the user sees, including a fresh creation draft (pre-save,
  // where the DB buffers are empty) and the buffer the user has switched to.
  const rules = request.rules ?? context.rules;
  const visual = request.visual ?? context.visual;
  const assembled = await assembleExperienceCopilotPrompt({
    history,
    rules,
    ...(visual !== undefined ? { visual } : {}),
    ...(context.boundVisuals.length > 0 ? { boundVisuals: context.boundVisuals } : {}),
    ...(request.testFeedback !== undefined && request.testFeedback !== null
      ? { testFeedback: request.testFeedback as unknown as ExperienceCopilotTestFeedback }
      : {}),
    step,
    model: modelName,
    contextBudget: effectiveProfile.contextBudget,
    responseReserve: effectiveProfile.maxTokens,
  });

  debug("prompt-assembled", {
    threadId: request.threadId,
    systemMessageLength: assembled.systemMessage.length,
    messageCount: assembled.messages.length,
    ...(assembled.compactionSummary ? { compaction: assembled.compactionSummary } : {}),
  });

  // ── 6. Build tools (ER-4), seeded from the current rules/visual ──
  const tools: ToolSet = buildExperienceCopilotTools({
    ...(rules ? { rules } : {}),
    ...(visual !== undefined ? { visual } : {}),
    skillRoots: deps.skillRoots ?? [],
  });

  // ── 7. Resolve the model + start streaming ──
  const providerFetch = await resolveProviderFetchForProfile(effectiveProfile);
  const aiModel = deps.resolveModel(effectiveProfile, modelName, providerFetch);
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;

  const modelMessages = toModelMessages(assembled.messages);

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: aiModel,
      messages: modelMessages,
      allowSystemInMessages: true,
      abortSignal: signal,
      tools,
      stopWhen: isStepCount(maxSteps),
    });
  } catch (err) {
    // Setup error (streamText() failed before iteration began).
    const message = extractProviderErrorMessage(err);
    const category = classifyProviderError(err);
    debug("setup-error", { message, category });
    yield { event: "error", data: JSON.stringify({ message, category }) };
    return;
  }

  // ── 8. Normalize + drain the stream, emitting SSE events ──
  const { stream: mapped } = createMappedStream(result.stream);

  let textAccumulator = "";
  let reasoningAccumulator = "";
  const extractedToolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
  const extractedToolResults: Array<{ toolCallId: string; toolName: string; output: unknown; isError: boolean }> = [];

  try {
    for await (const chunk of mapped as AsyncIterable<ProviderStreamChunk>) {
      if (signal?.aborted) {
        yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
        await persistTurn(deps, request.threadId, textAccumulator, extractedToolCalls, extractedToolResults);
        return;
      }
      if (chunk.type === "text-delta" && chunk.delta) {
        textAccumulator += chunk.delta;
        yield { event: "text-delta", data: JSON.stringify({ delta: chunk.delta }) };
      } else if (chunk.type === "reasoning-delta") {
        reasoningAccumulator += chunk.textDelta;
        yield { event: "reasoning-delta", data: JSON.stringify({ delta: chunk.textDelta }) };
      } else if (chunk.type === "tool-call") {
        extractedToolCalls.push({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: chunk.args,
        });
        debug("tool-call", { threadId: request.threadId, toolCallId: chunk.toolCallId, toolName: chunk.toolName });
        yield {
          event: "tool-call",
          data: JSON.stringify({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, args: chunk.args }),
        };
      } else if (chunk.type === "tool-result") {
        const isError = chunk.isError ?? false;
        extractedToolResults.push({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          output: chunk.output,
          isError,
        });
        debug("tool-result", { threadId: request.threadId, toolCallId: chunk.toolCallId, toolName: chunk.toolName, isError });
        yield {
          event: "tool-result",
          data: JSON.stringify({ toolCallId: chunk.toolCallId, toolName: chunk.toolName, output: chunk.output, isError }),
        };
      }
      // tool-input-start / tool-input-delta are progressive tool-arg streaming
      // (the model writing the document); the chat stream forwards them too,
      // but they are informational and the copilot frontend has no separate use
      // for them yet, so they are intentionally NOT forwarded here.
    }
  } catch (err) {
    if (signal?.aborted) {
      yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
      await persistTurn(deps, request.threadId, textAccumulator, extractedToolCalls, extractedToolResults);
      return;
    }
    const message = extractProviderErrorMessage(err);
    const category = classifyProviderError(err);
    debug("provider-error", { threadId: request.threadId, message, category });
    yield { event: "error", data: JSON.stringify({ message, category }) };
    // Still persist whatever was accumulated so far (partial turn).
    await persistTurn(deps, request.threadId, textAccumulator, extractedToolCalls, extractedToolResults);
    return;
  }

  if (signal?.aborted) {
    yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
    await persistTurn(deps, request.threadId, textAccumulator, extractedToolCalls, extractedToolResults);
    return;
  }

  // ── 9. Finalize: resolve finish metadata + persist the turn ──
  let finishReason = "stop";
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  try {
    const finish = await mapFinish(result, signal);
    finishReason = finish.finishReason;
    usage = finish.usage;
  } catch {
    finishReason = "error";
  }

  await persistTurn(deps, request.threadId, textAccumulator, extractedToolCalls, extractedToolResults);

  if (reasoningAccumulator) {
    yield { event: "reasoning-done", data: JSON.stringify({}) };
  }

  yield {
    event: "finish",
    data: JSON.stringify({ finishReason, usage, modelId: modelName }),
  };
}

// ─── Turn persistence ────────────────────────────────────────────────────────

/** Persist the assistant half of the turn: tool-call messages, tool-result
 *  messages, and the final assistant text (when non-empty). The user message
 *  was already persisted before streaming. Each write is independent (no
 *  transaction) so a failure on one does not lose the others — the messages are
 *  append-only and ordered by createdAt. */
async function persistTurn(
  deps: ExperienceCopilotStreamDeps,
  threadId: string,
  text: string,
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown; isError: boolean }>,
): Promise<void> {
  // Assistant tool-call proposals (one assistant row carrying all calls).
  if (toolCalls.length > 0) {
    const persisted: PersistedToolCall[] = toolCalls.map((tc) => ({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.args,
    }));
    await deps.store.appendMessage(threadId, {
      role: "assistant",
      content: "",
      toolCallsJson: JSON.stringify(persisted),
    });
  }

  // Tool results (one tool row per result, carrying toolName + output).
  for (const tr of toolResults) {
    const payload: PersistedToolResult = { toolName: tr.toolName, output: tr.output };
    await deps.store.appendMessage(threadId, {
      role: "tool",
      content: JSON.stringify(payload),
      toolCallId: tr.toolCallId,
    });
  }

  // Final assistant text (the model's explanation), only when non-empty.
  if (text.trim()) {
    await deps.store.appendMessage(threadId, {
      role: "assistant",
      content: text,
    });
  }
}
