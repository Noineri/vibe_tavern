/**
 * CoauthorSidebarFlyout — the collapsed-sidebar chat-selection flyout for the
 * co-author shell.
 *
 * RSF-1 forked the former shared component into this coauthor-only file and an
 * RP sibling (`SidebarFlyout`); the RP surface has its own copy. RSF-4 migrated
 * this flyout from `createPortal` + manual positioning to Radix Popover with a
 * virtual anchor, retiring the `flyoutTop` / `flyoutMaxH` / `flyoutFlipped`
 * props and the `flex-col-reverse` flip — Radix's `avoidCollisions` + `flip` +
 * `shift` + `size` middlewares handle collision, repositioning, and the
 * available-height clamp (`--radix-popper-available-height`) natively. This
 * mirrors the RSF-3 migration of the RP flyout one-for-one; the only divergence
 * is the surface: no branch UI here, the chat list stays flat.
 *
 * Coauthor-specific parameterization that the old shared component took as mode-
 * parameter props is kept here:
 *
 *  - `flyoutChats`: the mode-filtered chat list (coauthor pre-filters
 *    `c.mode === "coauthor"`). Passed in already filtered — the flyout itself
 *    is mode-agnostic about the filter predicate.
 *  - `createChatMode`: the mode arg forwarded to `handleCreateChat` (coauthor
 *    passes `"coauthor"`).
 *  - `emptyTitleKey`: the i18n key for the empty-state heading (coauthor uses
 *    `"coauthor.list_empty"`).
 *
 * Virtual anchor: a stable ref-shaped object whose `.current` is a `Measurable`
 * derived from `flyoutAvatarPos` ({ top, bottom } of the clicked avatar). The
 * rect is a zero-width vertical line at the collapsed strip's right edge (x=54,
 * matching the former `fixed left-[54px]`), spanning the avatar's [top, bottom].
 * The ref is rebuilt via `useMemo` on `flyoutAvatarPos` so Radix's `PopperAnchor`
 * (which compares `virtualRef.current` by identity every render) detects the new
 * anchor and repositions when the user clicks a different avatar.
 */
import { useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { ChatId, ChatMode } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { formatRelativeTime } from "../layout/sidebar-utils.js";
import { Icons } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { OverflowTooltip } from "../shared/OverflowTooltip.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import type { CharacterControllerActions } from "../../hooks/use-character-controller.js";
import type { ChatControllerActions } from "../../hooks/use-chat-controller.js";
import { useT } from "../../i18n/context.js";
import type { CharacterTab } from "../layout/app-shell-types.js";
import type { TFn } from "../layout/sections/section-types.js";

/** Collapsed sidebar strip right edge — the former `fixed left-[54px]` value. */
const COLLAPSED_STRIP_RIGHT_X = 54;

export function CoauthorSidebarFlyout({
  flyoutCharId,
  sidebarCollapsed,
  characterTabs,
  flyoutChats,
  chatQuery,
  setChatQuery,
  activeChatId,
  chat,
  character,
  setFlyoutCharId,
  flyoutAvatarPos,
  createChatMode,
  emptyTitleKey,
  t,
}: {
  flyoutCharId: string | null;
  sidebarCollapsed: boolean;
  characterTabs: readonly CharacterTab[];
  flyoutChats: readonly ChatListItem[];
  chatQuery: string;
  setChatQuery: (v: string) => void;
  activeChatId: ChatId | null;
  chat: ChatControllerActions;
  character: CharacterControllerActions;
  setFlyoutCharId: (v: string | null) => void;
  /** Measured viewport { top, bottom } of the clicked avatar; powers the virtual anchor. */
  flyoutAvatarPos: { top: number; bottom: number } | null;
  createChatMode?: ChatMode;
  emptyTitleKey: string;
  t: TFn;
}) {
  const { tDynamic } = useT();
  const open = flyoutCharId !== null && sidebarCollapsed;

  // Virtual anchor ref. Rebuilt when flyoutAvatarPos changes so the new
  // `.current` identity triggers Radix's PopperAnchor to reposition. A zero-rect
  // fallback is used before any avatar is clicked — harmless because the content
  // only mounts while `open` is true, and `open` requires `flyoutCharId`, which
  // the strip sets only after `flyoutAvatarPos`. Radix's `PopperAnchor` compares
  // `virtualRef.current` by identity every render, so the memo key is what makes
  // repositioning fire on a new avatar click.
  const virtualAnchorRef = useMemo<{ current: { getBoundingClientRect(): DOMRect } }>(() => {
    const { top, bottom } = flyoutAvatarPos ?? { top: 0, bottom: 0 };
    const height = Math.max(bottom - top, 0);
    const rect: DOMRect = {
      x: COLLAPSED_STRIP_RIGHT_X,
      y: top,
      top,
      bottom,
      left: COLLAPSED_STRIP_RIGHT_X,
      right: COLLAPSED_STRIP_RIGHT_X,
      width: 0,
      height,
      toJSON() { /* structural DOMRect stub */ },
    };
    return { current: { getBoundingClientRect: () => rect } };
  }, [flyoutAvatarPos]);

  const tab = flyoutCharId ? characterTabs.find(tc => tc.id === flyoutCharId) : undefined;
  const q = chatQuery.trim().toLowerCase();
  const filtered = q ? flyoutChats.filter(c => c.title.toLowerCase().includes(q)) : flyoutChats;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => { if (!o) setFlyoutCharId(null); }}
    >
      <Popover.Anchor virtualRef={virtualAnchorRef} />
      <Popover.Portal container={getModalPortal() ?? undefined}>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={0}
          collisionPadding={12}
          className="glass-blur z-[301] flex w-[300px] max-w-[calc(100vw-70px)] flex-col overflow-hidden rounded-r-xl border border-border bg-glass-bg shadow-[16px_8px_24px_-8px_rgba(0,0,0,0.4)] outline-none data-[state=open]:animate-[flyoutIn_0.18s_ease-out]"
        >
          {/* ── Header ── */}
          <div className="relative shrink-0 border-b border-border">
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: "linear-gradient(to bottom, color-mix(in srgb, var(--accent-dim) 50%, transparent), transparent)" }}
            />
            <div className="relative flex items-center gap-1 px-2 py-2">
              <div className="min-w-0 flex-1 truncate px-1 font-ui text-[calc(var(--ui-fs)+0px)] font-medium leading-tight tracking-[-0.01em] text-t1">{tab?.name}</div>
              <CustomTooltip content={t("new_chat")}>
                <button type="button" className="iBtn size-7 shrink-0" aria-label={t("new_chat")} onClick={() => { if (flyoutCharId) void character.handleCreateChat(flyoutCharId, createChatMode); }}><Icons.Plus /></button>
              </CustomTooltip>
              <CustomTooltip content={t("close")}>
                <button type="button" className="iBtn size-7 shrink-0" aria-label={t("close")} onClick={() => setFlyoutCharId(null)}><Icons.Close /></button>
              </CustomTooltip>
            </div>
          </div>

          {/* ── Search ── */}
          <div className="shrink-0 px-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-s2 px-2 py-1 transition-colors focus-within:border-accent/60">
              <Icons.Search className="h-3.5 w-3.5 shrink-0 text-t3" />
              <input
                type="text"
                value={chatQuery}
                onChange={(e) => setChatQuery(e.target.value)}
                placeholder={t("chat_search_placeholder")}
                className="min-w-0 flex-1 bg-transparent font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none placeholder:text-t4"
              />
              {chatQuery && (
                <button type="button" className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-t1" aria-label={t("chat_search_clear")} onClick={() => setChatQuery("")}>
                  <Icons.Close className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* ── Chat list ── */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1" style={{ maxHeight: "var(--radix-popper-available-height)" }}>
            {q && (
              <div className="px-2 pb-0.5 pt-1 text-[calc(var(--ui-fs)-3px)] font-medium text-t4">
                {filtered.length} / {flyoutChats.length} {t("sidebar_chats").toLowerCase()}
              </div>
            )}

            {flyoutChats.length === 0 ? (
              <div className="empty-state" style={{ minHeight: 160, padding: "32px 16px" }}>
                <div className="empty-icon" style={{ width: 40, height: 40 }}><Icons.Chat /></div>
                <div className="empty-title">{tDynamic(emptyTitleKey)}</div>
                <button type="button" className="empty-cta" onClick={() => { if (flyoutCharId) void character.handleCreateChat(flyoutCharId, createChatMode); }}>{t("new_chat")}</button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <Icons.Search className="h-5 w-5 text-t4" />
                <div className="text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">{t("chat_search_no_results", { query: chatQuery })}</div>
                <button type="button" className="text-[calc(var(--ui-fs)-2px)] text-accent-t transition-colors hover:underline" onClick={() => setChatQuery("")}>{t("chat_search_clear")}</button>
              </div>
            ) : (
              filtered.map((chatItem, index) => {
                const isActive = chatItem.id === activeChatId;
                return (
                  <div
                    key={chatItem.id}
                    role="button"
                    tabIndex={0}
                    style={{ animation: "flyoutCardIn 0.22s ease-out backwards", animationDelay: `${Math.min(index, 12) * 26}ms` }}
                    className={cn(
                      "relative mx-1 mb-0.5 cursor-pointer rounded-lg px-2.5 py-1.5 outline-none transition-colors duration-150",
                      isActive ? "bg-accent-dim" : "hover:bg-s2 focus-visible:bg-s2",
                    )}
                    onClick={() => { void chat.handleSwitchChat(chatItem.id); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void chat.handleSwitchChat(chatItem.id); } }}
                  >
                    {isActive && <div className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full bg-accent" />}
                    <OverflowTooltip
                      text={chatItem.title}
                      className={cn("text-[calc(var(--ui-fs)-1px)]", isActive ? "font-medium text-accent-t" : "text-t1")}
                    />
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[calc(var(--ui-fs)-3px)] text-t3">
                      <span className="shrink-0 whitespace-nowrap tabular-nums">{formatRelativeTime(chatItem.updatedAt)}</span>
                      <span className="shrink-0 text-t4">·</span>
                      <span className="shrink-0 whitespace-nowrap tabular-nums">{chatItem.messageCount} {t("msgs_short")}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
