/**
 * SidebarFlyout — the collapsed-sidebar chat-selection flyout (portaled to
 * body). Shared by the RP `Sidebar` and `CoauthorSidebar` (E4, post-SF-4
 * dedup). Mode-parameterized for the three points where the two shells
 * diverge:
 *
 *  - `flyoutChats`: the mode-filtered chat list (RP shells pre-filter
 *    `c.mode !== "coauthor"`; coauthor pre-filters `c.mode === "coauthor"`).
 *    Passed in already filtered — the flyout itself is mode-agnostic about
 *    the filter predicate.
 *  - `createChatMode`: the mode arg forwarded to `handleCreateChat` (RP omits
 *    it → defaults to an RP chat; coauthor passes `"coauthor"`).
 *  - `emptyTitleKey`: the i18n key for the empty-state heading (RP uses
 *    `"sidebar_send_a_message"`; coauthor uses `"coauthor.list_empty"`).
 *
 * Everything else (positioning math, search, row layout, animations) is
 * identical between the two consumers.
 */
import { type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ChatId, ChatMode } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { formatRelativeTime } from "../sidebar-utils.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { OverflowTooltip } from "../../shared/OverflowTooltip.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ChatControllerActions } from "../../../hooks/use-chat-controller.js";
import { useT } from "../../../i18n/context.js";
import type { CharacterTab } from "../app-shell-types.js";
import type { TFn } from "./section-types.js";

export function SidebarFlyout({
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
  flyoutRef,
  flyoutListRef,
  flyoutTop,
  flyoutMaxH,
  flyoutFlipped,
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
  flyoutRef: RefObject<HTMLDivElement | null>;
  flyoutListRef: RefObject<HTMLDivElement | null>;
  flyoutTop: number | null;
  flyoutMaxH: number | null;
  flyoutFlipped: boolean;
  createChatMode?: ChatMode;
  emptyTitleKey: string;
  t: TFn;
}) {
  const { tDynamic } = useT();
  if (!flyoutCharId || !sidebarCollapsed) return null;

  const tab = characterTabs.find(tc => tc.id === flyoutCharId);
  const q = chatQuery.trim().toLowerCase();
  const filtered = q ? flyoutChats.filter(c => c.title.toLowerCase().includes(q)) : flyoutChats;

  return createPortal(
    <div
      ref={flyoutRef}
      className={cn(
        "glass-blur fixed left-[54px] z-[301] flex w-[300px] max-w-[calc(100vw-70px)] gap-2 overflow-hidden rounded-r-xl border border-border bg-glass-bg shadow-[16px_8px_24px_-8px_rgba(0,0,0,0.4)]",
        flyoutFlipped ? "flex-col-reverse" : "flex-col",
      )}
      style={{ top: flyoutTop ?? 12, maxHeight: flyoutMaxH ?? undefined, animation: "flyoutIn 0.18s ease-out" }}
    >
      {/* ── Header ── */}
      <div className={cn("relative shrink-0 border-border", flyoutFlipped ? "border-t" : "border-b")}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: "linear-gradient(to bottom, color-mix(in srgb, var(--accent-dim) 50%, transparent), transparent)" }}
        />
        <div className="relative flex items-center gap-1 px-2 py-2">
          <div className="min-w-0 flex-1 truncate px-1 font-ui text-[calc(var(--ui-fs)+0px)] font-medium leading-tight tracking-[-0.01em] text-t1">{tab?.name}</div>
          <CustomTooltip content={t("new_chat")}>
            <button type="button" className="iBtn size-7 shrink-0" aria-label={t("new_chat")} onClick={() => { void character.handleCreateChat(flyoutCharId, createChatMode); }}><Icons.Plus /></button>
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
      <div ref={flyoutListRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1">
        {q && (
          <div className="px-2 pb-0.5 pt-1 text-[calc(var(--ui-fs)-3px)] font-medium text-t4">
            {filtered.length} / {flyoutChats.length} {t("sidebar_chats").toLowerCase()}
          </div>
        )}

        {flyoutChats.length === 0 ? (
          <div className="empty-state" style={{ minHeight: 160, padding: "32px 16px" }}>
            <div className="empty-icon" style={{ width: 40, height: 40 }}><Icons.Chat /></div>
            <div className="empty-title">{tDynamic(emptyTitleKey)}</div>
            <button type="button" className="empty-cta" onClick={() => { void character.handleCreateChat(flyoutCharId, createChatMode); }}>{t("new_chat")}</button>
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
    </div>,
    document.body,
  );
}
