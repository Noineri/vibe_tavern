/**
 * Generic agent turn stream (AGENT_SHELL_PLAN, Wave 1 / AS-2c) — the
 * kind-AGNOSTIC streaming loop carved out of `experience-copilot-stream.ts`
 * (ER-6): thread load, turn-input persistence (content mode + the wait-tool
 * answer-mode marker rewrite — the split-turn mechanism itself lives in the
 * sibling `agent-split-turn.ts` since SC-23e), digest-boundary pre-split, provider
 * stream consumption via `streamText`, the SSE event relay (`text-delta`,
 * `reasoning-delta`, `tool-call`, `tool-result`, `finish`, `error`, `abort`),
 * TF-3 ordered turn persistence, AP-28 turn-reasoning persistence (the turn's
 * reasoning rides onto the first assistant row the turn writes), CM-4 context
 * metrics, and the CM-6 fire-and-forget auto-compaction trigger. Everything KIND-SPECIFIC — context
 * loading, agent-profile resolution, prompt assembly, tool-set building — is
 * injected through {@link AgentStreamSeams}; the experience wiring in the old
 * module supplies them (a second kind's turn runs the same loop with its own
 * assembly + tools).
 *
 * Same seams pattern as `AgentCompactionSeams` (AS-2b): the mechanism lives
 * here, the knowledge lives in the kind. This file must stay free of kind
 * knowledge — no kind imports, no buffer names in code.
 */

import { streamText, isStepCount } from "ai";
import type { LanguageModel, ModelMessage, AssistantContent, ToolCallPart, ToolResultPart, StopCondition } from "ai";
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
import { promptVisibleAttachments, type Attachment, type AttachmentPatch } from "@vibe-tavern/domain";
import { prepareAgentModelMessages, type AgentVisionAssets } from "./agent-attachments.js";
import { resolveDigestBoundary, type AgentHistoryMessage } from "./agent-prompt.js";
import {
  applyAgentTurnAnswer,
  DEFAULT_WAIT_STOP_CONDITIONS,
  renderWaitToolOutputWireText,
  stringifyObjectWireText,
  type AgentPersistedToolCall,
  type AgentPersistedToolResult,
  type AgentTurnAnswer,
} from "./agent-split-turn.js";
import { applyAgentTurnRegenerate, type AgentTurnDeleteTurn } from "./agent-regenerate.js";
import {
  persistTurn,
  createReasoningCapture,
  captureReasoningDelta,
  closeReasoningBurst,
  type AgentTurnAppendInput,
  type AgentTurnSegment,
} from "./agent-turn-persist.js";

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
  attachments?: Attachment[];
  toolCallId: string | null;
  toolCallsJson: string | null;
}

/** The `appendMessage` input shape the loop writes (user rows, assistant text
 *  rows, tool-call runs, tool-result rows) — owned by the turn-persist sibling
 *  (`agent-turn-persist.ts`) since AP-28; aliased here so the loop's store
 *  contract reads one vocabulary. */
export type AgentStreamAppendInput = AgentTurnAppendInput;

/** Structural store subset the generic loop needs (method syntax keeps param
 *  bivariance, so the concrete per-kind store satisfies this without
 *  adapters). */
export interface AgentStreamStore<THREAD extends AgentStreamThread = AgentStreamThread> {
  getById(threadId: string): Promise<THREAD | null>;
  listMessages(threadId: string): Promise<readonly AgentStreamStoredMessage[]>;
  appendMessage(threadId: string, input: AgentTurnAppendInput): Promise<unknown>;
  updateMessageAttachment?(messageId: string, attachmentId: string, patch: AttachmentPatch): Promise<Attachment | null>;
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

/** Answer to a pending wait-tool request (TAG-5 ask_user; the SC-23e
 *  permission decision family) — {@link AgentTurnAnswer} in the split-turn
 *  module, where the mechanism lives. */

/** The turn request fields the generic loop reads itself; the kind's own
 *  request interface EXTENDS this (extra fields ride along opaquely into the
 *  seams). */
export interface AgentTurnRequest {
  readonly threadId: string;
  readonly content?: string;
  readonly attachments?: Attachment[];
  readonly answer?: AgentTurnAnswer;
  /** AP-9 regenerate mode: rerun the last turn with NO new user row — the
   *  loop trims the replaced turn's rows (through the deletion seam below)
   *  before the history/context load and appends no input row. Exactly one
   *  of `content` / `answer` / `regenerate` is present (wire-enforced; the
   *  input branch also guards direct domain callers). */
  readonly regenerate?: boolean;
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
  readonly resolveVisionAssets?: (profile: ProviderProfile) => Promise<AgentVisionAssets>;
  /** The AI SDK streaming function. Defaults to the real `streamText` from "ai".
   *  Injectable so tests substitute a fake WITHOUT `mock.module("ai")` — under
   *  bun:test that mock is process-global and permanent. */
  readonly streamText?: typeof streamText;
  /** AP-28: the wall clock (ms) the reasoning-burst durations are measured
   *  against. Defaults to `Date.now` (the RP loop's convention); injectable so
   *  tests drive deterministic durations without sleeps. */
  readonly nowMs?: () => number;
  /** CM-6 fire-and-forget auto-compaction trigger, called AFTER the turn's
   *  metrics are persisted. Never awaited; absent → no auto-compaction. */
  readonly autoCompact?: (threadId: string) => Promise<void>;
  /** AP-9: the thread's row-deletion seam — the AP-8 store sibling
   *  (`deleteCopilotTurn`) over the real db, supplied by each kind's wiring
   *  (the ONE row-deletion path; the regenerate mechanism never deletes rows
   *  on its own). Absent (tests, legacy harnesses) → regenerate mode is
   *  refused by the sibling, never silently trimmed. */
  readonly deleteTurn?: AgentTurnDeleteTurn;
}

// ─── Assembled-prompt shape (seam result) ────────────────────────────────────

/** One message in a kind's assembled prompt (system + compacted history) —
 *  the shape the generic `toModelMessages` fold consumes. */
export type AgentPromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; attachments?: Attachment[] }
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
  /** SC-23e: the kind's wait-tool stop conditions — the stopWhen entries
   *  beside the tool-loop ceiling. Absent → the mechanism default
   *  (`hasToolCall("ask_user")` alone), so the pre-SC-23e kinds keep their
   *  exact legacy stop behavior. A kind with a permission tool composes its
   *  own entries from the mechanism's condition helpers (the marker-aware
   *  `hasAwaitingPermissionMarker` — the turn stops on the AWAITING MARKER,
   *  never on a call that answers unknown). */
  readonly waitStopConditions?: readonly StopCondition<ToolSet>[];
  /** SC-23e: the kind's granted-execution seam — re-run one wait tool's REAL
   *  execution when the user allows its permission request, returning the
   *  result the awaiting row stores. Called with the loop's loaded THREAD row
   * (chat-owned ids come from the row, never the request) plus the tool's
   * name, its ORIGINAL recorded input, and the toolCallId. Absent → the kind
   * serves no permission tools; an allow answer is refused by the split-turn
   * module, never silently skipped. */
  readonly runWaitTool?: (
    thread: THREAD,
    toolName: string,
    toolInput: unknown,
    toolCallId: string,
  ) => Promise<unknown>;
}

// ─── History conversion (store ↔ prompt ↔ SDK) ───────────────────────────────

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
        // TAG-5 + SC-23e: a WAIT tool's result carries the CONVERSATION or
        // the user's permission decision, not telemetry — the model reads
        // the answer / skip / never-answered note / prompt / denial through
        // self-describing keys, never the marker JSON (the whole wire string
        // parses to a JSON object — Struct contract for translation proxies).
        const waitWireText = renderWaitToolOutputWireText(toolName, parsed.output);
        if (waitWireText !== undefined) outputText = waitWireText;
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
    const msg: Extract<AgentHistoryMessage, { role: "user" | "assistant" }> = {
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    };
    if (msg.role === "user") {
      const attachments = promptVisibleAttachments(m.attachments ?? []);
      if (attachments.length) msg.attachments = attachments;
    }
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

// ─── Turn persistence (TF-3) lives in the sibling `agent-turn-persist.ts` ────
// (AP-28 extraction: the segment vocabulary + the persist walk + the reasoning
// capture moved out when this file hit the arch-gate size cap; the loop below
// records segments, feeds the capture, and calls `persistTurn`.)

// ─── The generic turn loop ───────────────────────────────────────────────────

/** Content mode includes an attachment-only user turn (CA-4b1). */
export function isAgentContentTurn(request: Pick<AgentTurnRequest, "content" | "attachments">): boolean {
  return request.content !== undefined || Boolean(request.attachments?.length);
}

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

  // ── 2. Resolve provider + model ──
  // (Runs BEFORE the history/context load since AP-9: the regenerate trim
  // below is a destructive write and, exactly like content mode's input
  // persistence, must never happen for a request whose provider inputs do
  // not resolve. The two loads are independent — swapping them is
  // behavior-neutral for the other modes' success paths.)
  const profile = await deps.getProviderProfile(request.providerProfileId);
  if (!profile) {
    throw notFound("ProviderProfile", `Provider profile '${request.providerProfileId}' was not found.`);
  }
  const modelName = request.model ?? profile.defaultModel ?? "gpt-4o-mini";
  const effectiveProfile = await deps.getEffectiveProviderProfile(request.providerProfileId, modelName);

  // ── 3. AP-9 regenerate: trim the replaced turn BEFORE the loads ──
  // The regenerated turn's input is the thread state as-is: the rows after
  // the thread's last user row (the replaced turn's own rows) are deleted
  // through the AP-8 store sibling, the user row stays (it is the input the
  // rerun runs against). The trim must precede the load below — this turn's
  // history, the sidechat's merged-timeline counts, and its per-turn RP sync
  // (a fresh rp_sync for RP written since the replaced answer) must all see
  // the trimmed rows. Resolution and every refusal (the digest floor, the
  // failed-turn shape, an empty thread) live in the sibling module.
  if (request.regenerate === true) {
    await applyAgentTurnRegenerate({
      threadId: request.threadId,
      listMessages: () => deps.store.listMessages(request.threadId),
      ...(deps.deleteTurn !== undefined ? { deleteTurn: deps.deleteTurn } : {}),
    });
  }

  // ── 4. Load history (prior turns) + the kind context ──
  const [priorMessages, context] = await Promise.all([
    deps.store.listMessages(request.threadId),
    seams.loadContext(thread),
  ]);

  // ── 5. Persist this turn's input ──
  // Content mode: append the user's message row NOW so it survives a crash.
  // Answer mode (TAG-5 split-turn, style B; the permission family since
  // SC-23e): NO user row — the answer replaces the awaiting marker of the
  // referenced wait-tool result row, and the turn resumes as a continuation
  // of the stopped turn. The application (validation against THIS thread's
  // rows, the row rewrite, and the permission allow's executor re-run) lives
  // in the split-turn module; the rewrite is validated first (the row must
  // still be awaiting in THIS thread) so a stale or foreign toolCallId can
  // never overwrite another tool's result.
  let appendedUserRow: unknown;
  if (request.answer) {
    await applyAgentTurnAnswer({
      threadId: request.threadId,
      answer: request.answer,
      priorMessages,
      store: deps.store,
      // SC-23e: the permission allow re-runs the tool's granted execution
      // through the KIND's executor seam (absent → the kind serves no
      // permission tools and an allow is refused there, never silently
      // skipped).
      ...(seams.runWaitTool !== undefined
        ? {
            runWaitTool: (toolName: string, toolInput: unknown, toolCallId: string) =>
              seams.runWaitTool!(thread, toolName, toolInput, toolCallId),
          }
        : {}),
    });
  } else if (isAgentContentTurn(request)) {
    appendedUserRow = await deps.store.appendMessage(request.threadId, {
      role: "user",
      content: request.content ?? "",
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
    });
  } else if (request.regenerate === true) {
    // AP-9 regenerate mode: NO input row — the trimmed thread state (the
    // last user row + the surviving context) IS the turn's input, exactly
    // like answer mode pushes nothing. The trim already ran in step 3.
  } else {
    // The wire schema enforces exactly-one-of content/answer/regenerate;
    // this guards direct domain callers (tests, future internal callers).
    throw validation("A copilot turn requires either `content`, `answer`, or `regenerate`.");
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

  // ── 6. Resolve the kind's agent profile (base prompt + tools + budget) ──
  const agentProfile = await seams.resolveProfile(thread);

  // ── 7. Assemble the prompt (kind-owned) ──
  // Content mode: the new user message is appended to the prior history for
  // assembly; it was NOT in priorHistory (which is the pre-turn stored set).
  // Answer mode (TAG-5) and regenerate mode (AP-9): NO user message is pushed
  // — answer mode's history already ends with the answered tool-result (the
  // turn's input), regenerate's ends with the surviving user row.
  const visibleAttachments = promptVisibleAttachments(request.attachments ?? []);
  const history: AgentHistoryMessage[] = isAgentContentTurn(request)
    ? [...priorHistory, { role: "user", content: request.content ?? "", ...(visibleAttachments.length ? { attachments: visibleAttachments } : {}) }]
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

  // ── 8. Build the tool set (kind-owned) ──
  const tools: ToolSet = seams.buildTools({
    thread,
    request,
    kindContext: context,
    agentProfile,
    assembled,
  });

  // ── 9. Resolve the model + start streaming ──
  const providerFetch = await resolveProviderFetchForProfile(effectiveProfile);
  const aiModel = deps.resolveModel(effectiveProfile, modelName, providerFetch);

  const stream = deps.streamText ?? streamText;
  let result: ReturnType<typeof streamText>;
  try {
    const modelMessages = await prepareAgentModelMessages(assembled.messages, {
      profile: effectiveProfile, model: modelName, store: deps.store, priorMessages,
      appendedRow: appendedUserRow, currentAttachments: request.attachments,
      resolveVisionAssets: deps.resolveVisionAssets, providerFetch, signal, convert: toModelMessages,
    });
    result = stream({
      model: aiModel,
      messages: modelMessages,
      allowSystemInMessages: true,
      abortSignal: signal,
      tools,
      // TAG-5 split-turn (style B), generalized by SC-23e: a turn ENDS on a
      // "waits for the user" tool — the kind's stop conditions (absent →
      // the mechanism default, `ask_user` alone, so the pre-SC-23e kinds keep
      // their byte-identical legacy stop). The SDK ships the exact
      // primitives — `hasToolCall(name)` for the ask family, the marker-aware
      // condition for the permission family (stops on the AWAITING marker,
      // never on a call that answers unknown). The tool still EXECUTES — its
      // awaiting marker streams to the client and persists via persistTurn —
      // then the loop halts and the turn finishes normally (a finish event,
      // never an error). The user's decision arrives later as a NEW stream
      // request in `answer` mode, which rewrites the marker row (step 4).
      stopWhen: [
        isStepCount(seams.limits.toolLoopCeiling),
        ...(seams.waitStopConditions ?? DEFAULT_WAIT_STOP_CONDITIONS),
      ],
    });
  } catch (err) {
    // Setup error (streamText() failed before iteration began).
    const message = extractProviderErrorMessage(err);
    const category = classifyProviderError(err);
    debug("setup-error", { message, category });
    yield { event: "error", data: JSON.stringify({ message, category }) };
    return;
  }

  // ── 10. Normalize + drain the stream, emitting SSE events ──
  // `state.providerResponse.steps` collects PER-STEP usage from finish-step
  // parts — the metrics path reads the LAST step's input (see CM-4 block below).
  const { stream: mapped, state: mappedState } = createMappedStream(result.stream);

  let textAccumulator = "";
  let reasoningAccumulator = "";
  // AP-28: burst-aware twin of `reasoningAccumulator` (the capture lives in
  // the turn-persist sibling) — the flat accumulator keeps feeding the SSE
  // relay, the capture feeds persistence.
  const reasoningCapture = createReasoningCapture();
  const nowMs = deps.nowMs ?? Date.now;
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
        await persistTurn(deps.store, request.threadId, segments, reasoningCapture, nowMs);
        return;
      }
      // AP-28: a non-reasoning chunk closes the open reasoning burst (the
      // mapped stream drops SDK reasoning-start/end markers, so at this seam
      // "the first non-reasoning chunk" is exactly the burst's end).
      if (chunk.type !== "reasoning-delta" && reasoningCapture.openStartMs !== null) {
        closeReasoningBurst(reasoningCapture, nowMs());
      }
      if (chunk.type === "text-delta" && chunk.delta) {
        textAccumulator += chunk.delta;
        appendTextDelta(chunk.delta);
        yield { event: "text-delta", data: JSON.stringify({ delta: chunk.delta }) };
      } else if (chunk.type === "reasoning-delta") {
        reasoningAccumulator += chunk.textDelta;
        captureReasoningDelta(reasoningCapture, chunk.textDelta, nowMs());
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
      await persistTurn(deps.store, request.threadId, segments, reasoningCapture, nowMs);
      return;
    }
    const message = extractProviderErrorMessage(err);
    const category = classifyProviderError(err);
    debug("provider-error", { threadId: request.threadId, message, category });
    yield { event: "error", data: JSON.stringify({ message, category }) };
    // Still persist whatever was accumulated so far (partial turn).
    await persistTurn(deps.store, request.threadId, segments, reasoningCapture, nowMs);
    return;
  }

  if (signal?.aborted) {
    yield { event: "abort", data: JSON.stringify({ partialLength: textAccumulator.length }) };
    await persistTurn(deps.store, request.threadId, segments, reasoningCapture, nowMs);
    return;
  }

  // ── 11. Finalize: resolve finish metadata + persist the turn ──
  let finishReason = "stop";
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  try {
    const finish = await mapFinish(result, signal);
    finishReason = finish.finishReason;
    usage = finish.usage;
  } catch {
    finishReason = "error";
  }

  await persistTurn(deps.store, request.threadId, segments, reasoningCapture, nowMs);

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
