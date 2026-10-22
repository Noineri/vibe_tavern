/**
 * The split-turn mechanism (TAG-5 ask_user, generalized to "waits for the
 * user" tools by SIDECHAT_PLAN Wave 5b / SC-23e) — extracted from
 * `agent-stream.ts` verbatim-where-touched (extraction, never squeezing: the
 * loop file was over its size cap). This module owns everything the
 * split-turn contract needs below the kind seams:
 *
 * - the persisted tool row shapes (`AgentPersistedToolCall` / `AgentPersistedToolResult`)
 *   the marker rows round-trip through;
 * - the ANSWER request shapes — the ask answer (TAG-5: `text` / `skipped`)
 *   and, since SC-23e, the permission decision (`decision: "allow" | "deny"`);
 * - the awaiting-marker detection for both families and the model-visible
 *   WIRE rendering of wait-tool results (a stored marker is structured state
 *   for the UI — the model reads the same facts through self-describing keys,
 *   never the marker JSON, so a dangling promise never reaches the prompt);
 * - the answer APPLICATION step the loop calls in place of its old inline
 *   block: validate the referenced row is still awaiting IN THIS THREAD,
 *   rewrite it (ask → answered/skipped; permission deny → `{ status:
 *   "denied" }`; permission allow → the kind's wait-tool executor re-run with
 *   the ORIGINAL tool-call input, its real result stored).
 *
 * Kind-agnostic by construction: no kind imports, no tool names beyond the
 * pre-existing `ask_user` literal (whose handling is byte-identical to the
 * pre-extraction code). The permission family dispatches entirely on the
 * stored marker's `status` vocabulary this module defines; WHICH tools a kind
 * stops on is the kind's `waitToolNames` seam (see `agent-stream.ts`).
 */

import { hasToolCall } from "ai";
import type { ToolCallPart, StopCondition, ToolSet } from "ai";
import { validation } from "../../shared/errors.js";

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

// ─── The answer request shapes ───────────────────────────────────────────────

/** Answer to a pending `ask_user` question (TAG-5 split-turn, style B): the
 *  continuation turn runs with NO new user row — the answer is persisted as
 *  the answered ask tool-result instead. Wire twin of the ask member of the
 *  api-contracts `experienceCopilotStreamAnswerSchema`. */
export interface AgentAskTurnAnswer {
  readonly toolCallId: string;
  readonly text?: string;
  readonly skipped?: boolean;
}

/** Permission decision for a pending wait-tool marker (SC-23e split-turn):
 *  `allow` re-runs the tool's granted execution (through the kind's
 *  `runWaitTool` seam) and stores its REAL result in the awaiting row;
 *  `deny` stores the denied marker. Wire twin of the permission member of the
 *  api-contracts `experienceCopilotStreamAnswerSchema`. */
export interface AgentPermissionTurnAnswer {
  readonly toolCallId: string;
  readonly decision: "allow" | "deny";
}

/** Answer to a pending wait-tool request — the ask family or the permission
 *  family, discriminated by shape (`decision` present ⇒ permission). */
export type AgentTurnAnswer = AgentAskTurnAnswer | AgentPermissionTurnAnswer;

/** The kind-agnostic default stop condition: `ask_user` alone, so the kinds
 *  that predate SC-23e (experience, script) keep their exact legacy
 *  `stopWhen`. */
export const DEFAULT_WAIT_STOP_CONDITIONS: readonly StopCondition<ToolSet>[] = [
  hasToolCall("ask_user"),
];

/** SC-23e: the permission family's stop condition — the turn stops on the
 *  AWAITING MARKER, not on the call: a `read_message_prompt`-family tool that
 *  answers `unknown_prompt` / `unresolved` does NOT stop the turn, because
 *  there is nothing to ask the user — the model relays that answer itself in
 *  the same turn. Mirrors the SDK's `hasToolCall` access pattern (the latest
 *  step) but reads `toolResults`, matching the tool's own output against the
 *  awaiting status the mechanism defines. */
export function hasAwaitingPermissionMarker(
  toolName: string,
): StopCondition<ToolSet> {
  return ({ steps }) => {
    const last = steps[steps.length - 1];
    const results = last?.toolResults as
      | Array<{ toolName?: string; output?: unknown }>
      | undefined;
    if (results === undefined) return false;
    return results.some(
      (result) => result.toolName === toolName && permissionStatusOf(result.output) === "awaiting_permission",
    );
  };
}

// ─── Structural subsets (the loop's rows/store satisfy these) ────────────────

/** Structural view of a stored message row the answer application reads and
 *  rewrites — `agent-stream.ts`'s `AgentStreamStoredMessage` satisfies this
 *  without adapters; kept structural so this module imports nothing from the
 *  loop (the loop imports this module — never the reverse). */
export interface AgentSplitTurnMessageRow {
  role: string;
  content: string;
  toolCallId: string | null;
  toolCallsJson: string | null;
}

/** The store subset the answer rewrite needs (structural — the generic loop's
 *  `AgentStreamStore` satisfies this without adapters). */
export interface AgentSplitTurnStore {
  setToolResultOutput(
    threadId: string,
    toolCallId: string,
    payload: AgentPersistedToolResult,
  ): Promise<unknown>;
}

// ─── Marker detection ────────────────────────────────────────────────────────

/** Is this parsed tool-result output an awaiting `ask_user` marker? (TAG-5) */
function isAwaitingAskOutput(output: unknown): boolean {
  return (
    output !== null &&
    typeof output === "object" &&
    (output as { status?: unknown }).status === "awaiting_answer"
  );
}

/** The permission family's status vocabulary (SC-23e): the marker an
 *  executor returns to stop the turn, and the two outcomes an answer stores.
 *  These statuses belong to the SPLIT-TURN MECHANISM (the plan pins `deny →
 *  { status: "denied" }`), so dispatching on them here keeps the module
 *  kind-agnostic — only wait-tool executors emit them. */
type PermissionStatus = "awaiting_permission" | "granted" | "denied";

function permissionStatusOf(output: unknown): PermissionStatus | null {
  if (output === null || typeof output !== "object") return null;
  const status = (output as { status?: unknown }).status;
  return status === "awaiting_permission" || status === "granted" || status === "denied"
    ? status
    : null;
}

/** Parse a tool row's content into its persisted payload, or null when the
 *  row is not valid JSON (never throws — same defensiveness as the loop's
 *  history conversion). */
function parseToolResultRow(row: AgentSplitTurnMessageRow): AgentPersistedToolResult | null {
  try {
    const parsed = JSON.parse(row.content) as AgentPersistedToolResult;
    if (parsed === null || typeof parsed !== "object") return null;
    if (typeof parsed.toolName !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Is this stored message row an awaiting `ask_user` tool-result? (TAG-5 —
 *  the answer-mode precondition; parsed defensively, never throws.) */
function isAwaitingAskRow(m: AgentSplitTurnMessageRow): boolean {
  const parsed = parseToolResultRow(m);
  return parsed !== null && parsed.toolName === "ask_user" && isAwaitingAskOutput(parsed.output);
}

/** Is this stored message row an awaiting PERMISSION tool-result (any
 *  non-ask tool carrying the SC-23e marker — the permission answer-mode
 *  precondition; parsed defensively, never throws.) */
function isAwaitingPermissionRow(m: AgentSplitTurnMessageRow): boolean {
  const parsed = parseToolResultRow(m);
  return parsed !== null && parsed.toolName !== "ask_user" && permissionStatusOf(parsed.output) === "awaiting_permission";
}

/** The persisted tool-call row for one `toolCallId` (the permission allow
 *  re-runs the executor with the ORIGINAL input, so the call row must be
 *  found again among the assistant rows). Parsed defensively; null when no
 *  stored call carries the id. */
function findPersistedToolCall(
  messages: readonly AgentSplitTurnMessageRow[],
  toolCallId: string,
): AgentPersistedToolCall | null {
  for (const m of messages) {
    if (m.role !== "assistant" || m.toolCallsJson === null) continue;
    try {
      const parsed = JSON.parse(m.toolCallsJson) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const call of parsed) {
        const c = call as AgentPersistedToolCall;
        if (c !== null && typeof c === "object" && c.type === "tool-call" && c.toolCallId === toolCallId) {
          return c;
        }
      }
    } catch {
      // Invalid JSON — skip this row's tool calls.
    }
  }
  return null;
}

// ─── Model-visible wire rendering ────────────────────────────────────────────

/** Wire stringify GUARANTEEING the result parses to a non-null JSON object:
 *  objects pass through verbatim; any other value (a tool that persisted a
 *  primitive, a malformed ask payload) wraps under a `result` key. Translation
 *  proxies (agi → Google) build google.protobuf.Struct function responses from
 *  these strings — a bare string is a 400, an object passes. */
export function stringifyObjectWireText(output: unknown): string {
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

/** The model-visible wire JSON for a PERMISSION-family tool-result output
 *  (SC-23e) — the same stored-state-vs-wire-facts discipline as the ask
 *  family: the awaiting marker (the user moved on) → `{ unanswered: true,
 *  note }`; a granted result → `{ prompt, promptTokens }` (the material the
 *  user allowed, never the `granted` status enum); a denial →
 *  `{ denied: true }`. Any other output renders through the generic object
 *  guarantee. */
function renderPermissionOutputWireText(output: unknown): string {
  const status = permissionStatusOf(output);
  if (status === "awaiting_permission") {
    return JSON.stringify({ unanswered: true, note: "the user did not answer this permission request; they moved on" });
  }
  if (status === "granted" && output !== null && typeof output === "object") {
    const record = output as { prompt?: unknown; promptTokens?: unknown };
    if (typeof record.prompt === "string") {
      return JSON.stringify({
        prompt: record.prompt,
        ...(typeof record.promptTokens === "number" ? { promptTokens: record.promptTokens } : {}),
      });
    }
  }
  if (status === "denied") return JSON.stringify({ denied: true });
  return stringifyObjectWireText(output);
}

/** The model-visible wire JSON for ANY wait-tool result, or undefined when
 *  the tool is not a wait tool (the caller keeps the generic object wire).
 *  The ask family dispatches on the tool name exactly as before SC-23e; the
 *  permission family dispatches on the marker status vocabulary the
 *  mechanism owns, so no kind's tool name is known here. */
export function renderWaitToolOutputWireText(toolName: string, output: unknown): string | undefined {
  if (toolName === "ask_user") return renderAskOutputWireText(output);
  if (permissionStatusOf(output) !== null) return renderPermissionOutputWireText(output);
  return undefined;
}

// ─── The answer application step (the loop's turn-input branch) ─────────────

/** The kind's granted-execution seam for one wait tool (SC-23e): re-run the
 *  tool's REAL execution for an allowed request and return the result the
 *  row stores. Throws for a tool the kind does not serve. */
export type RunWaitTool = (
  toolName: string,
  toolInput: unknown,
  toolCallId: string,
) => Promise<unknown>;

/**
 * Apply the request's answer to the thread (TAG-5, generalized by SC-23e):
 * validate the referenced tool-result row is still awaiting IN THIS THREAD,
 * rewrite it with the answer's payload, and mutate the in-memory row copy so
 * THIS turn's assembly sees the answered state without a re-fetch (the store
 * row is the durable copy). The ask family is byte-identical to the
 * pre-extraction loop branch; the permission family adds the executor re-run.
 *
 * @throws {@link validation} when the referenced row is not a still-awaiting
 *   marker of the answer's family in this thread (a stale or foreign
 *   toolCallId can never overwrite another tool's result), when an allowed
 *   call's original tool-call row is gone, or when the kind wired no
 *   wait-tool executor for an allow.
 */
export async function applyAgentTurnAnswer(input: {
  readonly threadId: string;
  readonly answer: AgentTurnAnswer;
  readonly priorMessages: readonly AgentSplitTurnMessageRow[];
  readonly store: AgentSplitTurnStore;
  readonly runWaitTool?: RunWaitTool;
}): Promise<void> {
  const { answer } = input;
  const target = input.priorMessages.find(
    (m) => m.role === "tool" && m.toolCallId === answer.toolCallId,
  );

  if ("decision" in answer) {
    // ── SC-23e permission answer ──
    if (!target || !isAwaitingPermissionRow(target)) {
      throw validation(
        "The permission request being answered was not found (or is no longer awaiting) in this thread.",
      );
    }
    const rowToolName = parseToolResultRow(target)!.toolName;
    let output: unknown;
    if (answer.decision === "deny") {
      output = { status: "denied" };
    } else {
      const toolCall = findPersistedToolCall(input.priorMessages, answer.toolCallId);
      if (toolCall === null) {
        throw validation(
          "The allowed tool call was not found in this thread — its recorded input cannot be re-run.",
        );
      }
      if (input.runWaitTool === undefined) {
        throw validation(
          "This thread's kind serves no permission tools (no wait-tool executor is wired).",
        );
      }
      output = await input.runWaitTool(rowToolName, toolCall.input, answer.toolCallId);
    }
    const answerPayload: AgentPersistedToolResult = { toolName: rowToolName, output };
    await input.store.setToolResultOutput(input.threadId, answer.toolCallId, answerPayload);
    // Rewrite the in-memory copy so THIS turn's assembly sees the resolved
    // state without a re-fetch (the store row is the durable copy).
    target.content = JSON.stringify(answerPayload);
    return;
  }

  // ── TAG-5 ask answer (byte-identical to the pre-extraction branch) ──
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
  await input.store.setToolResultOutput(input.threadId, answer.toolCallId, answerPayload);
  target.content = JSON.stringify(answerPayload);
}
