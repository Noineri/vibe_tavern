/**
 * FlatChatRow — the co-author chat-list row, the flat-row counterpart to
 * `RichChatRow`. Extracted out of `CoauthorSidebar` (SIDEBAR_GOD_OBJECT_AUDIT
 * step 3d) so the co-author surface renders its chat list through the shared
 * `<ChatListSection renderRow={<FlatChatRow/>}/>` instead of a duplicated
 * inline `<section>`.
 *
 * Flat by design: a sparkles marker + title + message count, with hover-only
 * rename and delete affordances. No branch chip, no context menu, no variants —
 * the co-author editor has no branching surface. Rename shares the same
 * `<SidebarChatRename>` primitive as the RP row, so the commit/abort contract
 * (blur/Enter commits if non-empty, Escape/empty aborts) is single-sourced.
 *
 * Rename state is local to the row (`renaming` boolean), matching `RichChatRow`
 * — only one row can be hovered-and-clicked into rename at a time, so a per-row
 * flag is equivalent to the previous shared `renamingChatId` tracker and keeps
 * `CoauthorSidebar` free of rename state.
 */
import { useState } from "react";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { OverflowTooltip } from "../../shared/OverflowTooltip.js";
import { Icons } from "../../shared/icons.js";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import { SidebarChatRename } from "./SidebarChatRename.js";

export interface FlatChatRowProps {
  chatItem: ChatListItem;
  isActive: boolean;
  chat: ChatControllerActions;
  character: CharacterControllerActions;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
}

export function FlatChatRow({ chatItem, isActive, chat, character, setConfirmDestroy }: FlatChatRowProps) {
  const { t } = useT();
  const [renaming, setRenaming] = useState(false);
  const chatTitle = chatItem.title || t("coauthor.untitled_chat");

  return (
    <div
      className={cn(
        'group relative mx-1 flex cursor-pointer items-center rounded px-2.5 py-1.5 transition-colors duration-100',
        isActive ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2',
        renaming && 'pr-2',
      )}
      onClick={renaming ? undefined : () => void chat.handleSwitchChat(chatItem.id)}
    >
      <span className="mr-1.5 shrink-0 text-[calc(var(--ui-fs)-3px)] text-accent-t"><Icons.Sparkles /></span>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <SidebarChatRename
            className="w-full rounded border border-border bg-bg px-1 py-0.5 text-[calc(var(--ui-fs)-1px)] text-t1 outline-none focus:border-accent"
            initialValue={chatItem.title}
            onCommit={(title) => { void character.handleRenameChat(chatItem.id, title); setRenaming(false); }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <OverflowTooltip
              text={chatTitle}
              className={cn('text-[calc(var(--ui-fs)-1px)] text-t1', isActive && 'text-accent-t')}
            />
            <div className="text-[calc(var(--ui-fs)-3px)] text-t3">{chatItem.messageCount} {t("msgs_short")}</div>
          </>
        )}
      </div>

      {!renaming && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CustomTooltip content={t("sidebar_rename")}>
            <button
              type="button"
              className="iBtn size-5"
              aria-label={t("sidebar_rename")}
              onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
            >
              <Icons.Edit />
            </button>
          </CustomTooltip>
          <CustomTooltip content={t("delete")}>
            <button
              type="button"
              className="iBtn size-5 hover:text-danger-text"
              aria-label={t("delete")}
              onClick={(e) => {
                e.stopPropagation();
                const clearsOnRemove = character.getChatRemovalMode(chatItem.id) === "clear";
                setConfirmDestroy({
                  title: clearsOnRemove ? t("sidebar_clear_chat") : t("sidebar_delete_chat"),
                  body: clearsOnRemove
                    ? <>{t("sidebar_clear_chat_confirm")} <b>{chatTitle}</b></>
                    : <>{t("sidebar_are_you_sure")} <b>{chatTitle}</b></>,
                  confirmLabel: clearsOnRemove ? t("sidebar_clear_chat") : t("delete"),
                  onConfirm: () => void character.handleRemoveChat(chatItem.id),
                });
              }}
            >
              <Icons.Trash />
            </button>
          </CustomTooltip>
        </div>
      )}
    </div>
  );
}
