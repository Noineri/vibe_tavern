import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { registerMessageSlot, type MessageSlotContext } from "../../lib/message-slot-registry.js";
import { useCoauthorTurnStore, extractPersistedCoauthorActivities, type CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { coauthorSectionEditInputSchema, coauthorSectionWriteInputSchema } from "@vibe-tavern/api-contracts";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import type { AppMessage } from "../../app-client.js";
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";

/**
 * Co-Author tool-activity cards (CA-9.2b), rendered in the message bubble via
 * the `tool_activity` slot. Each card represents one tool call from the active
 * co-author turn: a status icon + the model-supplied `summary` (commit-message
 * label), expanding to a scrollable preview of the proposed content.
 *
 * The activities come from the ephemeral {@link useCoauthorTurnStore} (fed by
 * the tool SSE events wired in `use-chat-controller`). They are turn-scoped
 * (keyed by chatId), so the cards attach only to the message that produced
 * them: the in-flight streaming message during the turn, or the last assistant
 * message after the turn (in-session review, before Apply/Reject in CA-11).
 *
 * The authoritative canonical→proposed diff lives in the CA-11 editor
 * reviewing-overlay (the editor holds canonical); this card is a glanceable
 * progress/preview surface, not the merge UI.
 */

const EMPTY: CoauthorToolActivity[] = [];
const EMPTY_MSGS: AppMessage[] = [];

/**
 * Slot-rendered component. `visible`/`render` in the registry are plain
 * functions (no hooks), so reactivity lives here: this component subscribes to
 * the turn store and re-renders when activities arrive.
 */
function CoauthorToolActivitySlot({
  chatId,
  messageId,
  isStreaming,
}: {
  chatId: string;
  messageId: string;
  isStreaming: boolean;
}) {
  const activeActivities = useCoauthorTurnStore(useShallow((s) => s.turnsByChat[chatId] ?? EMPTY));
  // Primitive signature, not an ordered-message array subscription: each
  // MessageBlock must remain isolated from unrelated message/variant updates.
  // Zustand compares this string with Object.is, so a mutation on message B
  // does not commit message A merely because the selector rescanned the turn.
  const persistedActiveIdKey = useSnapshotStore((s) => {
    if (activeActivities.length === 0) return "";
    const activeIds = new Set(activeActivities.map((activity) => activity.toolCallId));
    const messages = s.messageOrder
      .map((id) => s.messagesById[id])
      .filter((message): message is AppMessage => message !== undefined);
    return extractPersistedCoauthorActivities(messages)
      .map((activity) => activity.toolCallId)
      .filter((toolCallId) => activeIds.has(toolCallId))
      .sort()
      .join("\u0000");
  });
  const persistedToolCallIds = useMemo(
    () => new Set(persistedActiveIdKey ? persistedActiveIdKey.split("\u0000") : []),
    [persistedActiveIdKey],
  );
  const isLastAssistant = useSnapshotStore(
    useShallow((s) => {
      const order = s.messageOrder;
      for (let i = order.length - 1; i >= 0; i--) {
        const m = s.messagesById[order[i]];
        if (m && m.role === "assistant") return m.id === messageId;
      }
      return false;
    }),
  );

  // CS-6 fix: the selector MUST return references that are stable across calls
  // (zustand v5 + React's useSyncExternalStore otherwise loop with "getSnapshot
  // should be cached" / React #185). Returning an array of NEWLY-constructed
  // CoauthorToolActivity objects here broke that invariant: useShallow compares
  // array elements by reference (Object.is), so fresh objects every call →
  // always "changed" → infinite forceStoreRerender, the moment a persisted
  // tool message existed (e.g. after a completed edit_examples turn).
  // Selector now returns the tool MESSAGES themselves (same refs the store
  // holds, structurally shared via Immer → Object.is holds), and the derived
  // CoauthorToolActivity[] is built in a useMemo below.
  const trailingToolMessages = useSnapshotStore(useShallow((s): AppMessage[] => {
    const order = s.messageOrder;
    const msgs = s.messagesById;
    const idx = order.indexOf(messageId);
    if (idx === -1) return EMPTY_MSGS;
    const out: AppMessage[] = [];
    for (let i = idx + 1; i < order.length; i++) {
      const m = msgs[order[i]];
      if (!m || m.role !== "tool") break;
      out.push(m);
    }
    return out.length > 0 ? out : EMPTY_MSGS;
  }));
  // The carrier assistant message for this bubble — its persisted `toolCalls`
  // entry carries the canonical tool name AND the operation input (args) that a
  // result-only parse cannot recover. Ref-stable (Immer structurally shared).
  const assistantMessage = useSnapshotStore(useShallow((s): AppMessage | undefined => s.messagesById[messageId]));
  // Reloaded/review cards reconstruct from the SAME extractor the non-streaming
  // hydration path uses (chat-actions.syncCommittedCoauthorTurn), so in-session
  // and reloaded cards agree on one reconstruction contract: the carrier
  // assistant + its trailing tool rows. With no user message in this slice the
  // extractor treats the whole slice as the turn, recovering name+args from the
  // assistant toolCalls and the result fields from the tool rows.
  const persistedActivities = useMemo<CoauthorToolActivity[]>(() => {
    if (!assistantMessage) return EMPTY;
    return extractPersistedCoauthorActivities([assistantMessage, ...trailingToolMessages]);
  }, [assistantMessage, trailingToolMessages]);

  const activities = useMemo(() => {
    const map = new Map<string, CoauthorToolActivity>();
    for (const a of persistedActivities) map.set(a.toolCallId, a);
    
    if (isStreaming || isLastAssistant) {
      for (const a of activeActivities) {
        // During generation the active store is the only source and belongs on
        // the streaming assistant. After commit, however, each persisted call
        // is rendered by its carrier assistant. Re-attaching the same active ID
        // to the final text assistant produced the duplicated card pairs seen
        // before Apply. Keep the final-assistant fallback only for genuinely
        // unpersisted/historical active rows.
        if (isStreaming || !persistedToolCallIds.has(a.toolCallId)) {
          map.set(a.toolCallId, a);
        }
      }
    }
    return Array.from(map.values());
  }, [persistedActivities, activeActivities, persistedToolCallIds, isStreaming, isLastAssistant]);

  if (activities.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {activities.map((a: CoauthorToolActivity) => (
        <ToolActivityCard key={a.toolCallId} activity={a} />
      ))}
    </div>
  );
}

// ─── Operation preview (CED-6) ─────────────────────────────────────────────
// The card reads the operation INPUT (args), not the cumulative `proposed`, so
// it looks like an IDE/CLI operation: scoped SEARCH/REPLACE for edits, the
// section body for writes, the slot text for greetings. Only a true
// whole-document `write_profile` may show the full profile. A historical row
// without input renders an "unavailable" note and NEVER falls back to the full
// proposed snapshot (the F-2 UX dissonance: a section edit looked like a full
// profile rewrite because the card printed `proposed` verbatim).
type GreetingLabelKey =
  | "coauthor_tool_op_greeting_primary"
  | "coauthor_tool_op_greeting_alt"
  | "coauthor_tool_op_greeting_new";

type LoreLabelKey =
  | "coauthor_tool_op_lore_book"
  | "coauthor_tool_op_lore_entry"
  | "coauthor_tool_op_lore_write"
  | "coauthor_tool_op_lore_keys"
  | "coauthor_tool_op_lore_activation";

type OpPreview =
  | { kind: "edit"; edits: { search: string; replace: string }[] }
  | { kind: "write-section"; content: string }
  | { kind: "write-profile" }
  | { kind: "greeting"; labelKey: GreetingLabelKey; labelNum?: number; content: string }
  | { kind: "lore"; labelKey: LoreLabelKey; content?: string; chips?: string[]; chipKeys?: string[] }
  | null;

/** Narrow the opaque `args` per `toolName` into a renderable operation, or
 * `null` when the input is missing/unparseable (historical or malformed). */
function parseOperation(toolName: string, args: unknown): OpPreview {
  if (args == null || typeof args !== "object") return null;
  switch (toolName) {
    case "edit_personality":
    case "edit_scenario":
    case "edit_examples": {
      const parsed = coauthorSectionEditInputSchema.safeParse(args);
      if (!parsed.success) return null;
      return { kind: "edit", edits: parsed.data.edits.map(({ search, replace }) => ({ search, replace })) };
    }
    case "write_personality":
    case "write_scenario":
    case "write_examples": {
      const parsed = coauthorSectionWriteInputSchema.safeParse(args);
      if (!parsed.success) return null;
      return { kind: "write-section", content: parsed.data.content };
    }
    case "write_profile":
      return { kind: "write-profile" };
    case "add_alt_greeting": {
      const a = args as { content?: string };
      return typeof a.content === "string" ? { kind: "greeting", labelKey: "coauthor_tool_op_greeting_new", content: a.content } : null;
    }
    case "edit_alt_greeting": {
      const a = args as { index?: number; content?: string };
      if (typeof a.content !== "string") return null;
      return { kind: "greeting", labelKey: "coauthor_tool_op_greeting_alt", labelNum: typeof a.index === "number" ? a.index : 1, content: a.content };
    }
    case "edit_greeting": {
      const a = args as { content?: string };
      return typeof a.content === "string" ? { kind: "greeting", labelKey: "coauthor_tool_op_greeting_primary", content: a.content } : null;
    }
    // ── Lore tools (CTX-L3). The structured lore review (CoauthorLoreReview)
    // shows the full cumulative proposal; this is the per-call glanceable
    // preview of what each call put in — the book/entry text, the delegated
    // brief, or the generation/activation params. `chips` are literal display
    // strings (activation keys); `chipKeys` are i18n keys (param values).
    case "create_lorebook": {
      const a = args as { name?: unknown; description?: unknown };
      const parts = [a.name, a.description].filter((s): s is string => typeof s === "string" && s.trim().length > 0);
      return parts.length ? { kind: "lore", labelKey: "coauthor_tool_op_lore_book", content: parts.join("\n") } : null;
    }
    case "create_lore_entry": {
      const a = args as { content?: unknown; keys?: unknown };
      const keys = Array.isArray(a.keys) ? a.keys.filter((k): k is string => typeof k === "string" && k.length > 0) : [];
      const content = typeof a.content === "string" && a.content.trim() ? a.content : undefined;
      if (!keys.length && !content) return null;
      return { kind: "lore", labelKey: "coauthor_tool_op_lore_entry", chips: keys.length ? keys : undefined, content };
    }
    case "ai_write_lore_entry": {
      const a = args as { instruction?: unknown };
      return typeof a.instruction === "string" && a.instruction.trim()
        ? { kind: "lore", labelKey: "coauthor_tool_op_lore_write", content: a.instruction }
        : null;
    }
    case "ai_generate_lore_keys": {
      const a = args as { keyTarget?: unknown; appendMode?: unknown };
      const target = a.keyTarget === "primary" || a.keyTarget === "secondary" ? a.keyTarget : "both";
      const augment = a.appendMode === true;
      return {
        kind: "lore",
        labelKey: "coauthor_tool_op_lore_keys",
        chipKeys: [`ai_quickpill_key_target_${target}`, augment ? "ai_quickpill_append" : "coauthor_tool_op_replace"],
      };
    }
    case "set_lore_activation": {
      const a = args as { constant?: unknown; enabled?: unknown };
      const chipKeys: string[] = [];
      if (a.constant === true) chipKeys.push("coauthor_tool_op_lore_constant");
      if (a.enabled === true) chipKeys.push("coauthor_tool_op_lore_enabled");
      else if (a.enabled === false) chipKeys.push("coauthor_tool_op_lore_disabled");
      return { kind: "lore", labelKey: "coauthor_tool_op_lore_activation", chipKeys: chipKeys.length ? chipKeys : undefined };
    }
    default:
      return null;
  }
}

const PREVIEW_PRE_CLS = "whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-msg-t2";
const PREVIEW_LABEL_CLS = "font-ui text-[10px] uppercase tracking-wide text-t3";

/** One SEARCH/REPLACE hunk, unified-diff style: `-` search lines, `+` replace lines. */
function DiffHunk({ search, replace }: { search: string; replace: string }) {
  const { t } = useT();
  const searchLines = search.split("\n");
  const replaceLines = replace.split("\n");
  return (
    <div className="flex flex-col">
      <span className={PREVIEW_LABEL_CLS}>{t("coauthor_tool_op_search")}</span>
      {searchLines.map((l, i) => (
        <div key={`s${i}`} className="flex gap-1 font-mono text-[11px] leading-relaxed">
          <span className="select-none text-danger-text">-</span>
          <span className="whitespace-pre-wrap break-words text-msg-t2">{l}</span>
        </div>
      ))}
      <span className={`mt-1 ${PREVIEW_LABEL_CLS}`}>{t("coauthor_tool_op_replace")}</span>
      {replaceLines.map((l, i) => (
        <div key={`r${i}`} className="flex gap-1 font-mono text-[11px] leading-relaxed">
          <span className="select-none text-success-text">+</span>
          <span className="whitespace-pre-wrap break-words text-msg-t2">{l}</span>
        </div>
      ))}
    </div>
  );
}

/** Scoped operation preview rendered when the card is expanded. */
function OperationPreview({ op, proposed }: { op: OpPreview; proposed?: string }) {
  const { t, tDynamic } = useT();
  if (!op) {
    // Historical/malformed: no input to reconstruct the operation. Do NOT fall
    // back to the full cumulative `proposed` — the summary is still shown above.
    return <div className={PREVIEW_LABEL_CLS}>{t("coauthor_tool_op_unavailable")}</div>;
  }
  switch (op.kind) {
    case "edit":
      return (
        <div className="flex flex-col gap-2">
          {op.edits.map((e, i) => (
            <DiffHunk key={i} search={e.search} replace={e.replace} />
          ))}
        </div>
      );
    case "write-section":
      return (
        <div className="flex flex-col gap-1">
          <span className={PREVIEW_LABEL_CLS}>{t("coauthor_tool_op_section_write")}</span>
          <pre className={PREVIEW_PRE_CLS}>{op.content}</pre>
        </div>
      );
    case "greeting":
      return (
        <div className="flex flex-col gap-1">
          <span className={PREVIEW_LABEL_CLS}>
            {op.labelNum != null ? `${t(op.labelKey)} ${op.labelNum}` : t(op.labelKey)}
          </span>
          <pre className={PREVIEW_PRE_CLS}>{op.content}</pre>
        </div>
      );
    case "write-profile":
      // The ONLY case the full cumulative document is shown — the operation itself is document-wide.
      return <pre className={PREVIEW_PRE_CLS}>{proposed ?? ""}</pre>;
    case "lore":
      return (
        <div className="flex flex-col gap-1">
          <span className={PREVIEW_LABEL_CLS}>{t(op.labelKey)}</span>
          {/* Literal chips = activation keys (accent, matching CoauthorLoreReview's
              primary-key pills); i18n chips = generation/activation param values
              (muted, so metadata reads distinct from trigger keywords). */}
          {op.chips && op.chips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {op.chips.map((c, i) => (
                <span key={`c${i}`} className="rounded-full bg-accent/15 px-1.5 py-px font-ui text-[10px] text-accent">{c}</span>
              ))}
            </div>
          )}
          {op.chipKeys && op.chipKeys.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {op.chipKeys.map((k, i) => (
                <span key={`p${i}`} className="rounded-full border border-border/60 bg-s3 px-1.5 py-px font-ui text-[10px] text-t3">{tDynamic(k)}</span>
              ))}
            </div>
          )}
          {op.content && <pre className={PREVIEW_PRE_CLS}>{op.content}</pre>}
        </div>
      );
  }
}

function ToolActivityCard({ activity }: { activity: CoauthorToolActivity }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  const isRead = activity.readPath !== undefined;
  const streaming = activity.status === "streaming";
  const errored = activity.status === "error";
  // Status icon + color: done proposal → check (success), read → file icon
  // (success, but a distinct glyph so reads don't read as completed edits),
  // error → close (danger), streaming → wrench (neutral, the AI is editing).
  const statusIcon = isRead
    ? <Icons.FileText />
    : errored
      ? <Icons.Close />
      : streaming
        ? <Icons.Wrench />
        : <Icons.Check />;
  const statusClass = errored
    ? "text-danger-text"
    : streaming
      ? "text-t3"
      : "text-success-text";
  // A read activity's meaningful label is the path it read; proposals keep the
  // model-supplied summary (commit-message label).
  const title = isRead
    ? activity.readPath!
    : activity.summary?.trim() || t("coauthor_tool_activity");

  return (
    <div className="overflow-hidden">
      <button
        type="button"
        disabled={streaming}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 py-1.5 text-left font-ui text-[11px] font-medium tracking-[0.03em] text-t2 transition-colors duration-100 hover:text-t1 hover:bg-s2/50 rounded px-2 disabled:cursor-default"
      >
        <span className={statusClass}>{statusIcon}</span>
        <span className="truncate">{title}</span>
        {streaming && <span className="italic text-t3">{t("coauthor_tool_streaming")}</span>}
        {/* Reads have no operation preview (the path IS the label; the file
            content is intentionally not surfaced — it can be large), so no caret. */}
        {!streaming && !isRead && (
          <span className="ml-auto text-t3">{open ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}</span>
        )}
      </button>
      {errored && (
        <div className="px-3 py-1.5 font-ui text-[11px] text-danger-text">{t("coauthor_tool_error")}</div>
      )}
      {!streaming && !isRead && open && (
        <div className="max-h-48 overflow-auto px-3 py-2 border-l-2 border-border/50 ml-2 mt-1">
          <OperationPreview op={parseOperation(activity.toolName, activity.args)} proposed={activity.proposed} />
        </div>
      )}
    </div>
  );
}

// Module-load registration (mirrors MessageReasoning.tsx). The slot is wired
// into the bubble by `MessageShell` (tool_activity position) and triggered by a
// side-effect import in `MessageBlock.tsx`.
// In Co-Author mode, this slot is disabled because `CoauthorTurnShell` renders
// tools inline natively, but we keep this registration active for any potential RP fallback.

registerMessageSlot({
  id: "coauthor-tool-activity",
  slot: "tool_activity",
  order: 0,
  roles: ["assistant"],
  visible: (ctx: MessageSlotContext) => {
    if (ctx.messageRole !== "assistant") return false;
    const mode = useSnapshotStore.getState().activeChat?.mode;
    return mode !== "coauthor";
  },
  render: (ctx) => (
    <CoauthorToolActivitySlot chatId={ctx.chatId} messageId={ctx.messageId} isStreaming={ctx.isStreaming} />
  ),
});

export { CoauthorToolActivitySlot, ToolActivityCard };
