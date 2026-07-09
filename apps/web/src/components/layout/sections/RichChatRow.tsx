/**
 * RichChatRow — the RP (rich) chat-list row.
 *
 * Extracted verbatim out of `Sidebar.tsx`'s inline `rpVisibleChats.map` body
 * (SIDEBAR_GOD_OBJECT_AUDIT step 3c). Behavior-preserving move: the only
 * change is that the row's transient UI state now lives HERE instead of in the
 * parent Sidebar (and the global `characterStore` rename fields, which were
 * dead-subscribed in `AppShell.tsx`, are replaced by local `useState`):
 *   - rename mode: was `renamingChatId === chatItem.id` + global `renameDraft`;
 *     now local `renaming` + `renameDraft`.
 *   - context menu: was `chatMenuId === chatItem.id`; now local `chatMenuOpen`.
 *   - branch popover: was `branchPopId === chatItem.id`; now local
 *     `branchPopOpen`, with the outside-click handler that used to live in
 *     `Sidebar.handleClickOutside` moved into this row's own `useEffect`.
 *
 * The row still closes on outside interaction exactly as before: the chat
 * context menu is a Radix `DropdownMenu` (closes via its own outside-click), and
 * the branch popover is a plain `<div>` shielded from the row's click handler by
 * `stopPropagation` + closed by this component's `mousedown` listener. The chip
 * toggle and menu↔popover mutual exclusion (open one closes the other) are
 * preserved verbatim. The props follow the controller-props precedent set by
 * `CharacterListSection` (`chat` + `character` + `setConfirmDestroy`) rather
 * than threading a wall of individual handlers.
 */
import { useEffect, useRef, useState } from "react";
import type { ChatBranch, ChatBranchId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { OverflowTooltip } from "../../shared/OverflowTooltip.js";
import { formatShortDate } from "../sidebar-utils.js";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import { SidebarBranchRename } from "./SidebarBranchRename.js";
import { SidebarChatRename } from "./SidebarChatRename.js";

export interface RichChatRowProps {
  chatItem: ChatListItem;
  isActive: boolean;
  /** Branches of the ACTIVE chat (only consulted when `isActive`). */
  branches: ChatBranch[];
  activeBranchId: ChatBranchId | null;
  chat: ChatControllerActions;
  character: CharacterControllerActions;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
}

export function RichChatRow({
  chatItem,
  isActive,
  branches,
  activeBranchId,
  chat,
  character,
  setConfirmDestroy,
}: RichChatRowProps) {
  const { t } = useT();
  const [renaming, setRenaming] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [branchPopOpen, setBranchPopOpen] = useState(false);
  const branchPopRef = useRef<HTMLDivElement | null>(null);

  // Close the branch popover on outside click. Only armed while open (the
  // original Sidebar-level listener was always-on; this is behavior-equivalent
  // — there is nothing to close when the popover is shut). The branch chip and
  // the popover itself call `stopPropagation` so interacting with them does not
  // trigger this handler.
  useEffect(() => {
    if (!branchPopOpen) return;
    function handleClickOutside(event: MouseEvent): void {
      if (branchPopRef.current && !branchPopRef.current.contains(event.target as Node)) {
        setBranchPopOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [branchPopOpen]);

  const chatRemovalMode = character.getChatRemovalMode(chatItem.id);
  const clearsOnRemove = chatRemovalMode === "clear";
  const branchCount = isActive ? branches.length : 0;

  return (
    <div
      className="group relative mx-1 flex flex-col rounded"
      style={{ zIndex: chatMenuOpen || branchPopOpen ? 100 : 1 }}
    >
      <div
        className={cn(
          'relative cursor-pointer rounded px-2.5 py-1.5 transition-colors duration-100',
          isActive ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2',
        )}
        onClick={() => void chat.handleSwitchChat(chatItem.id)}
      >
        {renaming ? (
          <SidebarChatRename
            className="mb-px w-full rounded border border-accent bg-bg px-[5px] py-[2px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none"
            initialValue={chatItem.title}
            onCommit={(title) => { void character.handleRenameChat(chatItem.id, title); setRenaming(false); }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <OverflowTooltip
            text={chatItem.title}
            className={cn('pr-4 text-[calc(var(--ui-fs)-1px)] text-t1', isActive && 'text-accent-t')}
          />
        )}
        <div className="mt-px flex items-center gap-1.5">
          <div className="text-[calc(var(--ui-fs)-3px)] text-t3">
            {chatItem.characterName} · {chatItem.messageCount} {t("msgs_short")}
          </div>
          {isActive && branchCount > 0 && (
            <CustomTooltip content={t("sidebar_chat_branches")}>
              <div
                className="inline-flex cursor-pointer items-center gap-[3px] rounded px-1 py-px font-ui text-[calc(var(--ui-fs)-3px)] tabular-nums text-t3 transition-colors duration-100 hover:bg-border hover:text-t1 [&_svg]:h-2.5 [&_svg]:w-2.5"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setBranchPopOpen((current) => !current);
                  setChatMenuOpen(false);
                }}
              >
                <Icons.Stack /> {branchCount}
              </div>
            </CustomTooltip>
          )}
        </div>
      </div>

      {!renaming && (
        <DropdownMenu.Root
          modal={false}
          open={chatMenuOpen}
          onOpenChange={(open) => {
            if (open) {
              setChatMenuOpen(true);
              setBranchPopOpen(false);
            } else {
              setChatMenuOpen(false);
            }
          }}
        >
          <div className="absolute right-1 top-2 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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

              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors duration-100 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                onSelect={() => character.handleExportChatJsonl(chatItem.id)}
              >
                <Icons.Download /> {t("sidebar_export_jsonl")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-danger-text outline-none transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text data-[highlighted]:bg-danger-dim data-[highlighted]:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                onSelect={() => setConfirmDestroy({
                  title: clearsOnRemove ? t("sidebar_clear_chat") : t("sidebar_delete_chat"),
                  body: clearsOnRemove
                    ? <>{t("sidebar_clear_chat_confirm")} <b>{chatItem.title}</b></>
                    : <>{t("sidebar_are_you_sure")} <b>{chatItem.title}</b></>,
                  confirmLabel: clearsOnRemove ? t("sidebar_clear_chat") : t("delete"),
                  onConfirm: () => character.handleRemoveChat(chatItem.id),
                })}
              >
                <Icons.Trash /> {clearsOnRemove ? t("sidebar_clear_chat") : t("delete")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

      {branchPopOpen && isActive && (
        <div className="mt-1.5 flex cursor-default flex-col border-t border-dashed border-border2 pt-1.5" ref={branchPopRef} onClick={(event) => event.stopPropagation()}>
          <div className="mb-1 pl-1 text-[9px] font-medium uppercase tracking-[0.05em] text-t3">
            {t("sidebar_timeline_branches")}
          </div>
          <div className="ml-2 flex flex-col border-l-2 border-border pl-3">
            {branches.map((branch) => {
              const isActiveBranch = branch.id === activeBranchId;
              return (
                <div
                  key={branch.id}
                  className={cn(
                    'group/branch relative cursor-pointer rounded py-[5px] pl-1.5 pr-2 transition-colors duration-100',
                    isActiveBranch ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2/70',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    void chat.handleActivateBranch(branch.id);
                  }}
                >
                  <div className={cn('absolute -left-[14px] top-[14px] h-[2px] w-3', isActiveBranch ? 'bg-accent' : 'bg-border')} />
                  <div className="flex items-center gap-1">
                    <div className={cn(
                      'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] font-medium text-t2',
                      isActiveBranch && 'text-accent-t',
                    )}>{branch.label || t("sidebar_unnamed_branch")}</div>
                    <SidebarBranchRename branchId={branch.id} initialLabel={branch.label || ""} onRename={(label) => void chat.handleRenameBranch(branch.id, label)} />
                  </div>
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] text-t3">
                    {branch.messageCount ?? 0} {t("msgs_short")} · {formatShortDate(branch.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex items-center gap-1 border-t border-border pt-1">
            <button className="inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1 rounded px-1.5 text-center text-[calc(var(--ui-fs)-4px)] text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1 [&_svg]:h-3 [&_svg]:w-3"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void chat.handleFork(undefined);
              }}
            >
              <Icons.Branch /> {t("sidebar_fork_short")}
            </button>
            {(() => {
              const rootBranch = branches.find((b) => b.parentBranchId === null);
              const activeIsRoot = rootBranch != null && activeBranchId === rootBranch.id;
              const canAct = !activeIsRoot && branches.length > 1;
              return (
                <CustomTooltip content={canAct ? "" : t("sidebar_switch_to_non_main")}>
                  <button className={cn(
                    'inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1 rounded px-1.5 text-center text-[calc(var(--ui-fs)-4px)] text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1 [&_svg]:h-3 [&_svg]:w-3',
                    !canAct && 'opacity-45 cursor-not-allowed',
                  )}
                    type="button" aria-disabled={!canAct}
                    onClick={(event) => {
                      if (!canAct) return;
                      event.stopPropagation();
                      setConfirmDestroy({
                        title: t("sidebar_delete_branch"),
                        body: t("sidebar_delete_branch_body"),
                        confirmLabel: t("sidebar_delete_branch"),
                        onConfirm: () => void chat.handleDeleteActiveBranch(),
                      });
                    }}
                  >
                    <Icons.Trash /> {t("sidebar_delete_branch_short")}
                  </button>
                </CustomTooltip>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
