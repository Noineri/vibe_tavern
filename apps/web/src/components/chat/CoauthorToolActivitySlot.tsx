import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { registerMessageSlot, type MessageSlotContext } from "../../lib/message-slot-registry.js";
import { useCoauthorTurnStore, type CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
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
  const activities = useCoauthorTurnStore(useShallow((s) => s.turnsByChat[chatId] ?? EMPTY));
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

  if (activities.length === 0) return null;
  // During the turn the cards ride on the streaming message; after the turn
  // (snapshot refresh, streaming=false) they ride on the persisted last
  // assistant message until the user Applies/Rejects (CA-11 clears the store).
  if (!isStreaming && !isLastAssistant) return null;

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {activities.map((a) => (
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
    <div className="overflow-hidden rounded-md border border-border bg-surface">
      <button
        type="button"
        disabled={streaming}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left font-ui text-[11px] font-medium tracking-[0.03em] text-t2 transition-colors duration-100 hover:bg-s2 disabled:cursor-default"
      >
        <span className={statusClass}>{statusIcon}</span>
        <span className="truncate">{title}</span>
        {streaming && <span className="italic text-t3">{t("coauthor_tool_streaming")}</span>}
        {!streaming && (
          <span className="ml-auto text-t3">{open ? <Icons.Caret direction="u" /> : <Icons.Caret direction="d" />}</span>
        )}
      </button>
      {errored && (
        <div className="border-t border-border px-3 py-1.5 font-ui text-[11px] text-danger-text">{t("coauthor_tool_error")}</div>
      )}
      {!streaming && open && activity.proposed != null && (
        <div className="max-h-48 overflow-auto border-t border-border bg-bg px-3 py-2">
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
registerMessageSlot({
  id: "coauthor-tool-activity",
  slot: "tool_activity",
  order: 0,
  roles: ["assistant"],
  visible: (ctx: MessageSlotContext) => ctx.messageRole === "assistant",
  render: (ctx) => (
    <CoauthorToolActivitySlot chatId={ctx.chatId} messageId={ctx.messageId} isStreaming={ctx.isStreaming} />
  ),
});

export { CoauthorToolActivitySlot, ToolActivityCard };
