import { useChatRunActivityStore } from "../../../stores/chat-run-activity-store.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

/** Mount as a sibling of the clipped image inside a relative avatar wrapper.
 * The 17px circle overlaps the bottom-right edge without changing row geometry.
 * Character-only by owner choice: individual chat rows have no indicators. */
export function CharacterActivityBadge({ characterId }: { characterId: string }) {
  const { t } = useT();
  const running = useChatRunActivityStore((state) => state.running);
  const ready = useChatRunActivityStore((state) => state.ready);
  const status = useSnapshotStore((state) => {
    let hasReady = false;
    for (const chat of Object.values(state.chatsById)) {
      if (chat.characterId !== characterId || (chat.mode === "coauthor") !== (state.activeChat?.mode === "coauthor")) continue;
      if (running[chat.id]) return "writing";
      if (ready[chat.id]) hasReady = true;
    }
    return hasReady ? "ready" : null;
  });
  if (!status) return null;
  const writing = status === "writing";
  const label = writing ? t("chat_writing_badge") : t("chat_ready_badge");
  return (
    <CustomTooltip content={label}>
      <span role="status" aria-label={label} className={cn(
        "character-activity-badge absolute -bottom-0.5 -right-[3px] z-10 grid size-[17px] place-items-center rounded-full border-2 border-surface [&_svg]:size-2.5",
        writing ? "bg-s3 text-accent-t" : "bg-success text-white",
      )}>
        <span aria-hidden="true" className={cn("inline-flex", writing && "chat-writing-pencil")}>{writing ? <Ic.edit /> : <Ic.check />}</span>
      </span>
    </CustomTooltip>
  );
}
