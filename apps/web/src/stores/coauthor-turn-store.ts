import { create } from "zustand";
import { coauthorToolOutputSchema, coauthorSkillReadOutputSchema, type CoauthorTarget } from "@vibe-tavern/api-contracts";
import type { AppMessage } from "../api/types.js";
// CA-15: persistence of unapplied proposals across reloads. Imported here (not
// subscribed) so the two resolution points — finalize (upsert) and discard
// (clear) — are the ONLY places persistence is touched. The import forms a
// module cycle (coauthor-draft.ts imports useCoauthorTurnStore), but both
// sides use each other's bindings only INSIDE function bodies (never at module
// eval), so ESM live bindings resolve them lazily after both modules load.
import { saveDraft, clearDraft } from "../lib/coauthor-draft.js";

/**
 * Co-Author turn store (CA-9.2) — ephemeral, per-chat accumulation of the
 * active co-author turn's tool calls, fed by the tool SSE events parsed in
 * `sse-parser.ts` (CA-9.1) and wired in `use-chat-controller.executeStreamAction`.
 *
 * WHY A SEPARATE STORE (not chat-store generation state): live tool events
 * arrive before their assistant/tool message rows are committed, while the
 * Reviewing overlay needs a stable turn-scoped proposal throughout generation
 * and after the turn-end snapshot refresh. Committed snapshots now persist the
 * assistant tool calls and tool-result rows (and hydrate this same store on the
 * non-streaming path), but keeping the live accumulation outside snapshot-store
 * still prevents a refresh from interrupting in-flight activity and gives CA-11
 * one provider-neutral Apply source.
 *
 * Lifecycle: keyed by chatId → the LATEST turn's activities only (each turn
 * starts fresh). `clearTurn` is called at turn start (controller), on chat
 * switch, and on Apply/Reject (CA-11). Not persisted (no `persist` middleware).
 */

/** Lifecycle of a single tool call within a co-author turn. */
export type CoauthorToolStatus = "streaming" | "done" | "error";

/**
 * One tool call's accumulated state. The `tool-result` event finalizes the
 * entry with the proposal fields (summary/proposed/target/...); earlier events
 * (tool-call/tool-input-start) populate a `streaming` placeholder so the card
 * can render "AI is editing…" while args stream.
 */
export interface CoauthorToolActivity {
  toolCallId: string;
  toolName: string;
  status: CoauthorToolStatus;
  /** Opaque tool-call args — the operation INPUT (edits / content / profileMd /
   * index+content for greetings). Captured from the streaming `onToolCall` event
   * and from the persisted assistant `toolCalls` entry on reload, so a later
   * operation card (CED-6) can render a scoped SEARCH/REPLACE or section-write
   * preview instead of only the cumulative `proposed`. `undefined` for
   * historical rows whose carrier assistant call is missing. */
  args?: unknown;
  /** From CoauthorToolOutput — populated on tool-result. */
  summary?: string;
  target?: CoauthorTarget;
  proposed?: string;
  greetingIndex?: number;
  isAdd?: boolean;
  /** CTX-S6: present iff this is a `read_skill_file` activity (the model read a
   *  skill file on demand). Read activities carry NO `target`/`proposed`, so
   *  they never enter proposal aggregation and are not persisted as drafts —
   *  they render only as glanceable tool activity (the path read). */
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
 * Rebuild the latest turn's proposals from a committed non-streaming response.
 * Streaming turns fill the same store incrementally through SSE callbacks;
 * non-streaming turns only expose tool results after snapshot commit.
 */
export function extractPersistedCoauthorActivities(
  messages: ReadonlyArray<AppMessage>,
): CoauthorToolActivity[] {
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
      // Legacy alias: `edit_profile` was renamed to `write_profile` (whole-
      // document write). Historical committed turns still carry the old name;
      // normalize on reload so the activity store always reflects the canonical
      // tool name the current label/render map expects.
      const name = toolCall.name === "edit_profile" ? "write_profile" : toolCall.name;
      toolCallInfoById.set(toolCall.id, { name, args: toolCall.args });
    }
  }

  const activities: CoauthorToolActivity[] = [];
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
    // CTX-S6: a read_skill_file result is {path, content} — NOT a proposal, so
    // it must not be flagged as an error (the proposal-schema parse below
    // would). Recognize it first so the card renders as a normal done read.
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
    const output = coauthorToolOutputSchema.safeParse(rawOutput);
    activities.push({
      toolCallId,
      toolName: info?.name ?? "",
      args: info?.args,
      status: output.success ? "done" : "error",
      ...(output.success
        ? {
            summary: output.data.summary,
            target: output.data.target,
            proposed: output.data.proposed,
            greetingIndex: output.data.greetingIndex,
            isAdd: output.data.isAdd,
          }
        : { summary: message.content }),
    });
  }
  return activities;
}

interface CoauthorTurnState {
  turnsByChat: Record<string, CoauthorToolActivity[]>;
  /** Insert or merge (by toolCallId) an activity for a chat. */
  upsertActivity: (chatId: string, activity: CoauthorToolActivity) => void;
  /** Drop the active turn's activities for a chat (turn start / switch / Apply / Reject). */
  clearTurn: (chatId: string) => void;
  /** Read the activities for a chat (empty array if none). */
  getActivities: (chatId: string) => CoauthorToolActivity[];
}

export const useCoauthorTurnStore = create<CoauthorTurnState>((set, get) => ({
  turnsByChat: {},
  upsertActivity: (chatId, activity) => {
    set((s) => {
      const list = s.turnsByChat[chatId] ?? [];
      const idx = list.findIndex((a) => a.toolCallId === activity.toolCallId);
      // Merge by index so a streaming placeholder is finalized in place by the
      // later tool-result event (preserves order; later fields win on conflict).
      const next =
        idx === -1
          ? [...list, activity]
          : list.map((a, i) => (i === idx ? { ...a, ...activity } : a));
      return { turnsByChat: { ...s.turnsByChat, [chatId]: next } };
    });
    // CA-15: keep the persisted draft in sync. saveDraft filters to the
    // finalized-proposed subset and is a guarded no-op without localStorage,
    // so this stays cheap during streaming (no finalized → removes an absent
    // key) and only writes once a proposal actually materializes.
    saveDraft(chatId, get().turnsByChat[chatId] ?? []);
  },
  clearTurn: (chatId) => {
    set((s) => {
      if (!s.turnsByChat[chatId]) return s;
      const next = { ...s.turnsByChat };
      delete next[chatId];
      return { turnsByChat: next };
    });
    // CA-15: a resolved/discarded proposal (Apply / Reject) or a fresh turn
    // start must also drop the persisted draft so it isn't rehydrated later.
    // No-op without localStorage.
    clearDraft(chatId);
  },
  getActivities: (chatId) => get().turnsByChat[chatId] ?? [],
}));

// Debug helper — mirrors the window.__ exposure pattern in chat-store /
// snapshot-store. Lets a live Playwright session (or the dev console) read the
// ephemeral turn store to diagnose "diffs not showing": if the accordion
// in the chat bubble AND the reviewing overlay are BOTH empty, the activity
// never reached this store (SSE/tool-result not parsed, or cleared), which
// localizes the bug above the render layer.
if (typeof window !== "undefined") {
  window.__useCoauthorTurnStore = useCoauthorTurnStore;
}
