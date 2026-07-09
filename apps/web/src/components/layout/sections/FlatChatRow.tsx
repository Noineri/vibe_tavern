/**
 * FlatChatRow — the co-author chat-list row, the flat-row counterpart to
 * `RichChatRow`. Extracted out of `CoauthorSidebar` (SIDEBAR_GOD_OBJECT_AUDIT
 * step 3d) so the co-author surface renders its chat list through the shared
 * `<ChatListSection renderRow={<FlatChatRow/>}/>` instead of a duplicated
 * inline `<section>`.
 *
 * Flat by design: a sparkles marker + title + message count. Rename shares the
 * same `<SidebarChatRename>` primitive as the RP row, so the commit/abort
 * contract (blur/Enter commits if non-empty, Escape/empty aborts) is
 * single-sourced. Rename state is local to the row (`renaming` boolean),
 * matching `RichChatRow` — only one row can be hovered-and-clicked into rename
 * at a time, so a per-row flag is equivalent to the previous shared
 * `renamingChatId` tracker and keeps `CoauthorSidebar` free of rename state.
 *
 * Row actions (rename / delete) live behind a "⋮" kebab (Radix DropdownMenu),
 * mirroring `RichChatRow`'s context menu. Previously the pencil + trash were
 * two absolutely-positioned glyphs that rendered OVER the title and overlapped
 * it; the kebab is a single glyph and the title truncates with `pr-4` so it
 * never runs under the trigger (#37).
 */
import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const chatTitle = chatItem.title || t("coauthor.untitled_chat");
  const clearsOnRemove = character.getChatRemovalMode(chatItem.id) === "clear";

  return (
    <div
      className={cn(
        'group relative mx-1 flex cursor-pointer items-center rounded px-2.5 py-1.5 transition-colors duration-100',
        isActive ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2',
        renaming && 'pr-2',
      )}
      style={{ zIndex: menuOpen ? 100 : 1 }}
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
              className={cn('pr-4 text-[calc(var(--ui-fs)-1px)] text-t1', isActive && 'text-accent-t')}
            />
            <div className="text-[calc(var(--ui-fs)-3px)] text-t3">{chatItem.messageCount} {t("msgs_short")}</div>
          </>
        )}
      </div>

      {!renaming && (
        <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <CustomTooltip content={t("sidebar_chat_actions")}>
              <DropdownMenu.Trigger asChild>
                <button type="button"
                  className={cn(
                    'flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1 data-[state=open]:text-t1',
                    isActive && 'hover:text-accent-t',
                  )}
                  aria-label={t("sidebar_chat_actions")}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Icons.Ellipsis />
                </button>
              </DropdownMenu.Trigger>
            </CustomTooltip>
          </div>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              className="glass-blur z-[200] w-[190px] rounded-md border border-border2 bg-glass-bg py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
            >
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors duration-100 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                onSelect={() => setRenaming(true)}
              >
                <Icons.Edit /> {t("sidebar_rename")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-danger-text outline-none transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text data-[highlighted]:bg-danger-dim data-[highlighted]:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                onSelect={() => setConfirmDestroy({
                  title: clearsOnRemove ? t("sidebar_clear_chat") : t("sidebar_delete_chat"),
                  body: clearsOnRemove
                    ? <>{t("sidebar_clear_chat_confirm")} <b>{chatTitle}</b></>
                    : <>{t("sidebar_are_you_sure")} <b>{chatTitle}</b></>,
                  confirmLabel: clearsOnRemove ? t("sidebar_clear_chat") : t("delete"),
                  onConfirm: () => void character.handleRemoveChat(chatItem.id),
                })}
              >
                <Icons.Trash /> {clearsOnRemove ? t("sidebar_clear_chat") : t("delete")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}
