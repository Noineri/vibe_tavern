/**
 * Generic agent turn stream (AGENT_SHELL_PLAN, Wave 1 / AS-2c) — the
 * kind-AGNOSTIC streaming loop carved out of `experience-copilot-stream.ts`
 * (ER-6): thread load, turn-input persistence (content mode + the TAG-5
 * `ask_user` answer-mode marker rewrite), digest-boundary pre-split, provider
 * stream consumption via `streamText`, the SSE event relay (`text-delta`,
 * `reasoning-delta`, `tool-call`, `tool-result`, `finish`, `error`, `abort`),
 * TF-3 ordered turn persistence, CM-4 context metrics, and the CM-6
 * fire-and-forget auto-compaction trigger. Everything KIND-SPECIFIC — context
 * loading, agent-profile resolution, prompt assembly, tool-set building — is
 * injected through {@link AgentStreamSeams}; the experience wiring in the old
 * module supplies them (a second kind's turn runs the same loop with its own
 * assembly + tools).
 *
 * Same seams pattern as `AgentCompactionSeams` (AS-2b): the mechanism lives
 * here, the knowledge lives in the kind. This file must stay free of kind
 * knowledge — no kind imports, no buffer names in code.
 */

import { streamText, isStepCount, hasToolCall } from "ai";
import type { LanguageModel, ModelMessage, AssistantContent, ToolCallPart, ToolResultPart } from "ai";
import type { ToolSet } from "ai";
import type { ProviderProfile, CopilotContextMetrics } from "@vibe-tavern/db";
import { buildContextMetrics, type AgentTokenAccounting } from "./agent-context-metrics.js";
import type { ProviderFetch } from "../providers/provider-fetch-factory.js";
import { resolveProviderFetchForProfile } from "../providers/provider-fetch-factory.js";
import { createMappedStream, mapFinish } from "../../infrastructure/ai/stream-helpers.js";
import { asToolProviderOptions } from "../../infrastructure/ai/tool-call-provider-options.js";
import type { ProviderStreamChunk } from "../../infrastructure/ai/provider-execution-types.js";
import { classifyProviderError } from "../../infrastructure/ai/provider-error-classifier.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { notFound, validation } from "../../shared/errors.js";
import { resolveDigestBoundary, type AgentHistoryMessage } from "./agent-prompt.js";

// ─── Persisted tool payload shapes (store round-trip) ────────────────────────

/** Persisted tool-call row, serialized into `tool_calls_json` on an assistant
 *  message. `providerOptions` carries the provider's replay metadata (Gemini 3
 *  `thoughtSignature`, aggregator per-call metadata) that a resumed turn must
 *  send back with the call — absent when the provider sent none. */
export interface AgentPersistedToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: ToolCallPart["providerOptions"];
}

/** Persisted tool-result payload, serialized into the `content` of a tool
 *  message row. Carries `toolName` so the round-trip back to a
 *  `ToolResultPart` (which the SDK requires) does not need a side lookup. */
export interface AgentPersistedToolResult {
  toolName: string;
  output: unknown;
}

// ─── Store / thread / request shapes (structural subsets) ────────────────────

/** Structural view of a stored agent thread row sufficient for the generic
 *  loop. The concrete per-kind thread type satisfies this without adapters. */
export interface AgentStreamThread {
  readonly id: string;
  /** The anchoring entity id for the thread's plans, or null for a draft. */
  readonly scriptId: string | null;
  /** Pinned-context links (resolved per turn by the kind's assembly seam). */
  readonly contextLinks: readonly unknown[];
}

/** Structural view of a stored message row the loop reads. The concrete
 *  per-kind message type satisfies this without adapters; `content` and the
 *  tool columns round-trip the persisted tool payload shapes above. */
export interface AgentStreamStoredMessage {
  id: string;
  role: string;
  content: string;
  toolCallId: string | null;
  toolCallsJson: string | null;
}

/** The `appendMessage` input shape the loop writes (user rows, assistant text
 *  rows, tool-call runs, tool-result rows). */
export interface AgentStreamAppendInput {
  role: string;
  content?: string;
  toolCallsJson?: string | null;
  toolCallId?: string | null;
}

/** Structural store subset the generic loop needs (method syntax keeps param
 *  bivariance, so the concrete per-kind store satisfies this without
 *  adapters). */
export interface AgentStreamStore<THREAD extends AgentStreamThread = AgentStreamThread> {
  getById(threadId: string): Promise<THREAD | null>;
  listMessages(threadId: string): Promise<readonly AgentStreamStoredMessage[]>;
  appendMessage(threadId: string, input: AgentStreamAppendInput): Promise<unknown>;
  setToolResultOutput(
    threadId: string,
    toolCallId: string,
    payload: { toolName: string; output: unknown },
  ): Promise<unknown>;
  updateContextMetrics(
    threadId: string,
    metrics: CopilotContextMetrics,
    providerProfileId: string,
    model: string,
  ): Promise<unknown>;
}

/** Answer to a pending `ask_user` question (TAG-5 split-turn, style B). The
 *  continuation turn runs with NO new user row — this answer is persisted as
 *  the answered ask tool-result instead. */
export interface AgentTurnAnswer {
  readonly toolCallId: string;
  readonly text?: string;
  readonly skipped?: boolean;
}

/** The turn request fields the generic loop reads itself; the kind's own
 *  request interface EXTENDS this (extra fields ride along opaquely into the
 *  seams). */
export interface AgentTurnRequest {
  readonly threadId: string;
  readonly content?: string;
  readonly answer?: AgentTurnAnswer;
  readonly providerProfileId: string;
  readonly model?: string;
}

/** SSE-shaped chunk the route emits verbatim through `streamSSE`. */
export interface AgentStreamEvent {
  event: string;
  data: string;
}

/** Provider/model resolution deps — shared by every kind (the adapter layer
 *  supplies them over the same stores). */
export interface AgentStreamDeps<THREAD extends AgentStreamThread = AgentStreamThread> {
  readonly store: AgentStreamStore<THREAD>;
  readonly getProviderProfile: (id: string) => Promise<ProviderProfile | null>;
  readonly getEffectiveProviderProfile: (id: string, model: string) => Promise<ProviderProfile>;
  readonly resolveModel: (
    profile: { providerPreset: string; endpoint: string; apiKey: string | null },
    model: string,
    fetch?: ProviderFetch,
  ) => LanguageModel;
  /** The AI SDK streaming function. Defaults to the real `streamText` from "ai".
   *  Injectable so tests substitute a fake WITHOUT `mock.module("ai")` — under
   *  bun:test that mock is process-global and permanent. */
  readonly streamText?: typeof streamText;
  /** CM-6 fire-and-forget auto-compaction trigger, called AFTER the turn's
   *  metrics are persisted. Never awaited; absent → no auto-compaction. */
  readonly autoCompact?: (threadId: string) => Promise<void>;
}

// ─── Assembled-prompt shape (seam result) ────────────────────────────────────

/** One message in a kind's assembled prompt (system + compacted history) —
 *  the shape the generic `toModelMessages` fold consumes. */
export type AgentPromptMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallPart[] }
  | { role: "tool"; content: ToolResultPart[] };

/** Structural view of a kind's assembly result the loop reads (system length
 *  for the debug line, the messages for the model call, and the segmented
 *  token accounting for CM-4 metrics — the accounting shape lives beside its
 *  metrics builder in `agent-context-metrics.ts`). */
export interface AgentAssembledPrompt {
  readonly systemMessage: string;
  readonly messages: ReadonlyArray<AgentPromptMessage>;
  readonly tokenAccounting: AgentTokenAccounting;
  readonly compactionSummary?: string;
}

// ─── Seams ───────────────────────────────────────────────────────────────────

/** Input the kind's assembly seam receives. */
export interface AgentAssembleSeamInput<
  REQ extends AgentTurnRequest,
  THREAD extends AgentStreamThread,
  CTX,
  PROFILE,
> {
  readonly thread: THREAD;
  readonly request: REQ;
  readonly kindContext: CTX;
  readonly agentProfile: PROFILE;
  /** The model-window history AFTER the digest-boundary pre-split and the
   *  new user-message push (answer mode pushes nothing). */
  readonly history: readonly AgentHistoryMessage[];
  readonly model: string;
}

/** Input the kind's tool-builder seam receives. */
export interface AgentBuildToolsSeamInput<
  REQ extends AgentTurnRequest,
  THREAD extends AgentStreamThread,
  CTX,
  PROFILE,
  ASM extends AgentAssembledPrompt,
> {
  readonly thread: THREAD;
  readonly request: REQ;
  readonly kindContext: CTX;
  readonly agentProfile: PROFILE;
  readonly assembled: ASM;
}

/** The KIND-SPECIFIC seams injected into the generic loop — everything that
 *  cannot live in the kind-agnostic core without dragging kind knowledge (or
 *  an import of the kind's subsystem) into `domain/agent/`. */
export interface AgentStreamSeams<
  REQ extends AgentTurnRequest = AgentTurnRequest,
  THREAD extends AgentStreamThread = AgentStreamThread,
  CTX = unknown,
  PROFILE = unknown,
  ASM extends AgentAssembledPrompt = AgentAssembledPrompt,
> {
  /** Debug-log channel prefix (e.g. "api.experience-copilot"); the event
   *  suffixes (`.tool-call`, `.prompt-assembled`, …) are appended here. */
  readonly logChannelPrefix: string;
  /** Error label for a missing thread (the notFound entity name). */
  readonly threadLabel: string;
  /** The kind's limits: context budget + response reserve (CM-4 metric
   *  fields) and the wire-level tool-loop ceiling for `stopWhen`. */
  readonly limits: {
    readonly contextBudgetTokens: number;
    readonly responseReserveTokens: number;
    readonly toolLoopCeiling: number;
  };
  /** Extra kind-context facts for the `prompt-assembled` debug line (e.g. the
   *  trust flag); merged as-is. */
  readonly assembleDebugFields?: (kindContext: CTX) => Record<string, unknown>;
  /** Load the kind's turn context, in parallel with the stored history. */
  readonly loadContext: (thread: THREAD) => Promise<CTX>;
  /** Resolve the kind's agent profile (base prompt + tool toggles + budget). */
  readonly resolveProfile: (thread: THREAD) => Promise<PROFILE>;
  /** Assemble the prompt (kind-owned; loads its own plans/attached context). */
  readonly assemble: (
    input: AgentAssembleSeamInput<REQ, THREAD, CTX, PROFILE>,
  ) => Promise<ASM>;
  /** Build the tool set (kind-owned; seeded from the same context the
   *  assembly saw). */
  readonly buildTools: (
    input: AgentBuildToolsSeamInput<REQ, THREAD, CTX, PROFILE, ASM>,
  ) => ToolSet;
}

// ─── History conversion (store ↔ prompt ↔ SDK) ───────────────────────────────

/** Is this parsed tool-result output an awaiting `ask_user` marker? (TAG-5) */
function isAwaitingAskOutput(output: unknown): boolean {
  return (
    output !== null &&
    typeof output === "object" &&
    (output as { status?: unknown }).status === "awaiting_answer"
  );
}

/** Wire stringify GUARANTEEING the result parses to a non-null JSON object:
 *  objects pass through verbatim; any other value (a tool that persisted a
 *  primitive, a malformed ask payload) wraps under a `result` key. Translation
 *  proxies (agi → Google) build google.protobuf.Struct function responses from
 *  these strings — a bare string is a 400, an object passes. */
function stringifyObjectWireText(output: unknown): string {
  if (output !== null && typeof output === "object") return JSON.stringify(output);
  return JSON.stringify({ result: output });
}

/** The model-visible wire JSON for an `ask_user` tool-result output (TAG-5
 *  split-turn). The stored payload is STRUCTURED state for the UI; the model
 *  reads the same facts through self-describing keys instead of marker JSON:
 *  an answer → `{ answer }` (the user's text verbatim); a skip →
 *  `{ skipped: true }`; a still-awaiting marker (the user moved on) →
 *  `{ unanswered: true, note }`, so the model never sees a dangling promise.
 *  Prompt-side only: the stored row is never mutated by this rendering. */
function renderAskOutputWireText(output: unknown): string {
  if (output !== null && typeof output === "object" && "status" in output) {
    const status = (output as { status: unknown }).status;
    if (status === "awaiting_answer") {
      return JSON.stringify({ unanswered: true, note: "the user did not answer this question; they moved on" });
    }
    if (status === "skipped") return JSON.stringify({ skipped: true });
    if (status === "answered") {
      const answer = (output as { answer?: unknown }).answer;
      if (typeof answer === "string" && answer.length > 0) return JSON.stringify({ answer });
    }
  }
  return stringifyObjectWireText(output);
}

/** Is this stored message row an awaiting `ask_user` tool-result? (TAG-5 —
 *  the answer-mode precondition; parsed defensively, never throws.) */
function isAwaitingAskRow(m: AgentStreamStoredMessage): boolean {
  try {
    const parsed = JSON.parse(m.content) as AgentPersistedToolResult;
    return parsed.toolName === "ask_user" && isAwaitingAskOutput(parsed.output);
  } catch {
    return false;
  }
}

/** Convert stored agent messages into the history shape the assembly expects.
 *  Round-trips the {@link toModelMessages} serialization: assistant rows carry
 *  parsed `toolCalls`; tool rows carry a reconstructed `ToolResultPart`.
 *  Exported (CM-5) so the compaction service reuses the SAME conversion for its
 *  tool-pair-safe boundary walk and post-compaction token estimate. */
export function storeMessagesToHistory<M extends AgentStreamStoredMessage>(
  messages: readonly M[],
): AgentHistoryMessage[] {
  return messages.map((m): AgentHistoryMessage => {
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
        const parsed = JSON.parse(m.content) as AgentPersistedToolResult;
        toolName = parsed.toolName ?? "";
        outputText = stringifyObjectWireText(parsed.output);
        // TAG-5: an ask_user result carries the CONVERSATION, not telemetry —
        // the model reads the answer / skip / never-answered note through
        // self-describing keys, never the marker JSON (the whole wire string
        // parses to a JSON object — Struct contract for translation proxies).
        if (toolName === "ask_user") outputText = renderAskOutputWireText(parsed.output);
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
    const msg: AgentHistoryMessage = {
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    };
    if (m.toolCallsJson) {
      try {
        const parsed = JSON.parse(m.toolCallsJson) as unknown;
        if (Array.isArray(parsed)) {
          // Narrow the stored replay metadata through the shared helper (the
          // same one the Co-Author converter uses): a valid object passes
          // through, anything else (absent field, primitive, array) drops to
          // absent — never an empty object on the replayed part.
          msg.toolCalls = parsed.map((call): ToolCallPart => {
            const c = call as AgentPersistedToolCall;
            const providerOptions = asToolProviderOptions(c.providerOptions);
            return {
              type: "tool-call",
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              input: c.input,
              ...(providerOptions ? { providerOptions } : {}),
            };
          });
        }
      } catch {
        // Invalid JSON — skip tool calls for this message.
      }
    }
    return msg;
  });
}

/** Convert the assembled prompt messages into AI SDK `ModelMessage[]`.
 *  Mirrors `prepareSdkMessages`'s assistant branch: the SDK has NO top-level
 *  `toolCalls` field on an assistant message — tool calls live INSIDE `content`
 *  as `ToolCallPart[]` (AssistantContent) — without this fold the SDK silently
 *  ignores them and the model loses its cross-turn tool-call context. */
function toModelMessages(
  messages: ReadonlyArray<AgentPromptMessage>,
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

// ─── Turn persistence (TF-3) ─────────────────────────────────────────────────

/** One chronologically ordered piece of the assistant turn (TF-3). The stream
 *  loop records segments in arrival order; persistTurn walks them so stored
 *  rows preserve the model's text → tool-call → tool-result → text sequence
 *  (the old accumulator flattened the whole turn into tool rows + ONE final
 *  text row, losing the interleaving). */
type AgentTurnSegment =
  | { kind: "text"; text: string }
  | {
      kind: "toolCall";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      providerOptions?: ToolCallPart["providerOptions"];
    }
  | { kind: "toolResult"; toolCallId: string; toolName: string; output: unknown; isError: boolean };

/** Persist the assistant half of the turn as chronologically ordered rows: a
 *  non-empty text segment → an assistant text row; a RUN of consecutive
 *  tool-call segments (parallel calls in one step) → one assistant row in
 *  `toolCallsJson`; a tool-result segment → one tool row. Each write is
 *  independent (no transaction) so a failure loses only itself (append-only,
 *  ordered by createdAt). */
async function persistTurn(
  store: AgentStreamStore,
  threadId: string,
  segments: readonly AgentTurnSegment[],
): Promise<void> {
  let pendingToolCalls: AgentPersistedToolCall[] = [];
  const flushToolCalls = async () => {
    if (pendingToolCalls.length === 0) return;
    const persisted = pendingToolCalls;
    pendingToolCalls = [];
    await store.appendMessage(threadId, {
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
        ...(seg.providerOptions ? { providerOptions: seg.providerOptions } : {}),
      });
      continue;
    }
    await flushToolCalls();
    if (seg.kind === "toolResult") {
      const payload: AgentPersistedToolResult = { toolName: seg.toolName, output: seg.output };
      await store.appendMessage(threadId, {
        role: "tool",
        content: JSON.stringify(payload),
        toolCallId: seg.toolCallId,
      });
    } else if (seg.text.trim()) {
      // Assistant text (the model's explanation), only when non-empty — a
      // whitespace-only segment stays unpersisted, same as the old accumulator.
      await store.appendMessage(threadId, {
        role: "assistant",
        content: seg.text,
      });
    }
  }
  await flushToolCalls();
}

// ─── The generic turn loop ───────────────────────────────────────────────────

/**
 * Stream one agent turn through the generic mechanism: load the thread and the
 * kind context, persist the turn's input (content or answer mode), pre-split
 * at the digest boundary, resolve the kind's profile, assemble the prompt and
 * build the tools through the seams, stream via `streamText`, relay SSE events,
 * persist the ordered turn, and record the context metrics. After the stream
 * completes, the auto-compaction hook fires (never awaited).
 *
 * @throws {@link notFound} when the thread or provider profile does not exist
 *   (surfaces via the global error handler, before any SSE headers are sent).
 */
export async function* streamAgentTurn<
  REQ extends AgentTurnRequest,
  THREAD extends AgentStreamThread,
  CTX,
  PROFILE,
  ASM extends AgentAssembledPrompt,
>(
  request: REQ,
  deps: AgentStreamDeps<THREAD>,
  seams: AgentStreamSeams<REQ, THREAD, CTX, PROFILE, ASM>,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  const debug = (event: string, data: Record<string, unknown>) =>
    logSendDebug(`${seams.logChannelPrefix}.${event}`, data);

  // ── 1. Load thread ──
  const thread = await deps.store.getById(request.threadId);
  if (!thread) {
    throw notFound(seams.threadLabel, `Copilot thread '${request.threadId}' was not found.`);
  }

  // ── 2. Load history (prior turns) + the kind context ──
  const [priorMessages, context] = await Promise.all([
    deps.store.listMessages(request.threadId),
    seams.loadContext(thread),
  ]);

  // ── 3. Resolve provider + model ──
  const profile = await deps.getProviderProfile(request.providerProfileId);
  if (!profile) {
    throw notFound("ProviderProfile", `Provider profile '${request.providerProfileId}' was not found.`);
  }
  const modelName = request.model ?? profile.defaultModel ?? "gpt-4o-mini";
  const effectiveProfile = await deps.getEffectiveProviderProfile(request.providerProfileId, modelName);

  // ── 4. Persist this turn's input ──
  // Content mode: append the user's message row NOW so it survives a crash.
  // Answer mode (TAG-5 split-turn, style B): NO user row — the answer replaces
  // the awaiting marker of the referenced ask_user tool-result row, and the
  // turn resumes as a continuation of the question turn. The rewrite is
  // validated first (the row must be an awaiting ask in THIS thread) so a
  // stale or foreign toolCallId can never overwrite another tool's result.
  if (request.answer) {
    const answer = request.answer;
    const target = priorMessages.find(
      (m) => m.role === "tool" && m.toolCallId === answer.toolCallId,
    );
    if (!target || !isAwaitingAskRow(target)) {
      throw validation(
        "The question being answered was not found (or is no longer awaiting) in this thread.",
      );
    }
    const answerPayload: AgentPersistedToolResult = {
      toolName: "ask_user",
      output: answer.skipped
        ? { status: "skipped" }
        : { status: "answered", answer: answer.text ?? "" },
    };
    await deps.store.setToolResultOutput(request.threadId, answer.toolCallId, answerPayload);
    // Rewrite the in-memory copy so THIS turn's assembly sees the answered
    // state without a re-fetch (the store row is the durable copy).
    target.content = JSON.stringify(answerPayload);
  } else if (request.content) {
    await deps.store.appendMessage(request.threadId, {
      role: "user",
      content: request.content,
    });
  } else {
    // The wire schema enforces exactly-one-of content/answer; this guards
    // direct domain callers (tests, future internal callers).
    throw validation("A copilot turn requires either `content` or `answer`.");
  }

  // ── Pre-split at the digest boundary (CM-5) ──────────────────────────────
  // A digest REPLACES older messages in the MODEL window only. Before assembly,
  // resolve the boundary: the LAST digest is re-placed at the front (so the
  // assembler's CM-3 lifting renders it as a system section) and every message
  // strictly before its anchor is dropped. Zero-digest threads pass through
  // unchanged (byte-identical assembly preserved). Computed AFTER the input
  // branch (TAG-5): an answered ask row must already carry its answer here, so
  // the model window ends on the answered tool-result, never the marker.
  const boundary = resolveDigestBoundary(priorMessages);
  const priorHistory: AgentHistoryMessage[] = [
    ...(boundary.lastDigest ? storeMessagesToHistory([boundary.lastDigest]) : []),
    ...storeMessagesToHistory(boundary.kept),
  ];

  // ── 5. Resolve the kind's agent profile (base prompt + tools + budget) ──
  const agentProfile = await seams.resolveProfile(thread);

  // ── 6. Assemble the prompt (kind-owned) ──
  // Content mode: the new user message is appended to the prior history for
  // assembly; it was NOT in priorHistory (which is the pre-turn stored set).
  // Answer mode (TAG-5): NO user message is pushed — the history already ends
  // with the answered ask tool-result, which IS the turn's input.
  const history: AgentHistoryMessage[] = request.content
    ? [...priorHistory, { role: "user", content: request.content }]
    : priorHistory;
  const assembled = await seams.assemble({
    thread,
    request,
    kindContext: context,
    agentProfile,
    history,
    model: modelName,
  });

  debug("prompt-assembled", {
    threadId: request.threadId,
    systemMessageLength: assembled.systemMessage.length,
    messageCount: assembled.messages.length,
    ...(seams.assembleDebugFields ? seams.assembleDebugFields(context) : {}),
    ...(assembled.compactionSummary ? { compaction: assembled.compactionSummary } : {}),
  });

  // ── 7. Build the tool set (kind-owned) ──
  const tools: ToolSet = seams.buildTools({
    thread,
    request,
    kindContext: context,
    agentProfile,
    assembled,
  });

  // ── 8. Resolve the model + start streaming ──
  const providerFetch = await resolveProviderFetchForProfile(effectiveProfile);
  const aiModel = deps.resolveModel(effectiveProfile, modelName, providerFetch);

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
      // TAG-5 split-turn (style B): a question turn ENDS on the ask_user call.
      // The SDK ships the exact primitive — `hasToolCall(name)` stops the loop
      // when the latest step contains that tool call. The tool still EXECUTES —
      // its awaiting marker streams to the client and persists via persistTurn
      // — then the loop halts and the turn finishes normally (a finish event,
      // never an error). The user's answer arrives later as a NEW stream
      // request in `answer` mode, which rewrites the marker row (step 4).
      stopWhen: [isStepCount(seams.limits.toolLoopCeiling), hasToolCall("ask_user")],
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
  const segments: AgentTurnSegment[] = [];
  const appendTextDelta = (delta: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === "text") last.text += delta;
    else segments.push({ kind: "text", text: delta });
  };

  try {
    for await (const chunk of mapped as AsyncIterable<ProviderStreamChunk>) {
      if (signal?.aborted) {
        yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
        await persistTurn(deps.store, request.threadId, segments);
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
        // Replay metadata (Gemini 3 thoughtSignature, aggregator per-call
        // metadata) rides `chunk.providerOptions` — carried onto the segment
        // when present; absent stays absent (never an empty object), so a
        // resumed turn can send the call back signed.
        segments.push({
          kind: "toolCall",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: chunk.args,
          ...(chunk.providerOptions ? { providerOptions: chunk.providerOptions } : {}),
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
      // but they are informational and the agent frontend has no separate use
      // for them yet, so they are intentionally NOT forwarded here.
    }
  } catch (err) {
    if (signal?.aborted) {
      yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
      await persistTurn(deps.store, request.threadId, segments);
      return;
    }
    const message = extractProviderErrorMessage(err);
    const category = classifyProviderError(err);
    debug("provider-error", { threadId: request.threadId, message, category });
    yield { event: "error", data: JSON.stringify({ message, category }) };
    // Still persist whatever was accumulated so far (partial turn).
    await persistTurn(deps.store, request.threadId, segments);
    return;
  }

  if (signal?.aborted) {
    yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
    await persistTurn(deps.store, request.threadId, segments);
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

  await persistTurn(deps.store, request.threadId, segments);

  if (reasoningAccumulator) {
    yield { event: "reasoning-done", data: JSON.stringify({}) };
  }

  // ── Context metrics (CM-4) ─────────────────────────────────────────────────
  // Built by the extracted CM-4 helper (estimate-vs-provider honesty there);
  // persisting is best-effort here — a failure logs and never fails the turn.
  const contextMetrics = buildContextMetrics({
    traceSteps: mappedState.providerResponse.steps,
    usage,
    tokenAccounting: assembled.tokenAccounting,
    limits: seams.limits,
  });
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
  // persisted. Deliberately NOT awaited — the compaction service runs under
  // its own per-thread lock and must never block or fail the stream.
  void deps.autoCompact?.(request.threadId);

  yield {
    event: "finish",
    data: JSON.stringify({ finishReason, usage, modelId: modelName, metrics: contextMetrics }),
  };
}
