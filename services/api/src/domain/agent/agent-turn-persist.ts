/**
 * Agent turn persistence (AGENT_SHELL_PLAN TF-3 + AGENT_SHELL_POLISH AP-28) —
 * the kind-agnostic mechanism that walks a finished (or aborted, or failed)
 * turn's recorded segments and writes the thread's message rows, plus the
 * per-turn reasoning capture that rides onto the first assistant row.
 * Extracted from `agent-stream.ts` when AP-28 pushed that file past the
 * arch-gate size cap (the ratchet's prescribed remedy: move the changed part
 * out, never trim).
 *
 * Same loop→sibling split as `agent-split-turn.ts` / `agent-regenerate.ts`:
 * the loop imports this module — never the reverse. Everything here is
 * structural; no kind imports, no buffer names, no tool names.
 */

import type { ToolCallPart } from "ai";
import type { AgentPersistedToolCall, AgentPersistedToolResult } from "./agent-split-turn.js";

// ─── The append seam ─────────────────────────────────────────────────────────

/** The `appendMessage` input shape turn persistence writes (user rows,
 *  assistant text rows, tool-call runs, tool-result rows). The loop's store
 *  contract accepts this shape without adapters. */
export interface AgentTurnAppendInput {
  role: string;
  content?: string;
  toolCallsJson?: string | null;
  toolCallId?: string | null;
  /** AP-28: the turn's reasoning, pinned on the FIRST assistant row the
   *  turn's persist pass writes; absent on every other row (and on turns
   *  without reasoning). */
  reasoning?: string | null;
  /** AP-28: summed per-burst reasoning elapsed ms (rides with `reasoning`). */
  reasoningDurationMs?: number | null;
}

/** Structural store subset turn persistence writes through — the loop's
 *  `AgentStreamStore.appendMessage` satisfies this without adapters (method
 *  syntax keeps param bivariance). */
export interface AgentTurnPersistStore {
  appendMessage(threadId: string, input: AgentTurnAppendInput): Promise<unknown>;
}

// ─── Turn reasoning capture (AP-28) ──────────────────────────────────────────

/** Mutable per-turn reasoning capture (AP-28): burst texts in arrival order
 *  plus the summed per-burst elapsed milliseconds. A burst opens on its first
 *  reasoning delta and closes on the first NON-reasoning chunk after it — or,
 *  when the turn ends while it is still open (abort / provider error / finish
 *  mid-reasoning), at persist time, so that elapsed still counts. Kept beside
 *  (not derived from) the loop's flat `reasoningAccumulator`: the SSE relay
 *  needs the flat text, persistence needs the burst split, and the split is
 *  exactly what the flat string cannot recover. */
export interface AgentReasoningCapture {
  bursts: string[];
  openText: string;
  openStartMs: number | null;
  durationMs: number;
}

export function createReasoningCapture(): AgentReasoningCapture {
  return { bursts: [], openText: "", openStartMs: null, durationMs: 0 };
}

/** A reasoning delta arrived: accumulate the text; open a burst when none is
 *  open (the clock starts at the burst's first delta, mirroring the RP loop). */
export function captureReasoningDelta(capture: AgentReasoningCapture, delta: string, nowMs: number): void {
  if (capture.openStartMs === null) capture.openStartMs = nowMs;
  capture.openText += delta;
}

/** A non-reasoning chunk arrived: close the open burst (if any). A burst that
 *  never received non-empty text commits nothing — there is no reasoning to
 *  persist and no duration to attribute it to. */
export function closeReasoningBurst(capture: AgentReasoningCapture, nowMs: number): void {
  if (capture.openStartMs === null) return;
  if (capture.openText) {
    capture.bursts.push(capture.openText);
    capture.durationMs += Math.max(0, nowMs - capture.openStartMs);
  }
  capture.openText = "";
  capture.openStartMs = null;
}

/** The finalized (text, durationMs) pair for persistence: closes a still-open
 *  burst first (a turn that dies mid-reasoning still counts its elapsed so
 *  far). Null when the turn produced no reasoning. */
export function finalizeReasoningCapture(
  capture: AgentReasoningCapture,
  nowMs: number,
): { text: string; durationMs: number } | null {
  closeReasoningBurst(capture, nowMs);
  if (capture.bursts.length === 0) return null;
  return { text: capture.bursts.join("\n\n"), durationMs: capture.durationMs };
}

// ─── Turn persistence (TF-3) ─────────────────────────────────────────────────

/** One chronologically ordered piece of the assistant turn (TF-3). The stream
 *  loop records segments in arrival order; persistTurn walks them so stored
 *  rows preserve the model's text → tool-call → tool-result → text sequence
 *  (the old accumulator flattened the whole turn into tool rows + ONE final
 *  text row, losing the interleaving). */
export type AgentTurnSegment =
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
 *  ordered by createdAt).
 *
 *  AP-28: the turn's reasoning rides onto the FIRST assistant row this walk
 *  writes — text row or tool-call row, whichever comes first — as the
 *  (text, durationMs) pair the capture finalized (nulls on every other row,
 *  and on the whole turn when no reasoning arrived). */
export async function persistTurn(
  store: AgentTurnPersistStore,
  threadId: string,
  segments: readonly AgentTurnSegment[],
  reasoning: AgentReasoningCapture,
  nowMs: () => number,
): Promise<void> {
  const reasoningPayload = finalizeReasoningCapture(reasoning, nowMs());
  let reasoningAttached = false;
  const appendRow = (input: AgentTurnAppendInput) => {
    let row = input;
    if (reasoningPayload !== null && !reasoningAttached && input.role === "assistant") {
      reasoningAttached = true;
      row = { ...input, reasoning: reasoningPayload.text, reasoningDurationMs: reasoningPayload.durationMs };
    }
    return store.appendMessage(threadId, row);
  };

  let pendingToolCalls: AgentPersistedToolCall[] = [];
  const flushToolCalls = async () => {
    if (pendingToolCalls.length === 0) return;
    const persisted = pendingToolCalls;
    pendingToolCalls = [];
    await appendRow({
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
      await appendRow({
        role: "tool",
        content: JSON.stringify(payload),
        toolCallId: seg.toolCallId,
      });
    } else if (seg.text.trim()) {
      // Assistant text (the model's explanation), only when non-empty — a
      // whitespace-only segment stays unpersisted, same as the old accumulator.
      await appendRow({
        role: "assistant",
        content: seg.text,
      });
    }
  }
  await flushToolCalls();
}
