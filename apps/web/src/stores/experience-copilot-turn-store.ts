import { create } from "zustand";
import {
  experienceCopilotToolOutputSchema,
  coauthorSkillReadOutputSchema,
  type ExperienceCopilotTarget,
} from "@vibe-tavern/api-contracts";
import type { AppMessage } from "../api/types.js";

/**
 * Experience-Copilot turn store (ER-8) — ephemeral, per-thread accumulation of
 * the active copilot turn's tool calls, fed by the tool SSE events parsed in
 * `sse-parser.ts` (already generic over tool events) and wired at the Wave 2
 * stream endpoint's client (ER-10b).
 *
 * WHY A SEPARATE STORE (not the script/visual draft stores): live tool events
 * arrive before their assistant/tool message rows are committed, while the
 * reviewing overlay needs a stable turn-scoped proposal throughout generation
 * and after the turn-end snapshot refresh. Committed snapshots persist the
 * assistant tool calls and tool-result rows (and hydrate this same store on the
 * non-streaming path), but keeping the live accumulation outside the draft
 * stores still prevents a refresh from interrupting in-flight activity and gives
 * the apply aggregator (ER-9) one provider-neutral Apply source.
 *
 * Lifecycle: keyed by threadId → the LATEST turn's activities only (each turn
 * starts fresh). `clearTurn` is called at turn start (controller), on thread
 * switch, and on Apply/Reject (ER-9). Not persisted (no `persist` middleware).
 */

/** Lifecycle of a single tool call within an experience-copilot turn. */
export type ExperienceCopilotToolStatus = "streaming" | "done" | "error";

/**
 * One tool call's accumulated state. The `tool-result` event finalizes the
 * entry with the proposal fields (summary/proposed/target); earlier events
 * (tool-call/tool-input-start) populate a `streaming` placeholder so the card
 * can render "AI is editing…" while args stream.
 */
export interface ExperienceCopilotToolActivity {
  toolCallId: string;
  toolName: string;
  status: ExperienceCopilotToolStatus;
  /** Opaque tool-call args — the operation INPUT (edits / whole-buffer content
   * for `edit_buffer` / `write_buffer`). Captured from the streaming
   * `onToolCall` event and from the persisted assistant `toolCalls` entry on
   * reload, so a later operation card (ER-11) can render a scoped SEARCH/REPLACE
   * or buffer-write preview instead of only the cumulative `proposed`.
   * `undefined` for historical rows whose carrier assistant call is missing. */
  args?: unknown;
  /** From ExperienceCopilotToolOutput — populated on tool-result. */
  summary?: string;
  target?: ExperienceCopilotTarget;
  proposed?: string;
  /** Present iff this is a `read_skill_file` activity (the model read a skill
   *  file on demand). Read activities carry NO `target`/`proposed`, so they
   *  never enter proposal aggregation (ER-9) — they render only as glanceable
   *  tool activity (the path read). */
  readPath?: string;
}

/** Selected-variant metadata is the real chat-snapshot wire shape. Some older
 * callers/tests still provide the same fields flattened on AppMessage, so keep
 * those as the first-choice compatibility source. */
function selectedVariant(message: AppMessage) {
  // `variants` is required on the current AppMessage wire type, but legacy
  // snapshots and lightweight callers may omit it; keep extraction total.
  const variants = message.variants ?? [];
  const selectedIndex = message.selectedVariantIndex;
  if (typeof selectedIndex === "number") {
    return variants.find((variant) => variant.variantIndex === selectedIndex)
      ?? variants[selectedIndex];
  }
  return variants.find((variant) => variant.isSelected);
}

function messageToolCalls(message: AppMessage) {
  if (message.toolCalls && message.toolCalls.length > 0) return message.toolCalls;
  return selectedVariant(message)?.toolCalls ?? [];
}

function messageToolCallId(message: AppMessage): string | null | undefined {
  return message.toolCallId ?? selectedVariant(message)?.toolCallId;
}

/**
 * Rebuild the latest turn's activities from a committed non-streaming response.
 * Streaming turns fill the same store incrementally through SSE callbacks;
 * non-streaming turns only expose tool results after snapshot commit.
 */
export function extractPersistedExperienceCopilotActivities(
  messages: ReadonlyArray<AppMessage>,
): ExperienceCopilotToolActivity[] {
  let latestUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  const turnMessages = messages.slice(latestUserIndex + 1);
  // Correlate each tool RESULT with its carrier assistant toolCall entry to
  // recover both the canonical tool name and the operation INPUT (args). A
  // result without a matching call (a malformed/historical row) still renders —
  // it just carries no name/args preview.
  const toolCallInfoById = new Map<string, { name: string; args: unknown }>();
  for (const message of turnMessages) {
    for (const toolCall of messageToolCalls(message)) {
      toolCallInfoById.set(toolCall.id, { name: toolCall.name, args: toolCall.args });
    }
  }

  const activities: ExperienceCopilotToolActivity[] = [];
  for (const message of turnMessages) {
    if (message.role !== "tool") continue;
    const toolCallId = messageToolCallId(message) ?? message.id;
    const info = toolCallInfoById.get(toolCallId);
    let rawOutput: unknown;
    try {
      rawOutput = JSON.parse(message.content);
    } catch (error) {
      rawOutput = { parseError: error instanceof Error ? error.message : String(error) };
    }
    // A read_skill_file result is {path, content} — NOT a proposal, so it must
    // not be flagged as an error (the proposal-schema parse below would).
    // Recognize it first so the card renders as a normal done read.
    if (info?.name === "read_skill_file") {
      const read = coauthorSkillReadOutputSchema.safeParse(rawOutput);
      activities.push({
        toolCallId,
        toolName: info.name,
        args: info.args,
        status: read.success ? "done" : "error",
        ...(read.success ? { readPath: read.data.path } : { summary: message.content }),
      });
      continue;
    }
    // A write_buffer/edit_buffer result is {target, proposed, summary} — a
    // PROPOSAL over one of the two named buffers. Parse it with the copilot
    // tool-output schema (no greetingIndex/isAdd — those are co-author-only).
    if (info?.name === "write_buffer" || info?.name === "edit_buffer") {
      const output = experienceCopilotToolOutputSchema.safeParse(rawOutput);
      activities.push({
        toolCallId,
        toolName: info.name,
        args: info.args,
        status: output.success ? "done" : "error",
        ...(output.success
          ? {
              summary: output.data.summary,
              target: output.data.target,
              proposed: output.data.proposed,
            }
          : { summary: message.content }),
      });
      continue;
    }
    // run_test / run_simulate / suggest_visual_binding — non-proposal results
    // (informational digests that never enter proposal aggregation). Render a
    // graceful done-with-raw-content card.
    activities.push({
      toolCallId,
      toolName: info?.name ?? "",
      args: info?.args,
      status: "done",
      summary: message.content,
    });
  }
  return activities;
}

interface ExperienceCopilotTurnState {
  turnsByThread: Record<string, ExperienceCopilotToolActivity[]>;
  /** Insert or merge (by toolCallId) an activity for a thread. */
  upsertActivity: (threadId: string, activity: ExperienceCopilotToolActivity) => void;
  /** Drop the active turn's activities for a thread (turn start / switch / Apply / Reject). */
  clearTurn: (threadId: string) => void;
  /** Read the activities for a thread (empty array if none). */
  getActivities: (threadId: string) => ExperienceCopilotToolActivity[];
}

export const useExperienceCopilotTurnStore = create<ExperienceCopilotTurnState>((set, get) => ({
  turnsByThread: {},
  upsertActivity: (threadId, activity) => {
    set((s) => {
      const list = s.turnsByThread[threadId] ?? [];
      const idx = list.findIndex((a) => a.toolCallId === activity.toolCallId);
      // Merge by index so a streaming placeholder is finalized in place by the
      // later tool-result event (preserves order; later fields win on conflict).
      const next =
        idx === -1
          ? [...list, activity]
          : list.map((a, i) => (i === idx ? { ...a, ...activity } : a));
      return { turnsByThread: { ...s.turnsByThread, [threadId]: next } };
    });
    // ER-10 wires draft persistence (experience-copilot-draft.ts) — not yet available.
  },
  clearTurn: (threadId) => {
    set((s) => {
      if (!s.turnsByThread[threadId]) return s;
      const next = { ...s.turnsByThread };
      delete next[threadId];
      return { turnsByThread: next };
    });
    // ER-10 wires draft persistence (experience-copilot-draft.ts) — not yet available.
  },
  getActivities: (threadId) => get().turnsByThread[threadId] ?? [],
}));

// Debug helper — mirrors the window.__ exposure pattern in chat-store /
// snapshot-store. Lets a live Playwright session (or the dev console) read the
// ephemeral turn store to diagnose "diffs not showing": if the accordion
// in the chat bubble AND the reviewing overlay are BOTH empty, the activity
// never reached this store (SSE/tool-result not parsed, or cleared), which
// localizes the bug above the render layer.
if (typeof window !== "undefined") {
  window.__useExperienceCopilotTurnStore = useExperienceCopilotTurnStore;
}
