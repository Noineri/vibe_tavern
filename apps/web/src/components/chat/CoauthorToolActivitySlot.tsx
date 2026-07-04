import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { registerMessageSlot, type MessageSlotContext } from "../../lib/message-slot-registry.js";
import { useCoauthorTurnStore, type CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import type { CoauthorTarget } from "@vibe-tavern/api-contracts";
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
  const EMPTY_MSGS: AppMessage[] = [];
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
  // A persisted tool message's content is the JSON the backend wrote from the
  // tool's execute() output (coauthorToolOutputSchema: summary/proposed/target).
  // It may also be a plain string if the result wasn't an object — the catch
  // wraps that as a summary so the card still renders something useful.
  const persistedActivities = useMemo<CoauthorToolActivity[]>(() => {
    type PersistedToolResult = { summary?: string; proposed?: string; target?: CoauthorTarget };
    return trailingToolMessages.map((m) => {
      let output: PersistedToolResult = {};
      try {
        const parsed: unknown = JSON.parse(m.content);
        output = (parsed && typeof parsed === "object") ? parsed as PersistedToolResult : { summary: m.content };
      } catch {
        output = { summary: m.content };
      }
      return {
        toolCallId: m.toolCallId || m.id,
        toolName: "",
        status: "done",
        summary: output.summary,
        proposed: output.proposed,
        target: output.target,
      };
    });
  }, [trailingToolMessages]);

  const activities = useMemo(() => {
    const map = new Map<string, CoauthorToolActivity>();
    for (const a of persistedActivities) map.set(a.toolCallId, a);
    
    if (isStreaming || isLastAssistant) {
      for (const a of activeActivities) map.set(a.toolCallId, a);
    }
    return Array.from(map.values());
  }, [persistedActivities, activeActivities, isStreaming, isLastAssistant]);

  if (activities.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {activities.map((a: CoauthorToolActivity) => (
        <ToolActivityCard key={a.toolCallId} activity={a} />
      ))}
    </div>
  );
}

function ToolActivityCard({ activity }: { activity: CoauthorToolActivity }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  const streaming = activity.status === "streaming";
  const errored = activity.status === "error";
  // Status icon + color: done → check (success), error → close (danger),
  // streaming → wrench (neutral, the AI is editing).
  const statusIcon = errored ? <Icons.Close /> : streaming ? <Icons.Wrench /> : <Icons.Check />;
  const statusClass = errored
    ? "text-danger-text"
    : streaming
      ? "text-t3"
      : "text-success-text";
  const title = activity.summary?.trim() || t("coauthor_tool_activity");

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
        {!streaming && (
          <span className="ml-auto text-t3">{open ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}</span>
        )}
      </button>
      {errored && (
        <div className="px-3 py-1.5 font-ui text-[11px] text-danger-text">{t("coauthor_tool_error")}</div>
      )}
      {!streaming && open && activity.proposed != null && (
        <div className="max-h-48 overflow-auto px-3 py-2 border-l-2 border-border/50 ml-2 mt-1">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-msg-t2">
            {activity.proposed}
          </pre>
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
