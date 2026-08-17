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
import type { CopilotProfile, ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
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
  resolveDigestBoundary,
  type ExperienceCopilotHistoryMessage,
  type ExperienceCopilotPromptMessage,
  type ExperienceCopilotStep,
  type ExperienceCopilotTestFeedback,
} from "./experience-copilot-prompt.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS, COPILOT_RESPONSE_RESERVE_TOKENS } from "./copilot-limits.js";
import { buildExperienceCopilotTools } from "./experience-copilot-tools.js";
import { resolveBuiltinCopilotProfile } from "./experience-copilot-module.js";

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
  /** Resolve the copilot profile for a script (CP-6/CP-7). Absent → the built-in
   *  seed (the pre-plan ER-16 module). */
  readonly resolveProfile?: (scriptId: string | null) => Promise<CopilotProfile>;
  /** Optional copilot user-skill root for the two-root catalog (CP-4). Absent →
   *  built-in root only. */
  readonly skillUserRoot?: string;
  /** Max tool-loop steps for the multi-step loop (mirrors co-author maxSteps).
   *  Defaults to the resolved profile's maxSteps (the built-in seed = 20). */
  readonly maxSteps?: number;
  /** The AI SDK streaming function. Defaults to the real `streamText` from "ai".
   *  Injectable so tests can substitute a fake WITHOUT `mock.module("ai")` —
   *  under bun:test that mock is process-global and permanent (neither
   *  `mock.restore()` nor re-registration undoes it; see AGENTS.md gotcha), and
   *  its `streamText` override leaks into later files, hanging their real AI
   *  SDK usage. Production wiring omits this field and gets the real function. */
  readonly streamText?: typeof streamText;
  /** CM-6 fire-and-forget auto-compaction trigger. Called AFTER the turn's
   *  metrics are persisted (so the service reads the fresh `lastProviderProfileId`
   *  / `lastModel` + `contextMetrics`). The stream does NOT await it — the
   *  compaction runs under its own per-thread background lock and must never
   *  block or fail the stream. Absent → no auto-compaction (tests, legacy). */
  readonly autoCompact?: (threadId: string) => Promise<void>;
}

// DEFAULT_MAX_STEPS moved to the built-in profile's maxSteps (ER-16 / CP-4) —
// the profile is the single declarative source for the tool-loop bound; an
// assigned profile overrides it via `deps.maxSteps ?? copilotProfile.maxSteps`.

// ─── History conversion (store ↔ prompt ↔ SDK) ───────────────────────────────

/** Convert stored copilot messages (ER-3) into the history shape ER-5 expects.
 *  Round-trips the {@link storeHistoryToSdk} serialization: assistant rows carry
 *  parsed `toolCalls`; tool rows carry a reconstructed `ToolResultPart`.
 *  Exported (CM-5) so the compaction service reuses the SAME conversion for its
 *  tool-pair-safe boundary walk and post-compaction token estimate. */
export function storeMessagesToHistory(
  messages: readonly ExperienceCopilotMessage[],
): ExperienceCopilotHistoryMessage[] {
  return messages.map((m): ExperienceCopilotHistoryMessage => {
    if (m.role === "digest") {
      // A compaction digest (CM-3) round-trips as a plain digest message — the
      // assembler lifts it out of the history flow.
      return { role: "digest", content: m.content };
    }
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

  // ── Pre-split at the digest boundary (CM-5) ──────────────────────────────
  // A digest REPLACES older messages in the MODEL window only. Before assembly,
  // resolve the boundary: the LAST digest is re-placed at the front (so the
  // assembler's CM-3 lifting renders it as a system section) and every message
  // strictly before its anchor is dropped. Zero-digest threads pass through
  // unchanged (byte-identical assembly preserved).
  const boundary = resolveDigestBoundary(priorMessages);
  const priorHistory: ExperienceCopilotHistoryMessage[] = [
    ...(boundary.lastDigest ? storeMessagesToHistory([boundary.lastDigest]) : []),
    ...storeMessagesToHistory(boundary.kept),
  ];

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

  // ── 5. Resolve the copilot profile (base prompt + skills + tools + budget) ──
  // Defaults to the built-in seed (CP-4) — zero behavior change for an
  // experience with no assigned profile (the pre-plan ER-16 module).
  const copilotProfile = deps.resolveProfile
    ? await deps.resolveProfile(thread.scriptId)
    : await resolveBuiltinCopilotProfile();

  // ── 6. Assemble the prompt (ER-5) ──
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
    contextBudget: COPILOT_CONTEXT_BUDGET_TOKENS,
    responseReserve: COPILOT_RESPONSE_RESERVE_TOKENS,
    profile: copilotProfile,
    ...(deps.skillUserRoot !== undefined ? { skillUserRoot: deps.skillUserRoot } : {}),
  });

  debug("prompt-assembled", {
    threadId: request.threadId,
    systemMessageLength: assembled.systemMessage.length,
    messageCount: assembled.messages.length,
    ...(assembled.compactionSummary ? { compaction: assembled.compactionSummary } : {}),
  });

  // ── 7. Build tools (ER-4), seeded from the current rules/visual ──
  // Skill roots come from the resolved skill catalog (ER-16) — the prompt
  // assembler derives them from the same catalog it rendered, so read_skill_file
  // resolves paths against the matching root. toolSet is the resolved profile's
  // set (read_skill_file is always added on top, mirroring Co-Author).
  const tools: ToolSet = buildExperienceCopilotTools({
    ...(rules ? { rules } : {}),
    ...(visual !== undefined ? { visual } : {}),
    toolSet: copilotProfile.toolSet,
    skillRoots: assembled.skillRoots,
  });

  // ── 8. Resolve the model + start streaming ──
  const providerFetch = await resolveProviderFetchForProfile(effectiveProfile);
  const aiModel = deps.resolveModel(effectiveProfile, modelName, providerFetch);
  const maxSteps = deps.maxSteps ?? copilotProfile.maxSteps;

  const modelMessages = toModelMessages(assembled.messages);

  const stream = deps.streamText ?? streamText;
  let result: ReturnType<typeof streamText>;
  try {
    result = stream({
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

  // ── 9. Normalize + drain the stream, emitting SSE events ──
  // `state.providerResponse.steps` collects PER-STEP usage from finish-step
  // parts — the metrics path reads the LAST step's input (see CM-4 block below).
  const { stream: mapped, state: mappedState } = createMappedStream(result.stream);

  let textAccumulator = "";
  let reasoningAccumulator = "";
  // TF-3: the turn's pieces in ARRIVAL order. Consecutive text-deltas coalesce
  // into one open text segment; a tool-call chunk closes the open text segment
  // (the next text-delta opens a new one), so the stored rows preserve the
  // model's real sequence: text → tool-call → tool-result → text → …
  const segments: TurnSegment[] = [];
  const appendTextDelta = (delta: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === "text") last.text += delta;
    else segments.push({ kind: "text", text: delta });
  };

  try {
    for await (const chunk of mapped as AsyncIterable<ProviderStreamChunk>) {
      if (signal?.aborted) {
        yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
        await persistTurn(deps, request.threadId, segments);
        return;
      }
      if (chunk.type === "text-delta" && chunk.delta) {
        textAccumulator += chunk.delta;
        appendTextDelta(chunk.delta);
        yield { event: "text-delta", data: JSON.stringify({ delta: chunk.delta }) };
      } else if (chunk.type === "reasoning-delta") {
        reasoningAccumulator += chunk.textDelta;
        yield { event: "reasoning-delta", data: JSON.stringify({ delta: chunk.textDelta }) };
      } else if (chunk.type === "tool-call") {
        segments.push({
          kind: "toolCall",
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
        segments.push({
          kind: "toolResult",
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
      await persistTurn(deps, request.threadId, segments);
      return;
    }
    const message = extractProviderErrorMessage(err);
    const category = classifyProviderError(err);
    debug("provider-error", { threadId: request.threadId, message, category });
    yield { event: "error", data: JSON.stringify({ message, category }) };
    // Still persist whatever was accumulated so far (partial turn).
    await persistTurn(deps, request.threadId, segments);
    return;
  }

  if (signal?.aborted) {
    yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
    await persistTurn(deps, request.threadId, segments);
    return;
  }

  // ── 10. Finalize: resolve finish metadata + persist the turn ──
  let finishReason = "stop";
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  try {
    const finish = await mapFinish(result, signal);
    finishReason = finish.finishReason;
    usage = finish.usage;
  } catch {
    finishReason = "error";
  }

  await persistTurn(deps, request.threadId, segments);

  if (reasoningAccumulator) {
    yield { event: "reasoning-done", data: JSON.stringify({}) };
  }

  // ── Context metrics (CM-4) ─────────────────────────────────────────────────
  // Per-segment values are ALWAYS the assembler's estimate (the provider only
  // reports an aggregate). `totalTokens` prefers the provider's ACTUAL input
  // size of the FINAL request — read from the live provider-response trace's
  // LAST step (multi-step tool turns re-send the whole context per step, so the
  // aggregate `usage.inputTokens` SUMS steps: 3 steps × ~63k ≈ 190k reported
  // against a 100k budget — a false 190% reading. The last step's input is the
  // true final context size; for single-step turns it equals the aggregate).
  // Else the assembler's estimate — metrics honesty: never blend the two and
  // claim it was measured. `budgetTokens` is 0 when the profile has no explicit
  // context budget (the meter renders an unmetered bar). `reserveTokens` clamps
  // negatives to 0 (maxTokens -1 = "model decides" = no explicit reserve).
  // Persisting is best-effort: a failure logs and never fails the turn.
  const traceSteps = mappedState.providerResponse.steps;
  const lastStepInputTokens = traceSteps.length > 0
    ? traceSteps[traceSteps.length - 1]?.usage?.inputTokens
    : undefined;
  const providerInputTokens = lastStepInputTokens ?? usage?.inputTokens;
  let metricsSource: "estimate" | "provider";
  let metricsTotalTokens: number;
  if (
    typeof providerInputTokens === "number" &&
    Number.isFinite(providerInputTokens) &&
    providerInputTokens > 0
  ) {
    metricsSource = "provider";
    metricsTotalTokens = providerInputTokens;
  } else {
    metricsSource = "estimate";
    metricsTotalTokens = assembled.tokenAccounting.total;
  }
  const contextMetrics: ExperienceCopilotContextMetrics = {
    systemTokens: assembled.tokenAccounting.system,
    digestTokens: assembled.tokenAccounting.digest,
    historyTokens: assembled.tokenAccounting.history,
    totalTokens: metricsTotalTokens,
    budgetTokens: COPILOT_CONTEXT_BUDGET_TOKENS,
    reserveTokens: COPILOT_RESPONSE_RESERVE_TOKENS,
    source: metricsSource,
    measuredAt: new Date().toISOString(),
  };
  try {
    await deps.store.updateContextMetrics(
      request.threadId,
      contextMetrics,
      request.providerProfileId,
      modelName,
    );
  } catch (err) {
    debug("metrics-persist-failed", {
      threadId: request.threadId,
      message: extractProviderErrorMessage(err),
    });
  }

  // ── CM-6 fire-and-forget auto-compaction ──────────────────────────────────
  // Trigger AFTER the metrics (and thus lastProviderProfileId/lastModel) are
  // persisted. Deliberately NOT awaited — the compaction service runs under its
  // own per-thread lock and must never block or fail the stream.
  void deps.autoCompact?.(request.threadId);

  yield {
    event: "finish",
    data: JSON.stringify({ finishReason, usage, modelId: modelName, metrics: contextMetrics }),
  };
}

// ─── Turn persistence ────────────────────────────────────────────────────────

/** One chronologically ordered piece of the assistant turn (TF-3). The stream
 *  loop records segments in arrival order; persistTurn walks them so stored
 *  rows preserve the model's text → tool-call → tool-result → text sequence
 *  (the old accumulator flattened the whole turn into tool rows + ONE final
 *  text row, losing the interleaving). */
type TurnSegment =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { kind: "toolResult"; toolCallId: string; toolName: string; output: unknown; isError: boolean };

/** Persist the assistant half of the turn as chronologically ordered rows: a
 *  non-empty text segment → an assistant text row; a RUN of consecutive
 *  tool-call segments (parallel calls in one step) → one assistant row
 *  carrying them in `toolCallsJson`; a tool-result segment → one tool row.
 *  The user message was already persisted before streaming. Each write is
 *  independent (no transaction) so a failure on one does not lose the others —
 *  the messages are append-only and ordered by createdAt. */
async function persistTurn(
  deps: ExperienceCopilotStreamDeps,
  threadId: string,
  segments: readonly TurnSegment[],
): Promise<void> {
  let pendingToolCalls: PersistedToolCall[] = [];
  const flushToolCalls = async () => {
    if (pendingToolCalls.length === 0) return;
    const persisted = pendingToolCalls;
    pendingToolCalls = [];
    await deps.store.appendMessage(threadId, {
      role: "assistant",
      content: "",
      toolCallsJson: JSON.stringify(persisted),
    });
  };

  for (const seg of segments) {
    if (seg.kind === "toolCall") {
      // Consecutive tool calls stay in ONE assistant row until any other
      // segment kind arrives (mirrors parallel calls in a single step).
      pendingToolCalls.push({
        type: "tool-call",
        toolCallId: seg.toolCallId,
        toolName: seg.toolName,
        input: seg.args,
      });
      continue;
    }
    await flushToolCalls();
    if (seg.kind === "toolResult") {
      const payload: PersistedToolResult = { toolName: seg.toolName, output: seg.output };
      await deps.store.appendMessage(threadId, {
        role: "tool",
        content: JSON.stringify(payload),
        toolCallId: seg.toolCallId,
      });
    } else if (seg.text.trim()) {
      // Assistant text (the model's explanation), only when non-empty — a
      // whitespace-only segment stays unpersisted, same as the old accumulator.
      await deps.store.appendMessage(threadId, {
        role: "assistant",
        content: seg.text,
      });
    }
  }
  await flushToolCalls();
}
