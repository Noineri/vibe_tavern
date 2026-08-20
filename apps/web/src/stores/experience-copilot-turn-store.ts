import { create } from "zustand";
import {
  experienceCopilotToolOutputSchema,
  coauthorSkillReadOutputSchema,
  copilotTodoListSchema,
  type ExperienceCopilotMessageWire,
  type ExperienceCopilotTarget,
  type CopilotTodoItem,
} from "@vibe-tavern/api-contracts";

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
 *
 * TAG-7 adds `todoByThread` — the SESSION-scoped live todo panel state (NOT
 * turn-scoped): it mirrors the backend's `todo_json` on the thread row
 * («время жизни туду должно быть на всю сессию»), so `clearTurn` deliberately
 * does NOT drop it (a turn starting must not blank the pinned panel until the
 * refetch re-seeds it). It is seeded from the thread wire (`thread.todo`) by
 * the controller and upserted by live `todo` tool events — full-rewrite
 * semantics: the newest call's list replaces the whole state.
 */

/** Lifecycle of a single tool call within an experience-copilot turn. */
export type ExperienceCopilotToolStatus = "streaming" | "done" | "error";

/** The `todo` tool's result envelope, projected onto the activity card
 *  payload (TAG-7). `items` is the FULL rewritten list (Cline-style — every
 *  call replaces the session plan); `remaining` counts pending+active items
 *  (the collapsed panel's "N remaining goals"), `activeTitle` is the current
 *  step's title. The backend computes both; the parser recomputes them
 *  defensively when an envelope omits one, so live and persisted renders of
 *  the same call can never disagree. */
export interface CopilotTodoActivityResult {
  items: readonly CopilotTodoItem[];
  remaining: number;
  activeTitle?: string;
}

/** One `ask_user` call's lifecycle state (TAG-7), keyed by the activity's
 *  `toolCallId`. `awaiting_answer` is the live/persisted marker the ask card
 *  (TAG-9) renders interactively; `answered`/`skipped` are the REWRITTEN
 *  tool-row payloads (the answer replaces the awaiting marker in place — no
 *  separate user row). The question/options/recommended always come from the
 *  carrier tool-call args (the answered/skipped rewrites carry no question),
 *  with the awaiting marker's verbatim echo as the fallback. */
export interface CopilotAskState {
  question: string;
  options?: readonly string[];
  recommended?: string;
  status: "awaiting_answer" | "answered" | "skipped";
  /** The user's answer text — present iff `status === "answered"`. */
  answer?: string;
}

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
  /** Present iff this is a `todo` activity whose result envelope parsed
   *  (TAG-7): the card payload (items + remaining + activeTitle). A failed
   *  save (`ok:false`) or malformed envelope leaves this unset and the card
   *  renders as an error with the raw content — mirroring the write_buffer
   *  branch's failure shape. */
  todo?: CopilotTodoActivityResult;
  /** Present iff this is an `ask_user` activity (TAG-7): the question/
   *  options/recommended plus the awaiting/answered/skipped status the ask
   *  card (TAG-9) renders. Produced by ONE parser (`parseCopilotAskState`)
   *  from both the live SSE path and the persisted extraction, so the two
   *  paths cannot drift. */
  ask?: CopilotAskState;
}

/** TF-4: one ordered feed entry of the active turn — a closed-or-open TEXT
 *  segment or a reference to a tool activity (rendered by id via the
 *  activities map). Order = arrival order. */
export type CopilotFeedEntry =
  | { kind: "text"; id: string; text: string; closed: boolean }
  | { kind: "activity"; id: string };

/** Minimal structural message shape the persisted-activity extraction reads
 *  (CD-1). Satisfied by `AppMessage` (whose tool calls may hide behind the
 *  variant indirection) and by the wire adapter `wireToToolSource` below (the
 *  copilot thread's `toolCallsJson`, parsed — never has variants). Structural
 *  on purpose: the extraction is a pure function over message SOURCES, not
 *  over one UI type. */
export interface CopilotToolSourceMessage {
  id?: string;
  role: string;
  content: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; args?: unknown }>;
  toolCallId?: string | null;
  /** Variant indirection (AppMessage-shaped sources only). */
  variants?: ReadonlyArray<CopilotToolSourceVariant>;
  selectedVariantIndex?: number | null;
}

/** The variant part of `CopilotToolSourceMessage`. */
interface CopilotToolSourceVariant {
  variantIndex?: number;
  isSelected?: boolean;
  toolCalls?: { id: string; name: string; args?: unknown }[];
  toolCallId?: string | null;
}

/** Selected-variant metadata is the real chat-snapshot wire shape (AppMessage
 *  sources). Some older callers/tests still provide the same fields flattened
 *  on the source message, so keep those as the first-choice compatibility
 *  source. Wire-adapter sources have no variants — the helpers degrade to the
 *  flattened fields. */
function selectedVariant(message: CopilotToolSourceMessage) {
  const variants = message.variants ?? [];
  const selectedIndex = message.selectedVariantIndex;
  if (typeof selectedIndex === "number") {
    return variants.find((variant) => variant.variantIndex === selectedIndex)
      ?? variants[selectedIndex];
  }
  return variants.find((variant) => variant.isSelected);
}

function messageToolCalls(message: CopilotToolSourceMessage) {
  if (message.toolCalls && message.toolCalls.length > 0) return message.toolCalls;
  return selectedVariant(message)?.toolCalls ?? [];
}

function messageToolCallId(message: CopilotToolSourceMessage): string | null | undefined {
  return message.toolCallId ?? selectedVariant(message)?.toolCallId;
}

/** Rebuild a turn's activities from committed tool rows (CD-1 generalizes
 *  this from "the latest turn" to any turn slice — the message-list history
 *  renderer and the non-streaming hydration path share this one reconstruction
 *  contract). The slice's tool RESULT rows are correlated with their carrier
 *  assistant toolCall entries to recover the canonical tool name and the
 *  operation INPUT (args); when the slice contains no user row the whole slice
 *  is treated as the turn (mirroring the co-author extractor's contract).
 *
 *  Tool-row `content` on the wire is the `{toolName, output}` wrapper written
 *  by `persistTurn` (services/api …/experience-copilot-stream.ts). Legacy
 *  fixtures also feed the RAW output shape (`{target, proposed, summary}`);
 *  both are unwrapped — see `unwrapPersistedToolContent`.
 *
 *  Pure: no I/O, no React, no store reads. */
export function extractPersistedExperienceCopilotActivities(
  messages: ReadonlyArray<CopilotToolSourceMessage>,
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
    const toolCallId = messageToolCallId(message) ?? message.id ?? "";
    const info = toolCallInfoById.get(toolCallId);
    let rawContent: unknown;
    try {
      rawContent = JSON.parse(message.content);
    } catch (error) {
      rawContent = { parseError: error instanceof Error ? error.message : String(error) };
    }
    // The real persisted shape wraps the tool output: `{toolName, output}`
    // (persistTurn). Unwrap it; a raw (unwrapped) output — the legacy fixture
    // shape — passes through unchanged.
    const { output: rawOutput, toolName: wrappedToolName } = unwrapPersistedToolContent(rawContent);
    const toolName = info?.name ?? wrappedToolName ?? "";
    // A read_skill_file result is {path, content} — NOT a proposal, so it must
    // not be flagged as an error (the proposal-schema parse below would).
    // Recognize it first so the card renders as a normal done read.
    if (toolName === "read_skill_file") {
      const read = coauthorSkillReadOutputSchema.safeParse(rawOutput);
      activities.push({
        toolCallId,
        toolName,
        args: info?.args,
        status: read.success ? "done" : "error",
        ...(read.success ? { readPath: read.data.path } : { summary: message.content }),
      });
      continue;
    }
    // A write_buffer/edit_buffer result is {target, proposed, summary} — a
    // PROPOSAL over one of the two named buffers. Parse it with the copilot
    // tool-output schema (no greetingIndex/isAdd — those are co-author-only).
    if (toolName === "write_buffer" || toolName === "edit_buffer") {
      const output = experienceCopilotToolOutputSchema.safeParse(rawOutput);
      activities.push({
        toolCallId,
        toolName,
        args: info?.args,
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
    // A todo result is the {ok, items, activeTitle, remaining} envelope
    // (TAG-3). A successful envelope carries the card payload (items + the
    // collapsed-panel summary); a failed save (ok:false) or malformed shape
    // renders as an error card with the raw content — the write_buffer
    // branch's failure shape.
    if (toolName === "todo") {
      const todo = parseTodoToolResult(rawOutput);
      activities.push({
        toolCallId,
        toolName,
        args: info?.args,
        status: todo ? "done" : "error",
        ...(todo ? { todo } : { summary: message.content }),
      });
      continue;
    }
    // An ask_user row is the awaiting marker or the post-answer rewrite
    // (TAG-5): awaiting carries the question verbatim; answered/skipped carry
    // only the answer — the question/options/recommended are recovered from
    // the carrier tool-call args this extractor already correlates.
    if (toolName === "ask_user") {
      const ask = parseCopilotAskState(info?.args, rawOutput);
      activities.push({
        toolCallId,
        toolName,
        args: info?.args,
        status: ask ? "done" : "error",
        ...(ask ? { ask } : { summary: message.content }),
      });
      continue;
    }
    // run_test / run_simulate / suggest_visual_binding — non-proposal results
    // (informational digests that never enter proposal aggregation). Render a
    // graceful done-with-raw-content card.
    activities.push({
      toolCallId,
      toolName,
      args: info?.args,
      status: "done",
      summary: message.content,
    });
  }
  return activities;
}

/** The `{toolName, output}` wrapper `persistTurn` serializes into tool-row
 *  `content`. Structural (no zod): the wrapper predates any schema and only
 *  this shape matters for unwrapping. */
interface PersistedToolResultWrapper {
  toolName: unknown;
  output: unknown;
}

function isPersistedToolResultWrapper(value: unknown): value is PersistedToolResultWrapper {
  return typeof value === "object" && value !== null && "toolName" in value && "output" in value;
}

/** Unwrap the persisted `{toolName, output}` wrapper around a tool result
 *  payload. A value that is not the wrapper (the legacy raw-output fixture
 *  shape, or a JSON parse-error object) passes through as-is with no name. */
function unwrapPersistedToolContent(rawContent: unknown): { output: unknown; toolName?: string } {
  if (isPersistedToolResultWrapper(rawContent)) {
    return {
      output: rawContent.output,
      ...(typeof rawContent.toolName === "string" ? { toolName: rawContent.toolName } : {}),
    };
  }
  return { output: rawContent };
}

/** Structural read of a record field as a string (undefined when absent or
 *  not a string) — shared by the todo/ask parsers below. */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/** Structural read of a record field as a string array (undefined when absent
 *  or not an every-string array). */
function readStringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value;
}

/** Parse a `todo` tool-result envelope (TAG-7) into the activity card payload.
 *  Accepts ONLY the success shape (`ok: true` + a contract-valid item list);
 *  a failed save (`ok: false, error`) or anything malformed returns null —
 *  the caller renders the error-card branch, exactly like a write_buffer
 *  whose proposal fails to parse. `remaining`/`activeTitle` are recomputed
 *  from the items when the envelope omits them, so a same-shape envelope
 *  through either path yields the identical payload. Pure. */
export function parseTodoToolResult(output: unknown): CopilotTodoActivityResult | null {
  if (typeof output !== "object" || output === null) return null;
  const record = output as Record<string, unknown>;
  if (record.ok !== true) return null;
  const items = copilotTodoListSchema.safeParse(record.items);
  if (!items.success) return null;
  const remainingFromEnvelope = record.remaining;
  const remaining = typeof remainingFromEnvelope === "number" && Number.isInteger(remainingFromEnvelope) && remainingFromEnvelope >= 0
    ? remainingFromEnvelope
    : items.data.filter((item) => item.status === "pending" || item.status === "active").length;
  const activeTitle = readString(record, "activeTitle")
    ?? items.data.find((item) => item.status === "active")?.title;
  return {
    items: items.data,
    remaining,
    ...(activeTitle !== undefined ? { activeTitle } : {}),
  };
}

/** Parse an `ask_user` tool-call's state (TAG-7) from the carrier args plus
 *  the tool-result output. The output carries the STATUS: the awaiting marker
 *  (`{status:"awaiting_answer", question, options?, recommended?}` — the
 *  question echoed verbatim) or the post-answer rewrites
 *  (`{status:"answered", answer}` / `{status:"skipped"}` — no question: it
 *  lives only in the carrier args). Anything else → null (error card).
 *  BOTH extraction paths (live SSE + persisted rows) call this one function,
 *  which is what makes their payloads field-for-field identical. Pure. */
export function parseCopilotAskState(args: unknown, output: unknown): CopilotAskState | null {
  if (typeof output !== "object" || output === null) return null;
  const out = output as Record<string, unknown>;
  const argsRecord = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  // options/recommended prefer the output's verbatim echo (awaiting), falling
  // back to the carrier args (answered/skipped rewrites carry neither).
  const options = readStringArray(out, "options") ?? readStringArray(argsRecord, "options");
  const recommended = readString(out, "recommended") ?? readString(argsRecord, "recommended");
  if (out.status === "awaiting_answer") {
    const question = readString(out, "question") ?? readString(argsRecord, "question");
    if (question === undefined || question === "") return null;
    return {
      question,
      ...(options !== undefined ? { options } : {}),
      ...(recommended !== undefined ? { recommended } : {}),
      status: "awaiting_answer",
    };
  }
  if (out.status === "answered") {
    const answer = readString(out, "answer");
    if (answer === undefined) return null;
    return {
      question: readString(argsRecord, "question") ?? "",
      ...(options !== undefined ? { options } : {}),
      ...(recommended !== undefined ? { recommended } : {}),
      status: "answered",
      answer,
    };
  }
  if (out.status === "skipped") {
    return {
      question: readString(argsRecord, "question") ?? "",
      ...(options !== undefined ? { options } : {}),
      ...(recommended !== undefined ? { recommended } : {}),
      status: "skipped",
    };
  }
  return null;
}

/** One historical turn's audit cards for the chat-history renderer (CD-1).
 *  `placement` is relative to the anchor FLOW message (user/assistant — tool
 *  rows are not rendered): `"before"` renders the cards above the turn's final
 *  assistant reply (matching the live turn shell's card-above-reply order);
 *  `"after"` handles a turn that ended with no assistant text (e.g. failed
 *  mid-tools) by attaching the cards below the turn's user bubble. */
export interface HistoricalCopilotTurnActivities {
  anchorId: string;
  placement: "before" | "after";
  activities: ExperienceCopilotToolActivity[];
}

/** Adapter: the copilot wire message → the structural extraction source. The
 *  wire carries tool calls as `toolCallsJson` (a `[{type: "tool-call",
 *  toolCallId, toolName, input}]` array serialized by `persistTurn`), which is
 *  mapped to the flattened `{id, name, args}` shape the extractor correlates.
 *  Invalid JSON degrades to no tool calls (the tool rows still render, just
 *  without name/args recovery — mirroring a missing carrier assistant row). */
export function wireToToolSource(message: ExperienceCopilotMessageWire): CopilotToolSourceMessage {
  let toolCalls: { id: string; name: string; args?: unknown }[] | undefined;
  if (message.toolCallsJson) {
    try {
      const parsed: unknown = JSON.parse(message.toolCallsJson);
      if (Array.isArray(parsed)) {
        toolCalls = parsed.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return [];
          const e = entry as Record<string, unknown>;
          const id = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
          const name = typeof e.toolName === "string" ? e.toolName : undefined;
          if (id === undefined || name === undefined) return [];
          return [{ id, name, args: e.input }];
        });
        if (toolCalls.length === 0) toolCalls = undefined;
      }
    } catch {
      // Invalid toolCallsJson — degrade to no carrier info (documented above).
    }
  }
  return {
    ...(message.id ? { id: message.id } : {}),
    role: message.role,
    content: message.content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(message.toolCallId != null ? { toolCallId: message.toolCallId } : {}),
  };
}

/** Rebuild EVERY turn's audit activities from a thread's persisted wire
 *  messages (CD-1): history cards persist visually instead of being dropped
 *  when a new turn starts. One entry per turn that produced ≥1 tool activity;
 *  turns are delimited by user rows (a leading segment before the first user
 *  row is treated as its own turn, defensive against manual DB edits).
 *  Excludes nothing — deduping against the LIVE turn store (which holds the
 *  still-unreviewed latest turn after settle+refetch) is the caller's job, by
 *  `toolCallId` (the live block renders those cards below the list instead).
 *
 *  Pure: no I/O, no React, no store reads. */
export function extractHistoricalTurnActivities(
  messages: ReadonlyArray<ExperienceCopilotMessageWire>,
): HistoricalCopilotTurnActivities[] {
  const turns: ExperienceCopilotMessageWire[][] = [];
  let current: ExperienceCopilotMessageWire[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);

  const out: HistoricalCopilotTurnActivities[] = [];
  for (const turn of turns) {
    const activities = extractPersistedExperienceCopilotActivities(turn.map(wireToToolSource));
    if (activities.length === 0) continue;
    // Anchor on the turn's LAST flow (rendered) message: the final assistant
    // reply when present, else the user bubble (cards render after it).
    let anchor: ExperienceCopilotMessageWire | undefined;
    for (let i = turn.length - 1; i >= 0; i--) {
      const role = turn[i]!.role;
      if (role === "user" || role === "assistant") {
        anchor = turn[i];
        break;
      }
    }
    if (!anchor) continue; // No renderable position — nothing to anchor to.
    out.push({
      anchorId: anchor.id,
      placement: anchor.role === "assistant" ? "before" : "after",
      activities,
    });
  }
  return out;
}

interface ExperienceCopilotTurnState {
  turnsByThread: Record<string, ExperienceCopilotToolActivity[]>;
  /** TF-4: ordered arrival feed per thread (text segments + activity refs). */
  feedByThread: Record<string, CopilotFeedEntry[]>;
  /** TAG-7: session-scoped live todo panel state per thread (mirrors the
   *  backend thread row's `todo_json`; see the header lifecycle note). */
  todoByThread: Record<string, CopilotTodoItem[]>;
  /** Insert or merge (by toolCallId) an activity for a thread. */
  upsertActivity: (threadId: string, activity: ExperienceCopilotToolActivity) => void;
  /** Drop the active turn's activities for a thread (turn start / switch / Apply / Reject). */
  clearTurn: (threadId: string) => void;
  /** Read the activities for a thread (empty array if none). */
  getActivities: (threadId: string) => ExperienceCopilotToolActivity[];
  /** TAG-7: full-rewrite replace of a thread's live todo panel state (the
   *  newest `todo` call's list IS the state — Cline-style). The items are
   *  shallow-copied to detach them from the caller's parsed-JSON reference. */
  setTodo: (threadId: string, items: readonly CopilotTodoItem[]) => void;
  /** TAG-7: read a thread's live todo panel state (empty array if none). */
  getTodo: (threadId: string) => CopilotTodoItem[];
  /** TF-4: append a text delta into the OPEN text segment (or open one). */
  appendTextDelta: (threadId: string, delta: string) => void;
  /** TF-4: close the OPEN text segment (noop when none is open). */
  closeTextSegment: (threadId: string) => void;
  /** TF-4: append an activity ref (idempotent per toolCallId). */
  appendActivityRef: (threadId: string, toolCallId: string) => void;
}

// TF-4: monotonic feed text-segment id. Never reset (clearTurn drops the
// entries, not the counter) so ids stay unique within any rendered list.
let nextFeedTextId = 1;

export const useExperienceCopilotTurnStore = create<ExperienceCopilotTurnState>((set, get) => ({
  turnsByThread: {},
  feedByThread: {},
  todoByThread: {},
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
      const hasActivities = s.turnsByThread[threadId] !== undefined;
      const hasFeed = s.feedByThread[threadId] !== undefined;
      if (!hasActivities && !hasFeed) return s;
      const nextActivities = { ...s.turnsByThread };
      delete nextActivities[threadId];
      const nextFeed = { ...s.feedByThread };
      delete nextFeed[threadId];
      return { turnsByThread: nextActivities, feedByThread: nextFeed };
    });
    // ER-10 wires draft persistence (experience-copilot-draft.ts) — not yet available.
  },
  getActivities: (threadId) => get().turnsByThread[threadId] ?? [],
  setTodo: (threadId, items) => {
    set((s) => ({ todoByThread: { ...s.todoByThread, [threadId]: [...items] } }));
  },
  getTodo: (threadId) => get().todoByThread[threadId] ?? [],
  appendTextDelta: (threadId, delta) => {
    if (delta === "") return;
    set((s) => {
      const feed = s.feedByThread[threadId] ?? [];
      const last = feed[feed.length - 1];
      if (last !== undefined && last.kind === "text" && !last.closed) {
        const nextEntry: CopilotFeedEntry = { ...last, text: last.text + delta };
        const nextFeed = [...feed.slice(0, -1), nextEntry];
        return { feedByThread: { ...s.feedByThread, [threadId]: nextFeed } };
      }
      const entry: CopilotFeedEntry = {
        kind: "text",
        id: `text-${nextFeedTextId++}`,
        text: delta,
        closed: false,
      };
      return { feedByThread: { ...s.feedByThread, [threadId]: [...feed, entry] } };
    });
  },
  closeTextSegment: (threadId) => {
    set((s) => {
      const feed = s.feedByThread[threadId] ?? [];
      const last = feed[feed.length - 1];
      if (last === undefined || last.kind !== "text" || last.closed) return s;
      const nextEntry: CopilotFeedEntry = { ...last, closed: true };
      const nextFeed = [...feed.slice(0, -1), nextEntry];
      return { feedByThread: { ...s.feedByThread, [threadId]: nextFeed } };
    });
  },
  appendActivityRef: (threadId, toolCallId) => {
    set((s) => {
      const feed = s.feedByThread[threadId] ?? [];
      if (feed.some((e) => e.kind === "activity" && e.id === toolCallId)) return s;
      const entry: CopilotFeedEntry = { kind: "activity", id: toolCallId };
      return { feedByThread: { ...s.feedByThread, [threadId]: [...feed, entry] } };
    });
  },
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
