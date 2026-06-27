import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatId } from "@vibe-tavern/domain";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "../shared/icons.js";
import { Logo } from "../shared/Logo.js";
import { cn } from "../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { CharacterImportModal, ChatImportModal } from "../modals/ImportModals.js";
import { useT } from "../../i18n/context.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useNavigationStore, useChatStore, useCharacterStore, useModalStore } from "../../stores/index.js";
import { buildCharacterTabs } from "../../lib/character-tabs.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { OverflowTooltip } from "../shared/OverflowTooltip.js";
import { useBuildPanels } from "../../hooks/use-build-panels.js";

/** Resolve a character tab's avatar URL (folder avatar when migrated). */
const tabAvatarSrc = (tab: { id: string; avatarExt: string | null; avatarAssetId: string | null; updatedAt?: string | null }) =>
  resolveEntityAvatarUrl({ kind: "characters", id: tab.id, avatarExt: tab.avatarExt, avatarAssetId: tab.avatarAssetId, updatedAt: tab.updatedAt });

export function Sidebar() {
  const { t } = useT();

  // --- Sub-hooks ---
  const chat = useChatController();
  const character = useCharacterController();

  // --- Store subscriptions ---
  const sidebarCollapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const mode = useNavigationStore((s) => s.mode);
  const buildTab = useCharacterStore((s) => s.buildTab);
  const setBuildTab = useCharacterStore((s) => s.setBuildTab);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const chatMeta = useChatMeta();
  const snapshot = chatMeta;
  const renamingChatId = useCharacterStore((s) => s.renamingChatId);
  const renameDraft = useCharacterStore((s) => s.renameDraft);
  const buildPanelItems = useBuildPanels();

  // --- Derived from bootstrap ---
  const allCharacters = useBootstrapStore((s) => s.data)?.allCharacters ?? snapshot?.allCharacters ?? [];

  // --- Derived from stores ---
  const allChats = snapshot?.chats ?? [];
  const activeChatCharacterId = snapshot?.activeChat?.characterId;
  const currentCharacterId = selectedCharacterId ?? activeChatCharacterId;
  const isCharacterTabActive = (tab: { id: string; chatId?: string | null }): boolean => {
    if (selectedCharacterId) return tab.id === selectedCharacterId;
    return tab.id === activeChatCharacterId || tab.chatId === activeChatId;
  };

  // Filter chats to show only those belonging to the current character
  const chats = useMemo(
    () => currentCharacterId
      ? allChats.filter((c) => c.characterId === currentCharacterId)
      : allChats,
    [allChats, currentCharacterId],
  );
  const branches = snapshot?.branches ?? [];
  const activeBranchId = snapshot?.activeBranch?.id ?? null;
  const bootstrapPersonas = useBootstrapStore((s) => s.personas);
  const activePersona = bootstrapPersonas?.find((p) => p.defaultForNewChats) ?? bootstrapPersonas?.[0];
  const personaName = snapshot?.persona?.name ?? activePersona?.name ?? t("no_persona");
  const personaForAvatar = snapshot?.persona ?? activePersona ?? null;
  const personaAvatarSrc = personaForAvatar
    ? resolveEntityAvatarUrl({ kind: "personas", id: personaForAvatar.id, avatarExt: personaForAvatar.avatarExt, avatarAssetId: personaForAvatar.avatarAssetId, updatedAt: personaForAvatar.updatedAt })
    : null;
  const activeCharAvatarSrc = snapshot?.character
    ? resolveEntityAvatarUrl({ kind: "characters", id: snapshot.character.id, avatarExt: snapshot.character.avatarExt, avatarAssetId: snapshot.character.avatarAssetId, updatedAt: snapshot.character.updatedAt })
    : null;

  const characterTabs = useMemo(
    () => buildCharacterTabs(allCharacters, allChats),
    [allCharacters, allChats],
  );

  // --- Store actions ---
  const setSidebarCollapsed = useNavigationStore((s) => s.setSidebarCollapsed);
  const setRenamingChatId = useCharacterStore((s) => s.setRenamingChatId);
  const setRenameDraft = useCharacterStore((s) => s.setRenameDraft);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  // --- Local UI state ---
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  const [chatMenuId, setChatMenuId] = useState<ChatId | null>(null);
  const [branchPopId, setBranchPopId] = useState<ChatId | null>(null);
  const [charMenuPos, setCharMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [chatMenuPos, setChatMenuPos] = useState<{ top: number; right: number } | null>(null);

  const charMenuRef = useRef<HTMLDivElement | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  const branchPopRef = useRef<HTMLDivElement | null>(null);
  const [importModal, setImportModal] = useState<"character" | "chat" | null>(null);
  const [charSwitcherOpen, setCharSwitcherOpen] = useState(false);
  // Viewport coords for the portaled dropdown — portaling to document.body is
  // required because the sidebar root is itself a glass surface (backdrop-blur),
  // which makes it a CSS backdrop root. A dropdown rendered inside it can only
  // blur the sidebar's own pixels, not the lava behind the sidebar → no frost.
  // Portal escapes that root so glass-blur blurs the real page. Same pattern as
  // charMenuPos / chatMenuPos / the chat flyout below.
  const [charSwitcherPos, setCharSwitcherPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const charSwitcherRef = useRef<HTMLDivElement | null>(null);
  // Trigger element ref — paired with charSwitcherRef so clicks on the trigger
  // don't get caught by the outside-click handler (which would close the menu
  // before the toggle onClick can reopen it).
  const charSwitcherTriggerRef = useRef<HTMLDivElement | null>(null);
  const [flyoutCharId, setFlyoutCharId] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState("");
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const flyoutListRef = useRef<HTMLDivElement | null>(null);
  const flyoutAvatarRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [flyoutAvatarPos, setFlyoutAvatarPos] = useState<{ top: number; bottom: number } | null>(null);
  const [flyoutTop, setFlyoutTop] = useState<number | null>(null);
  const [flyoutMaxH, setFlyoutMaxH] = useState<number | null>(null);
  const [flyoutFlipped, setFlyoutFlipped] = useState(false);

  const flyoutChats = useMemo(
    () => flyoutCharId ? allChats.filter(c => c.characterId === flyoutCharId) : [],
    [allChats, flyoutCharId],
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node;
      if (charMenuRef.current && !charMenuRef.current.contains(target)) setCharMenuId(null);
      if (chatMenuRef.current && !chatMenuRef.current.contains(target)) setChatMenuId(null);
      if (branchPopRef.current && !branchPopRef.current.contains(target)) setBranchPopId(null);
      // Switcher: ignore clicks on the trigger itself (toggled by its onClick).
      const triggerEl = charSwitcherTriggerRef.current;
      if (triggerEl && triggerEl.contains(target)) return;
      if (charSwitcherRef.current && !charSwitcherRef.current.contains(target)) { setCharSwitcherOpen(false); setCharSwitcherPos(null); }
      if (flyoutRef.current && !flyoutRef.current.contains(target)) setFlyoutCharId(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => { if (!flyoutCharId) setChatQuery(""); }, [flyoutCharId]);

  useLayoutEffect(() => {
    if (!flyoutCharId || flyoutAvatarPos == null) { setFlyoutTop(null); setFlyoutMaxH(null); setFlyoutFlipped(false); return; }
    const panel = flyoutRef.current;
    const list = flyoutListRef.current;
    if (!panel || !list) return;
    const vh = window.innerHeight;
    const spaceBelow = vh - flyoutAvatarPos.top - 12;
    const spaceAbove = flyoutAvatarPos.bottom - 12;
    const naturalH = list.scrollHeight + (panel.clientHeight - list.clientHeight);
    if (naturalH <= spaceBelow || spaceBelow >= spaceAbove) {
      setFlyoutFlipped(false);
      setFlyoutTop(flyoutAvatarPos.top);
      setFlyoutMaxH(Math.max(spaceBelow, 0));
    } else {
      setFlyoutFlipped(true);
      const h = Math.min(naturalH, spaceAbove);
      setFlyoutTop(flyoutAvatarPos.bottom - h);
      setFlyoutMaxH(Math.max(spaceAbove, 0));
    }
  }, [flyoutCharId, flyoutAvatarPos]);

  function calcPopoverPos(triggerEl: HTMLElement): { top: number; right: number } {
    const rect = triggerEl.getBoundingClientRect();
    return {
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    };
  }

  /** Position the character-switcher dropdown below its trigger, matching the
   *  trigger's width. Portaled to body (see charSwitcherPos comment). */
  function calcSwitcherPos(triggerEl: HTMLElement): { top: number; left: number; width: number } {
    const rect = triggerEl.getBoundingClientRect();
    return { top: rect.bottom + 4, left: rect.left, width: rect.width };
  }

  function formatShortDate(value: string | null | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatRelativeTime(value: string | null | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const diffSec = (Date.now() - date.getTime()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
    if (diffSec < 45) return rtf.format(0, "second");
    if (diffSec < 3600) return rtf.format(-Math.round(diffSec / 60), "minute");
    if (diffSec < 86400) return rtf.format(-Math.round(diffSec / 3600), "hour");
    if (diffSec < 604800) return rtf.format(-Math.round(diffSec / 86400), "day");
    return formatShortDate(value);
  }

  return (
    <div className={cn(
        sidebarCollapsed ? 'w-[54px] min-w-[54px]' : 'w-[var(--sw)] min-w-[var(--sw)]',
        'shrink-0 overflow-hidden border-r border-border bg-surface flex flex-col backdrop-blur-md transition-all duration-[180ms] ease-out'
      )}>
        {/* DYNAMIC: justifyContent and padding depend on sidebarCollapsed state */}
        <div
          className={`flex h-[60px] shrink-0 items-center border-b border-border ${sidebarCollapsed ? "justify-center px-1.5" : "gap-2.5 px-3"}`}
        >
          {sidebarCollapsed ? (
            // Collapsed: the logo doubles as the brand mark and the expand
            // trigger (click to expand). Standard collapsed-sidebar pattern.
            <CustomTooltip content={t("sidebar_expand")} side="right">
              <button type="button"
                className="flex items-center rounded-md p-1 cursor-pointer text-t3 transition-[background,color] duration-100 hover:bg-s2 hover:text-t1"
                aria-label={t("sidebar_expand")}
                onClick={() => setSidebarCollapsed(false)}
              >
                <Logo className="h-[34px] w-[34px] shrink-0" />
              </button>
            </CustomTooltip>
          ) : (
            <>
              {/* Brand zone: fills everything left of the collapse button and
                  centers its content within that zone — so the logo+text sit
                  at the visual midpoint between the left edge and the button,
                  not the geometric midpoint of the whole sidebar. */}
              <div className="flex min-w-0 flex-1 items-center justify-center gap-2.5">
                <Logo className="h-[34px] w-[34px] shrink-0" />
                <span className="min-w-0 overflow-hidden whitespace-nowrap font-body text-[length:calc(var(--ui-fs)+1px)] font-medium tracking-[-0.01em] text-t1">{t("app_name")}</span>
              </div>
              <CustomTooltip content={t("sidebar_collapse")} side="right">
                <button type="button"
                  className="iBtn shrink-0"
                  aria-label={t("sidebar_collapse")}
                  onClick={() => setSidebarCollapsed(true)}
                >
                  <Icons.Caret direction="l" />
                </button>
              </CustomTooltip>
            </>
          )}
        </div>

        {sidebarCollapsed && mode === 'play' && (
          <div className="flex min-h-0 flex-1 flex-col items-center">
            <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto py-2 px-[7px]">
              {characterTabs.map((tab) => {
                const isMarked = tab.id === activeChatCharacterId || tab.chatId === activeChatId;
                return (
                  <CustomTooltip key={tab.id} content={tab.name} side="right">
                    <div
                      ref={(el) => { if (el) flyoutAvatarRefs.current.set(tab.id, el); else flyoutAvatarRefs.current.delete(tab.id); }}
                      className={cn(
                        'relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all duration-150',
                        isMarked ? '' : 'hover:bg-s2',
                      )}
                      onClick={() => {
                        // Flyout toggle only — selectedCharacterId is synced after a real chat switch.
                        const r = flyoutAvatarRefs.current.get(tab.id)?.getBoundingClientRect();
                        setFlyoutAvatarPos(r ? { top: r.top, bottom: r.bottom } : null);
                        setFlyoutCharId(prev => prev === tab.id ? null : tab.id);
                      }}
                    >
                      {/* Pill-индикатор для активного персонажа */}
                      {isMarked && (
                        <div className="absolute -left-[7px] top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-accent transition-all" />
                      )}
                      <span className={cn(
                        'flex h-full w-full items-center justify-center overflow-hidden rounded-full font-ui text-sm',
                        tabAvatarSrc(tab) ? 'bg-s3' : isMarked ? 'bg-accent text-on-accent' : 'bg-s3 text-t2',
                        flyoutCharId === tab.id
                          ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
                          : (!tabAvatarSrc(tab) && isMarked) ? 'ring-1 ring-accent/50 ring-offset-2 ring-offset-surface' : '',
                      )}>
                        {tabAvatarSrc(tab) ? <img src={tabAvatarSrc(tab)!} alt={tab.name} className="h-full w-full object-cover" /> : initials(tab.name)}
                      </span>
                    </div>
                  </CustomTooltip>
                );
              })}
            </div>

            <div className="h-px w-8 shrink-0 bg-border" />

            <div className="flex shrink-0 flex-col items-center gap-1 py-2">
              <CustomTooltip content={t("sidebar_prompt_manager")} side="right">
                <div className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)}><Icons.Terminal /></div>
              </CustomTooltip>
              <CustomTooltip content={personaName} side="right">
                <div className="flex h-9 w-9 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPersonaModalOpen(true)}>
                  {personaAvatarSrc ? <img src={personaAvatarSrc!} alt="" className="h-full w-full object-cover" /> : initials(personaName)}
                </div>
              </CustomTooltip>
            </div>
          </div>
        )}

        {/* ═══ FLYOUT: Chat selection — collapsed sidebar ═══ */}
        {flyoutCharId && sidebarCollapsed && createPortal(
          (() => {
            const tab = characterTabs.find(tc => tc.id === flyoutCharId);
            const q = chatQuery.trim().toLowerCase();
            const filtered = q ? flyoutChats.filter(c => c.title.toLowerCase().includes(q)) : flyoutChats;
            return (
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
                      <button type="button" className="iBtn size-7 shrink-0" aria-label={t("new_chat")} onClick={() => { void character.handleCreateChat(flyoutCharId); }}><Icons.Plus /></button>
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
                      <div className="empty-title">{t("sidebar_send_a_message")}</div>
                      <button type="button" className="empty-cta" onClick={() => { void character.handleCreateChat(flyoutCharId); }}>{t("new_chat")}</button>
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                      <Icons.Search className="h-5 w-5 text-t4" />
                      <div className="text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">{t("chat_search_no_results").replace("{query}", chatQuery)}</div>
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

              </div>
            );
          })(),
          document.body,
        )}

        {sidebarCollapsed && mode === 'build' && (
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-0 py-2">
            <CustomTooltip content={snapshot?.character?.name ?? t('switch_character')} side="right">
              <div
                ref={charSwitcherTriggerRef}
                className={cn('flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all duration-150', charSwitcherOpen ? '' : 'hover:bg-s2')}
                onClick={() => {
                  // Measure from the stable ref, not e.currentTarget — the trigger
                  // is wrapped by Radix Tooltip.Trigger asChild, which clones the
                  // node and makes the synthetic event's currentTarget unreliable
                  // by the time the inline handler runs (caused a null-ref crash).
                  const el = charSwitcherTriggerRef.current;
                  setCharSwitcherOpen(v => !v);
                  setCharSwitcherPos(prev => prev || !el ? prev : calcSwitcherPos(el));
                }}
              >
                <span className={cn("flex h-full w-full items-center justify-center overflow-hidden rounded-full font-ui text-sm", activeCharAvatarSrc ? "bg-s3" : "bg-accent text-on-accent", charSwitcherOpen && "ring-1 ring-accent/50 ring-offset-2 ring-offset-surface")}>
                  {activeCharAvatarSrc
                    ? <img src={activeCharAvatarSrc!} alt="" className="h-full w-full object-cover" />
                    : initials(snapshot?.character?.name ?? '?')}
                </span>
              </div>
            </CustomTooltip>
            {charSwitcherOpen && charSwitcherPos && createPortal(
              <div
                className="glass-blur fixed max-h-[280px] overflow-y-auto rounded-lg border border-border bg-glass-bg p-1 shadow-theme-md z-[400]"
                ref={charSwitcherRef}
                style={{ top: charSwitcherPos.top, left: charSwitcherPos.left, width: charSwitcherPos.width }}
              >
                <div className="grid grid-cols-1 gap-1">
                {characterTabs.map(tab => (
                  <CustomTooltip key={tab.id} content={tab.name} side="right">
                    <div
                      className={cn('flex h-10 w-10 shrink-0 mx-auto cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all hover:bg-s2', tab.id === snapshot?.character?.id && 'ring-1 ring-accent/50 ring-offset-2 ring-offset-surface')}
                      onClick={() => {
                        if (tab.chatId) { void chat.handleSwitchChat(tab.chatId); }
                        else { void character.handleCreateChat(tab.id); }
                        setCharSwitcherOpen(false); setCharSwitcherPos(null);
                      }}
                    >
                      {tabAvatarSrc(tab)
                        ? <img className="h-full w-full object-cover" src={tabAvatarSrc(tab)!} alt={tab.name} />
                        : <span className="flex h-full w-full items-center justify-center rounded-full bg-s3 font-ui text-xs text-t2">{initials(tab.name)}</span>}
                    </div>
                  </CustomTooltip>
                ))}
                </div>
              </div>,
              document.body,
            )}

            <div className="my-1 h-px w-8 shrink-0 bg-border" />

            {buildPanelItems.map((item) => (
              <CustomTooltip key={item.id} content={t(item.labelKey)} side="right">
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center transition-all duration-150',
                    buildTab === item.id 
                      ? 'rounded-xl bg-accent-dim text-accent-t'
                      : 'rounded-full hover:rounded-xl hover:bg-s2'
                  )}
                  onClick={() => setBuildTab(item.id)}
                >
                  {item.icon}
                </div>
              </CustomTooltip>
            ))}

            <div className="mt-auto flex shrink-0 flex-col items-center gap-1">
              <CustomTooltip content={t("sidebar_prompt_manager")} side="right">
                <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)}><Icons.Terminal /></div>
              </CustomTooltip>
              <CustomTooltip content={personaName} side="right">
                <div className="flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPersonaModalOpen(true)}>
                  {personaAvatarSrc ? <img src={personaAvatarSrc!} alt="" className="h-full w-full object-cover" /> : initials(personaName)}
                </div>
              </CustomTooltip>
            </div>
          </div>
        )}

        {!sidebarCollapsed && mode === 'play' && (
          <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <section className="min-h-0 max-h-[50%] overflow-y-auto border-b border-border py-1.5">
              <div className="flex items-center pr-2.5">
                <div className="flex-1 px-[13px] pt-1 pb-[5px] text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("sidebar_characters")}</div>
                <CustomTooltip content={t("sidebar_import_character")}>
                  <button type="button" className="iBtn size-5" onClick={() => setImportModal("character")}>
                    <Icons.Import />
                  </button>
                </CustomTooltip>
                <CustomTooltip content={t("sidebar_create_character")}>
                  <button type="button" className="iBtn size-5" onClick={() => useModalStore.getState().setCreateCharacterModalOpen(true)}>
                    <Icons.Plus />
                  </button>
                </CustomTooltip>
              </div>
              {characterTabs.length === 0 ? (
                <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
                  {t("sidebar_no_characters")}
                </div>
              ) : (
                characterTabs.map((tab) => {
                  const isActive = isCharacterTabActive(tab);
                  const menuOpen = charMenuId === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className={cn(
                        'group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] transition-colors duration-100',
                        isActive ? 'bg-accent-dim text-accent-t hover:bg-accent-dim hover:text-accent-t' : 'text-t2 hover:bg-s2 hover:text-t1'
                      )}
                      style={{ zIndex: menuOpen ? 100 : 1 }}
                      onClick={() => {
                        useChatStore.getState().setSelectedCharacterId(tab.id);
                        if (tab.chatId) {
                          void chat.handleSwitchChat(tab.chatId);
                        }
                      }}
                    >
                      <span className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full font-ui text-[calc(var(--ui-fs)-2px)] not-italic avatar-fallback initials crop-framing',
                        isActive ? 'bg-accent text-on-accent' : 'bg-s3 text-t2'
                      )}>{tabAvatarSrc(tab) ? <img src={tabAvatarSrc(tab)!} alt={tab.name} className="h-full w-full object-cover" /> : initials(tab.name)}</span>
                      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {tab.name}
                      </span>

                      {!menuOpen && (
                        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 rounded pl-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                          <CustomTooltip content={t("sidebar_character_actions")}>
                            <button type="button"
                              className="flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1"
                              aria-label={t("sidebar_character_actions")}
                              onClick={(event) => {
                                event.stopPropagation();
                                setCharMenuId(tab.id);
                                setCharMenuPos(calcPopoverPos(event.currentTarget));
                                setChatMenuId(null);
                                setBranchPopId(null);
                              }}
                            >
                              <Icons.Ellipsis />
                            </button>
                          </CustomTooltip>
                        </div>
                      )}

                      {menuOpen && charMenuPos && createPortal(
                        <div
                          className="glass-blur absolute z-[200] w-[190px] rounded-md border border-border2 bg-glass-bg py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                          ref={charMenuRef}
                          onClick={(event) => event.stopPropagation()}
                          style={{ top: charMenuPos.top, right: charMenuPos.right }}
                        >
                          <div
                            className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                            role="menuitem"
                            onClick={() => {
                              setCharMenuId(null); setCharMenuPos(null);
                              character.handleExportCharacter(tab.id);
                            }}
                          >
                            <Icons.Download /> {t("sidebar_export")}
                          </div>

                          <div
                            className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                            role="menuitem"
                            onClick={() => {
                              setCharMenuId(null); setCharMenuPos(null);
                              character.handleDuplicateCharacter(tab.id);
                            }}
                          >
                            <Icons.Copy /> {t("duplicate")}
                          </div>

                          <div
                            className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-danger-text transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                            role="menuitem"
                            onClick={() => {
                              setCharMenuId(null); setCharMenuPos(null);
                              setConfirmDestroy({
                                title: t("sidebar_delete_character"),
                                body: <>{t("sidebar_are_you_sure")} <b>{tab.name}</b></>,
                                confirmLabel: t("delete"),
                                onConfirm: () => character.handleDeleteCharacter(tab.id),
                              });
                            }}
                          >
                            <Icons.Trash /> {t("delete")}
                          </div>
                        </div>,
                        document.body
                      )}
                    </div>
                  );
                })
              )}
            </section>

            <section className="min-h-0 max-h-[50%] overflow-y-auto border-b-0 py-1.5">
              <div className="flex items-center pr-2.5">
                <div className="flex-1 px-[13px] pt-1 pb-[5px] text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("sidebar_chats")}</div>
                <CustomTooltip content={t("sidebar_import_chat")}>
                  <button type="button" className="iBtn size-5" onClick={() => setImportModal("chat")}>
                    <Icons.Import />
                  </button>
                </CustomTooltip>
                <CustomTooltip content={t("sidebar_new_chat_active_char")}>
                  <button type="button" className="iBtn size-5" onClick={() => {
                    const charId = currentCharacterId;
                    void character.handleCreateChat(charId ?? undefined);
                  }}>
                    <Icons.Plus />
                  </button>
                </CustomTooltip>
              </div>
              {chats.length === 0 ? (
                <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
                  {t("sidebar_send_a_message")}
                </div>
              ) : (
                chats.map((chatItem) => {
                  const isActive = chatItem.id === activeChatId;
                  const chatRemovalMode = character.getChatRemovalMode(chatItem.id);
                  const clearsOnRemove = chatRemovalMode === "clear";
                  const chatMenuOpen = chatMenuId === chatItem.id;
                  const branchPopOpen = branchPopId === chatItem.id;
                  const branchCount = isActive ? branches.length : 0;
                  const commitRename = () => {
                    const nextTitle = renameDraft.trim();
                    const currentTitle = chatItem.title.trim();
                    if (!nextTitle || nextTitle === currentTitle) {
                      setRenamingChatId(null);
                      return;
                    }
                    void character.handleRenameChat(chatItem.id, nextTitle);
                    setRenamingChatId(null);
                  };
                  return (
                    <div
                      key={chatItem.id}
                      className="group relative mx-1 flex flex-col rounded"
                      style={{ zIndex: chatMenuOpen || branchPopOpen ? 100 : 1 }}
                    >
                      <div
                        className={cn(
                          'relative cursor-pointer rounded px-2.5 py-1.5 transition-colors duration-100',
                          isActive ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2'
                        )}
                        onClick={() => void chat.handleSwitchChat(chatItem.id)}
                      >
                        {renamingChatId === chatItem.id ? (
                          <input
                            className="mb-px w-full rounded border border-accent bg-bg px-[5px] py-[2px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none"
                            value={renameDraft}
                            autoFocus
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onBlur={commitRename}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitRename();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                setRenamingChatId(null);
                              }
                            }}
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
                                  setBranchPopId((current) => current === chatItem.id ? null : chatItem.id);
                                  setChatMenuId(null);
                                }}
                              >
                                <Icons.Stack /> {branchCount}
                              </div>
                            </CustomTooltip>
                          )}
                        </div>
                      </div>

                      {!chatMenuOpen && renamingChatId !== chatItem.id && (
                        <div className="absolute right-1 top-2 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                          <CustomTooltip content={t("sidebar_chat_actions")}>
                            <button type="button"
                              className={cn(
                                'flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1',
                                isActive && 'hover:text-accent-t'
                              )}
                              aria-label={t("sidebar_chat_actions")}
                              onClick={(event) => {
                                event.stopPropagation();
                                setChatMenuId(chatItem.id);
                                setChatMenuPos(calcPopoverPos(event.currentTarget));
                                setBranchPopId(null);
                              }}
                            >
                              <Icons.Ellipsis />
                            </button>
                          </CustomTooltip>
                        </div>
                      )}

                      {chatMenuOpen && chatMenuPos && createPortal(
                        <div
                          className="glass-blur absolute z-[200] w-[190px] rounded-md border border-border2 bg-glass-bg py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                          ref={chatMenuRef}
                          onClick={(event) => event.stopPropagation()}
                          style={{ top: chatMenuPos.top, right: chatMenuPos.right }}
                        >
                          <div
                            className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                            role="menuitem"
                            onClick={() => {
                              setChatMenuId(null); setChatMenuPos(null);
                              setRenamingChatId(chatItem.id);
                              setRenameDraft(chatItem.title);
                            }}
                          >
                            <Icons.Edit /> {t("sidebar_rename")}
                          </div>

                          <div
                            className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                            role="menuitem"
                            onClick={() => {
                              setChatMenuId(null); setChatMenuPos(null);
                              character.handleExportChatJsonl(chatItem.id);
                            }}
                          >
                            <Icons.Download /> {t("sidebar_export_jsonl")}
                          </div>
                          <div className="my-1 h-px bg-border" />
                          <div
                            className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-danger-text transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                            role="menuitem"
                            onClick={() => {
                              setChatMenuId(null); setChatMenuPos(null);
                              setConfirmDestroy({
                                title: clearsOnRemove ? t("sidebar_clear_chat") : t("sidebar_delete_chat"),
                                body: clearsOnRemove
                                  ? <>{t("sidebar_clear_chat_confirm")} <b>{chatItem.title}</b></>
                                  : <>{t("sidebar_are_you_sure")} <b>{chatItem.title}</b></>,
                                confirmLabel: clearsOnRemove ? t("sidebar_clear_chat") : t("delete"),
                                onConfirm: () => character.handleRemoveChat(chatItem.id),
                              });
                            }}
                          >
                            <Icons.Trash /> {clearsOnRemove ? t("sidebar_clear_chat") : t("delete")}
                          </div>
                        </div>,
                        document.body
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
                                      isActiveBranch ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2/70'
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
                                      isActiveBranch && 'text-accent-t'
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
                            <button  className="inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1 rounded px-1.5 text-center text-[calc(var(--ui-fs)-4px)] text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1 [&_svg]:h-3 [&_svg]:w-3"
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
                                  <button  className={cn(
                                    'inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1 rounded px-1.5 text-center text-[calc(var(--ui-fs)-4px)] text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1 [&_svg]:h-3 [&_svg]:w-3',
                                    !canAct && 'opacity-45 cursor-not-allowed'
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
                })
              )}
            </section>
            </div>

            <section className="shrink-0 border-t border-border px-1 py-1.5">
              <div
                className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
                role="button"
                tabIndex={0}
                onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    useModalStore.getState().setIsPromptManagerOpen(true);
                  }
                }}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-transparent font-ui text-[calc(var(--ui-fs)-3px)] not-italic text-t2">
                  <Icons.Terminal />
                </span>
                <span>{t("sidebar_prompt_manager")}</span>
              </div>
              <div
                className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
                role="button"
                tabIndex={0}
                onClick={() => useModalStore.getState().setIsPersonaModalOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    useModalStore.getState().setIsPersonaModalOpen(true);
                  }
                }}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-ui text-[calc(var(--ui-fs)-2px)] not-italic text-t2">{personaAvatarSrc ? <img src={personaAvatarSrc!} alt="" className="h-full w-full object-cover" /> : initials(personaName)}</span>
                <span>{personaName}</span>
                <span className="ml-auto shrink-0 text-[calc(var(--ui-fs)-3px)] text-t3">
                  {t("sidebar_your_persona")}
                </span>
              </div>
            </section>
          </>
        )}

        {!sidebarCollapsed && mode === 'build' && (
          <>
            {/* Character switcher */}
            <div className="shrink-0 border-b border-border" style={{ padding: '10px 12px' }}>
              <div className="relative">
                <div
                  ref={charSwitcherTriggerRef}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg transition-colors hover:bg-s2"
                  style={{ padding: '6px 8px' }}
                  onClick={() => {
                    // Measure from the stable ref, not e.currentTarget (see the
                    // collapsed-branch trigger for the rationale).
                    const el = charSwitcherTriggerRef.current;
                    setCharSwitcherOpen(v => !v);
                    setCharSwitcherPos(prev => prev || !el ? prev : calcSwitcherPos(el));
                  }}
                >
                  <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full', activeCharAvatarSrc ? '' : 'bg-accent text-on-accent')}>
                    {activeCharAvatarSrc ? (
                      <img className="h-full w-full object-cover" src={activeCharAvatarSrc!} alt="" />
                    ) : (
                      <span className="font-ui text-sm">{initials(snapshot?.character?.name ?? '?')}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{snapshot?.character?.name ?? t('unnamed')}</div>
                    <div className="truncate text-[calc(var(--ui-fs)-3px)] text-t3">{t('sidebar_editing_character')}</div>
                  </div>
                  <Icons.Caret direction={charSwitcherOpen ? "u" : "d"} />
                </div>
                {charSwitcherOpen && characterTabs.length > 1 && charSwitcherPos && createPortal(
                  <div
                    className="glass-blur fixed max-h-[240px] overflow-y-auto rounded-lg border border-border bg-glass-bg py-1 shadow-theme-md z-[400]"
                    ref={charSwitcherRef}
                    style={{ top: charSwitcherPos.top, left: charSwitcherPos.left, width: charSwitcherPos.width }}
                  >
                    {characterTabs.map(tab => (
                      <div
                        key={tab.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 transition-colors',
                          tab.id === snapshot?.character?.id ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2'
                        )}
                        style={{ padding: '6px 12px' }}
                        onClick={() => {
                          if (tab.chatId) { void chat.handleSwitchChat(tab.chatId); }
                          else { void character.handleCreateChat(tab.id); }
                          setCharSwitcherOpen(false); setCharSwitcherPos(null);
                        }}
                      >
                        <div className={cn('flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full', tabAvatarSrc(tab) ? '' : tab.id === snapshot?.character?.id ? 'bg-accent text-on-accent' : 'bg-s3 text-t2')}>
                          {tabAvatarSrc(tab)
                            ? <img className="h-full w-full object-cover" src={tabAvatarSrc(tab)!} alt={tab.name} />
                            : <span className="font-ui text-[calc(var(--ui-fs)-4px)]">{initials(tab.name)}</span>}
                        </div>
                        <span className={cn('truncate text-[calc(var(--ui-fs)-1px)]', tab.id === snapshot?.character?.id ? 'text-accent-t font-medium' : 'text-t2')}>{tab.name}</span>
                      </div>
                    ))}
                  </div>,
                  document.body,
                )}
              </div>
            </div>

            {/* Build sections navigation */}
            <div className="flex-1 overflow-y-auto py-1">
              <div className="font-ui text-[calc(var(--ui-fs)-5px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ padding: '9px 15px 7px' }}>{t('sidebar_build_editor')}</div>
              {buildPanelItems.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'mx-1 flex cursor-pointer items-center gap-2.5 rounded px-3.5 py-2 font-ui text-[calc(var(--ui-fs)-1px)] transition-all',
                    buildTab === item.id 
                      ? 'bg-accent-dim text-accent-t'
                      : 'text-t2 hover:bg-s2 hover:text-t1'
                  )}
                  onClick={() => setBuildTab(item.id)}
                >
                  {item.icon}
                  <span>{t(item.labelKey)}</span>
                </div>
              ))}
            </div>

            {/* Footer */}
            <section className="shrink-0 border-t border-border px-1 py-1.5">
              <div
                className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
                role="button" tabIndex={0}
                onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-transparent font-ui text-[calc(var(--ui-fs)-3px)] not-italic text-t2">
                  <Icons.Terminal />
                </span>
                <span>{t('sidebar_prompt_manager')}</span>
              </div>
              <div
                className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
                role="button" tabIndex={0}
                onClick={() => useModalStore.getState().setIsPersonaModalOpen(true)}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-ui text-[calc(var(--ui-fs)-2px)] not-italic text-t2">
                  {personaAvatarSrc ? <img src={personaAvatarSrc!} alt="" className="h-full w-full object-cover" /> : initials(personaName)}
                </span>
                <span>{personaName}</span>
                <span className="ml-auto shrink-0 text-[calc(var(--ui-fs)-3px)] text-t3">{t('sidebar_your_persona')}</span>
              </div>
            </section>
          </>
        )}
        {importModal === "character" && (
          <CharacterImportModal
            isImporting={character.isImporting}
            onClose={() => setImportModal(null)}
            onImportFiles={(files) => void character.handleImportFiles(files)}
          />
        )}
        {importModal === "chat" && (
          <ChatImportModal
            activeChatId={activeChatId}
            isImporting={character.isImporting}
            onClose={() => setImportModal(null)}
            onImportFiles={(files) => void character.handleImportFiles(files)}
          />
        )}
      </div>
  );
}

function SidebarBranchRename({ branchId, initialLabel, onRename }: { branchId: string; initialLabel: string; onRename: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialLabel);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useT();

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="w-full min-w-0 rounded border border-accent bg-s2 px-1 py-0.5 text-[calc(var(--ui-fs)-3px)] text-t1 outline-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const trimmed = value.trim();
          if (trimmed && trimmed !== initialLabel) onRename(trimmed);
          else setValue(initialLabel);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); }
          if (e.key === "Escape") { setValue(initialLabel); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <button
      type="button"
      className="shrink-0 cursor-pointer rounded p-0.5 text-t3 opacity-0 transition-all hover:bg-s3 hover:text-t1 group-hover/branch:opacity-100"
      onClick={(e) => { e.stopPropagation(); setValue(initialLabel); setEditing(true); }}
    >
      <Icons.Edit />
    </button>
  );
}
