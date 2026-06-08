import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { Ic } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { avatarUrl } from "../../lib/avatar.js";
import { initials } from "./app-shell-helpers.js";
import { CharacterImportModal, ChatImportModal } from "../modals/ImportModals.js";
import { useT } from "../../i18n/context.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { activateBranchAction, renameBranchAction } from "../../stores/api-actions/chat-actions.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useNavigationStore, useChatStore, useModalStore } from "../../stores/index.js";
import { useCharacterStore } from "../../stores/character-store.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useBuildPanels } from "../../hooks/use-build-panels.js";
import type { ChatListItem } from "../../app-client.js";

/* ── Mini icon button (collapsed rail item) ── */
function Ico({ icon, active, onClick, title }: { icon: React.ReactNode; active?: boolean; onClick: () => void; title: string }) {
  return (
    <div
      className={cn(
        "flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition-all duration-150 active:bg-s3 active:scale-95",
        active ? "rounded-xl bg-accent-dim text-accent-t" : "text-t3",
      )}
      onClick={onClick}
      title={title}
    >
      {icon}
    </div>
  );
}

function NavRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <div
      className="flex h-9 cursor-pointer items-center rounded-md transition-colors duration-100 active:bg-s3 gap-3 px-2.5 w-full"
      onClick={onClick}
    >
      <div className="flex h-4 w-4 shrink-0 items-center justify-center opacity-80">{icon}</div>
      <span className="min-w-0 truncate font-ui text-[clamp(11px,calc(var(--ui-fs)-2px),15px)] font-medium tracking-wide text-t2">{label}</span>
    </div>
  );
}

function RailRow({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <div
      className={cn(
        "flex min-h-[44px] cursor-pointer items-center rounded-md transition-colors duration-100 active:bg-s3 gap-2.5 px-3 w-full",
        active ? "bg-accent-dim text-accent-t" : "text-t3",
      )}
      onClick={onClick}
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</div>
      <span className="truncate font-ui text-[calc(var(--ui-fs)-1px)]">{label}</span>
    </div>
  );
}

export function Rail({ hidden }: { hidden?: boolean }) {
  const { t } = useT();
  const mode = useNavigationStore((s) => s.mode);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const allCharacters = useBootstrapStore((s) => s.data)?.allCharacters ?? [];
  const chatMeta = useChatMeta();
  const chats: ChatListItem[] = chatMeta?.chats ?? [];
  const branches = chatMeta?.branches ?? [];
  const activeBranchId = chatMeta?.activeBranch?.id ?? null;

  // Ветки доступны только для активного чата (подгружаются через snapshot)
  const activeChatBranches = activeChatId ? branches : [];
  const buildPanels = useBuildPanels();

  const character = useCharacterController();
  const chat = useChatController();
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  const [expanded, setExpanded] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [chatImportOpen, setChatImportOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState<string | null>(null);

  // Context menus
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  const [chatMenuId, setChatMenuId] = useState<ChatId | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Chat rename
  const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Hamburger force-open from TopBar
  const forceOpen = useNavigationStore((s) => s.railForceOpen);
  useEffect(() => {
    if (forceOpen > 0) setExpanded(true);
  }, [forceOpen]);

  // Close menu on outside click
  useEffect(() => {
    if (charMenuId === null && chatMenuId === null) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCharMenuId(null);
        setChatMenuId(null);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [charMenuId, chatMenuId]);

  // Filter: only non-archived characters
  const visibleChars = allCharacters.filter(() => true);

  // Chats for the selected/active character
  const activeCharId = selectedCharacterId ?? chatMeta?.character?.id ?? null;
  const activeCharChats = chats.filter((ch) => ch.characterId === activeCharId);

  const toggle = () => {
    if (expanded) {
      setClosing(true);
      setTimeout(() => { setExpanded(false); setClosing(false); }, 200);
    } else {
      setExpanded(true);
    }
  };
  const close = () => {
    if (!expanded) return;
    setClosing(true);
    setTimeout(() => { setExpanded(false); setClosing(false); }, 200);
  };

  const closeMenu = () => {
    setCharMenuId(null);
    setChatMenuId(null);
  };

  const commitRename = () => {
    const nextTitle = renameDraft.trim();
    if (nextTitle && renamingChatId) {
      void character.handleRenameChat(renamingChatId, nextTitle);
    }
    setRenamingChatId(null);
  };

  /* ── Swipe on expanded panel to close ── */
  const panelDragRef = useRef({ active: false, startX: 0, currentX: 0 });
  const onPanelTouchStart = useCallback((e: React.TouchEvent) => {
    panelDragRef.current = { active: true, startX: e.touches[0].clientX, currentX: e.touches[0].clientX };
  }, []);
  const onPanelTouchMove = useCallback((e: React.TouchEvent) => {
    if (!panelDragRef.current.active) return;
    panelDragRef.current.currentX = e.touches[0].clientX;
  }, []);
  const onPanelTouchEnd = useCallback(() => {
    if (!panelDragRef.current.active) return;
    panelDragRef.current.active = false;
    const delta = panelDragRef.current.currentX - panelDragRef.current.startX;
    if (delta < -40) close();
  }, [close]);

  const dragRef = useRef({ active: false, startX: 0, startExpanded: false, delta: 0 });
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    dragRef.current = { active: true, startX: e.touches[0].clientX, startExpanded: expanded, delta: 0 };
  }, [expanded]);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.delta = e.touches[0].clientX - dragRef.current.startX;
  }, []);
  const onTouchEnd = useCallback(() => {
    if (!dragRef.current.active) return;
    const d = dragRef.current.delta;
    dragRef.current.active = false;
    if (!dragRef.current.startExpanded && d > 40) setExpanded(true);
    if (dragRef.current.startExpanded && d < -40) setExpanded(false);
  }, []);

  /* ── Bottom sheet (action sheet) для мобильных ── */
  /* ── Bottom sheet swipe-to-dismiss state ── */
  const sheetDragRef = useRef({ active: false, startY: 0, currentY: 0 });

  const onSheetTouchStart = useCallback((e: React.TouchEvent) => {
    sheetDragRef.current = { active: true, startY: e.touches[0].clientY, currentY: e.touches[0].clientY };
  }, []);
  const onSheetTouchMove = useCallback((e: React.TouchEvent) => {
    if (!sheetDragRef.current.active) return;
    sheetDragRef.current.currentY = e.touches[0].clientY;
    // Визуально двигаем sheet за пальцем
    const delta = sheetDragRef.current.currentY - sheetDragRef.current.startY;
    if (delta > 0 && menuRef.current) {
      menuRef.current.style.transform = `translateY(${delta}px)`;
      menuRef.current.style.transition = 'none';
    }
  }, []);
  const onSheetTouchEnd = useCallback(() => {
    if (!sheetDragRef.current.active) return;
    sheetDragRef.current.active = false;
    const delta = sheetDragRef.current.currentY - sheetDragRef.current.startY;
    if (menuRef.current) {
      menuRef.current.style.transform = '';
      menuRef.current.style.transition = '';
    }
    // Свайп вниз больше чем на 80px → закрыть
    if (delta > 80) closeMenu();
  }, []);

  const bottomSheet = (title: string, items: Array<{ icon: React.ReactNode; label: string; danger?: boolean; action: () => void }>) => {
    return createPortal(
      <>
        {/* Затемнение */}
        <div
          className="fixed inset-0 z-[500] bg-black/50"
          style={{ animation: "fadeIn 0.15s ease-out" }}
          onClick={closeMenu}
        />
        {/* Sheet */}
        <div
          className="fixed inset-x-0 bottom-0 z-[501] rounded-t-2xl border-t border-border2 bg-surface pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_24px_rgba(0,0,0,0.5)]"
          ref={menuRef}
          style={{ animation: "slideUp 0.2s ease-out" }}
          onTouchStart={onSheetTouchStart}
          onTouchMove={onSheetTouchMove}
          onTouchEnd={onSheetTouchEnd}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1">
            <div className="h-1 w-10 rounded-full bg-border" />
          </div>
          {/* Title */}
          <div className="px-5 pb-2 pt-1">
            <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{title}</span>
          </div>
          {/* Items */}
          {items.map((item, i) => (
            <button type="button"
              key={i}
              className={cn(
                "flex w-full cursor-pointer items-center gap-4 px-5 min-h-[52px] text-[calc(var(--ui-fs)+1px)] transition-colors duration-100 active:bg-s3 text-left",
                item.danger ? "text-danger-text" : "text-t2",
              )}
              onClick={() => { closeMenu(); item.action(); }}
            >
              <span className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                item.danger ? "bg-danger-dim/50" : "bg-s2",
              )}>
                {item.icon}
              </span>
              <span className={cn("font-ui", item.danger && "font-medium")}>{item.label}</span>
            </button>
          ))}
          {/* Cancel */}
          <div className="h-px bg-border mx-4 mt-2" />
          <button type="button"
            className="flex w-full cursor-pointer items-center justify-center min-h-[52px] text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3 rounded-b-2xl"
            onClick={closeMenu}
          >
            {t("cancel") ?? "Отмена"}
          </button>
        </div>
      </>,
      document.body,
    );
  };

  return (
    <>
      {/* ═══ COLLAPSED RAIL ═══ */}
      {!hidden && (
      <div
        className="relative z-[200] flex w-[56px] min-w-[56px] shrink-0 flex-col items-center border-r border-border bg-surface"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Hamburger */}
        <div className="flex h-[48px] w-full shrink-0 items-center justify-center border-b border-border">
          <div className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors duration-100 active:bg-s3"
               onClick={toggle}>
            <Ic.menu />
          </div>
        </div>

        {/* Middle icons */}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-scroll overflow-x-hidden py-2">
          {mode === "build" ? (
            buildPanels.map((panel) => (
              <Ico key={panel.id} icon={panel.icon} onClick={() => { useCharacterStore.getState().setBuildTab(panel.id); useNavigationStore.getState().setMode('build'); }} title={t(panel.labelKey)} />
            ))
          ) : (
            <>
              {/* Create + Import */}
              <div className="flex w-full flex-col gap-1 px-2">
                <div className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg text-t3 transition-colors active:bg-s3"
                     onClick={() => { useModalStore.getState().setCreateCharacterModalOpen(true); }}
                     title={t("create_manual")}>
                  <Ic.plus />
                </div>
                <div className="flex h-10 w-full cursor-pointer items-center justify-center rounded-lg text-t3 transition-colors active:bg-s3"
                     onClick={() => { setImportOpen(true); }}
                     title={t("import_char_short")}>
                  <Ic.import />
                </div>
              </div>
              <div className="h-px w-8 shrink-0 bg-border" />
              {/* Character avatars (max 5, +N more) */}
              {visibleChars.slice(0, 5).map((c) => (
                <div
                  key={c.id}
                  className={cn(
                    "flex h-10 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all duration-150 active:rounded-xl active:bg-s2 active:scale-95",
                    selectedCharacterId === c.id && "rounded-xl bg-accent-dim ring-2 ring-accent",
                  )}
                  onClick={() => { useChatStore.getState().setSelectedCharacterId(c.id); }}
                  title={c.name}
                >
                  {c.avatarAssetId ? (
                    <img className="h-full w-full object-cover" src={avatarUrl(c.avatarAssetId)} alt={c.name} />
                  ) : (
                    <span className={cn("flex h-full w-full items-center justify-center rounded-full font-ui text-sm", selectedCharacterId === c.id ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>{initials(c.name)}</span>
                  )}
                </div>
              ))}
              {visibleChars.length > 5 && (
                <div
                  className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-s3 font-ui text-[11px] font-medium text-t2 transition-all duration-150 active:rounded-xl active:bg-s2 active:scale-95"
                  onClick={() => setExpanded(true)}
                  title={t("more_characters") ?? `${visibleChars.length - 5} more`}
                >
                  +{visibleChars.length - 5}
                </div>
              )}
              <div className="my-0.5 h-px w-8 shrink-0 bg-border" />
              {/* Chat indicators for active character */}
              {activeCharChats.map((ch) => {
                const initial = (ch.title || "?").trim().charAt(0).toUpperCase() || "?";
                return (
                  <div key={ch.id}
                       className={cn(
                         "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full font-ui text-xs font-medium transition-all duration-150 active:rounded-xl active:bg-s2",
                         ch.id === activeChatId ? "rounded-xl bg-accent text-on-accent" : "bg-s3 text-t2",
                       )}
                       onClick={() => { void chat.handleSwitchChat(ch.id); }}
                       title={ch.title}>
                    {initial}
                  </div>
                );
              })}
              {/* + New chat in collapsed rail */}
              <div
                key="new-chat-collapsed"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-border2 text-t3 transition-all active:bg-s3"
                onClick={() => { void character.handleCreateChat(selectedCharacterId ?? undefined); }}
                title={t("new_chat")}
              >
                <Ic.plus />
              </div>
              <div className="my-0.5 h-px w-8 shrink-0 bg-border" />
            </>
          )}
        </div>

        {/* Bottom quick actions */}
        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border py-2">
          <Ico icon={<Ic.terminal />} onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)} title={t("prompt_manager")} />
          <Ico icon={<Ic.stack />} onClick={() => useModalStore.getState().setContextMemoryOpen(true)} title={t("scenario_memory")} />
          <Ico icon={<Ic.plug />} onClick={() => useModalStore.getState().setIsProviderModalOpen(true)} title={t("provider_settings_tooltip")} />
          <Ico icon={<Ic.sliders />} onClick={() => useModalStore.getState().setTweaksOpen(true)} title={t("interface_settings_tooltip")} />
        </div>
      </div>
      )}

      {/* ═══ EXPANDED OVERLAY PANEL ═══ */}
      {expanded && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[299] bg-black/40"
            style={{ animation: closing ? "fadeOut 0.2s ease-in forwards" : "fadeIn 0.2s ease-out" }}
            onClick={close}
          />

          {/* Panel */}
          <div
            className="fixed left-0 top-0 bottom-0 z-[300] flex w-[260px] flex-col border-r border-border bg-surface shadow-theme-xl"
            style={{ animation: closing ? "slideOutLeft 0.2s ease-in forwards" : "slideInLeft 0.2s ease-out" }}
            onTouchStart={onPanelTouchStart}
            onTouchMove={onPanelTouchMove}
            onTouchEnd={onPanelTouchEnd}
          >
            {/* Header */}
            <div className="flex h-[48px] shrink-0 items-center border-b border-border px-3">
              <div className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors active:bg-s3"
                   onClick={toggle}>
                <Ic.menu />
              </div>
              <span className="ml-2 font-ui text-[calc(var(--ui-fs)+1px)] font-semibold text-t1 tracking-tight truncate">
                {mode === "build" ? t("editor") : t("characters")}
              </span>
            </div>

            {/* Scrollable content */}
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-scroll px-2 py-2">
              {mode === "build" ? (
                buildPanels.map((panel) => (
                  <RailRow key={panel.id} icon={panel.icon} label={t(panel.labelKey)}
                       onClick={() => { useCharacterStore.getState().setBuildTab(panel.id); close(); }} />
                ))
              ) : (
                <>
                  {/* Create + Import grid */}
                  <div className="grid grid-cols-2 gap-1.5 px-1">
                    <div className="flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border2 bg-s2/50 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors active:bg-s3 active:scale-[0.97]"
                         onClick={() => { useModalStore.getState().setCreateCharacterModalOpen(true); close(); }}>
                      <Ic.plus /> <span className="truncate">{t("create_manual")}</span>
                    </div>
                    <div className="flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border2 bg-s2/50 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors active:bg-s3 active:scale-[0.97]"
                         onClick={() => { setImportOpen(true); close(); }}>
                      <Ic.import /> <span className="truncate">{t("import_char_short")}</span>
                    </div>
                  </div>
                  <div className="my-1 h-px bg-border" />

                  {visibleChars.map((c) => (
                    <React.Fragment key={c.id}>
                      {/* Character row — soft card */}
                      <div
                        className={cn(
                          "group relative flex min-h-[56px] cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors active:bg-s3 active:scale-[0.97]",
                          selectedCharacterId === c.id ? "bg-s2 border border-accent/20" : "bg-s2/30",
                        )}
                        onClick={() => { useChatStore.getState().setSelectedCharacterId(c.id); }}
                      >
                        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg", selectedCharacterId === c.id ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>
                          {c.avatarAssetId ? <img className="h-full w-full object-cover" src={avatarUrl(c.avatarAssetId)} alt={c.name} /> : initials(c.name)}
                        </div>
                        <span className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)] text-t1">{c.name}</span>
                        {/* Three-dot menu button */}
                        <button type="button"
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-t3 transition-colors hover:text-t1 active:bg-s3",
                            charMenuId === c.id && "text-t1 bg-s3",
                          )}
                          onClick={(e) => { e.stopPropagation(); setCharMenuId(c.id); setChatMenuId(null); }}
                        >
                          <Ic.ellipsis />
                        </button>
                      </div>

                      {/* Chats for active character */}
                      {c.id === selectedCharacterId && (
                        <div className={cn(
                          "ml-3 flex flex-col gap-1 border-l-2 pl-2 py-1 transition-colors",
                          activeCharChats.some(ch => ch.id === activeChatId) ? "border-accent/50" : "border-border"
                        )}>
                          {activeCharChats.map((ch) => (
                            <div key={ch.id}
                                 className={cn(
                                   "group relative flex min-h-[48px] cursor-pointer flex-col rounded-lg px-3 py-2 transition-colors active:scale-[0.97]",
                                   ch.id === activeChatId
                                     ? "bg-accent-dim border border-accent/30"
                                     : "bg-s2/30 active:bg-s3",
                                 )}
                                 onClick={() => { void chat.handleSwitchChat(ch.id); }}>
                              {renamingChatId === ch.id ? (
                                <input
                                  className="mb-px w-full rounded border border-accent bg-bg px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none"
                                  value={renameDraft}
                                  autoFocus
                                  onChange={(e) => setRenameDraft(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  onBlur={commitRename}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                                    else if (e.key === "Escape") { e.preventDefault(); setRenamingChatId(null); }
                                  }}
                                />
                              ) : (
                                <span className={cn("min-w-0 truncate pr-12 text-[calc(var(--ui-fs)-2px)]", ch.id === activeChatId ? "text-accent-t font-medium" : "text-t2")}>
                                  {ch.title}
                                </span>
                              )}
                              <span className="min-w-0 truncate pr-12 text-[calc(var(--ui-fs)-4px)] text-t3">
                                {ch.subtitle}
                              </span>

                              {/* Chat three-dot menu — увеличенный touch target */}
                              <button type="button"
                                className={cn(
                                  "absolute right-1 inset-y-0 my-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-t3 transition-colors hover:text-t1 active:bg-s3",
                                  chatMenuId === ch.id && "text-t1 bg-s3",
                                )}
                                onClick={(e) => { e.stopPropagation(); setChatMenuId(ch.id); setCharMenuId(null); }}
                              >
                                <Ic.ellipsis />
                              </button>

                              {/* Branches — только для активного чата (данные в snapshot) */}
                              {ch.id === activeChatId && activeChatBranches.length > 0 && (
                                <>
                                <button type="button"
                                  className="mt-1 flex min-h-[44px] items-center gap-1.5 rounded-md px-1 text-[calc(var(--ui-fs)-3px)] text-t4 active:bg-s3 active:text-t2 transition-colors"
                                  onClick={(e) => { e.stopPropagation(); setBranchesOpen(branchesOpen === ch.id ? null : ch.id); }}
                                >
                                  <Ic.branch /> {activeChatBranches.length} {t("branches")}
                                </button>
                                {branchesOpen === ch.id && (
                                  <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-border/30 pl-2">
                                    {activeChatBranches.map((b) => (
                                      <div
                                        key={b.id}
                                        className={cn(
                                          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 min-h-[44px] text-[calc(var(--ui-fs)-2px)] transition-colors active:bg-s3",
                                          b.id === activeBranchId ? "text-accent-t font-medium bg-accent-dim/50" : "text-t3"
                                        )}
                                        onClick={(e) => { e.stopPropagation(); void activateBranchAction(ch.id as ChatId, b.id as ChatBranchId); }}
                                      >
                                        <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", b.id === activeBranchId ? "bg-accent" : "bg-border2")} />
                                        <span className="truncate">{b.label || t("sidebar_unnamed_branch")}</span>
                                        <button type="button" className="ml-auto shrink-0 cursor-pointer rounded p-1 text-t3 transition-all active:bg-s3 active:text-t1" onClick={(e) => { e.stopPropagation(); const newLabel = prompt(t("rename_branch_prompt"), b.label); if (newLabel !== null && newLabel !== b.label) void renameBranchAction(ch.id as ChatId, b.id as ChatBranchId, newLabel); }}>
                                          <Ic.edit />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                </>
                              )}
                              {/* Для неактивных чатов — показываем метку ветки */}
                              {ch.id !== activeChatId && ch.activeBranchLabel && (
                                <span className="mt-0.5 truncate text-[calc(var(--ui-fs)-4px)] text-t4">↳ {ch.activeBranchLabel}</span>
                              )}
                            </div>
                          ))}
                          {/* + New chat */}
                          <div key={`new-chat-${c.id}`}
                               className="flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border-t border-border/50 px-2 pt-2 text-[calc(var(--ui-fs)-2px)] text-t3 transition-colors active:bg-s3 active:text-t1"
                               onClick={() => { void character.handleCreateChat(c.id); }}>
                            <Ic.plus /> {t("new_chat")}
                          </div>
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </>
              )}
            </div>

            {/* Bottom quick actions */}
            <div className="flex shrink-0 flex-col gap-0.5 border-t border-border bg-s2/30 px-2 py-3">
              <NavRow icon={<Ic.terminal />} label={t("prompt_manager")} onClick={() => { useModalStore.getState().setIsPromptManagerOpen(true); close(); }} />
              <NavRow icon={<Ic.stack />} label={t("scenario_memory")} onClick={() => { useModalStore.getState().setContextMemoryOpen(true); close(); }} />
              <NavRow icon={<Ic.plug />} label={t("provider_settings_tooltip")} onClick={() => { useModalStore.getState().setIsProviderModalOpen(true); close(); }} />
              <NavRow icon={<Ic.sliders />} label={t("interface_settings_tooltip")} onClick={() => { useModalStore.getState().setTweaksOpen(true); close(); }} />
            </div>
          </div>
        </>
      )}

      {/* ═══ BOTTOM SHEETS (контекстные меню) ═══ */}
      {charMenuId && bottomSheet(
        visibleChars.find(c => c.id === charMenuId)?.name ?? "",
        [
          { icon: <Ic.download />, label: t("sidebar_export"), action: () => character.handleExportCharacter(charMenuId) },
          { icon: <Ic.copy />, label: t("duplicate"), action: () => character.handleDuplicateCharacter(charMenuId) },
          { icon: <Ic.import />, label: t("sidebar_import_chat"), action: () => setChatImportOpen(true) },
          { icon: <Ic.del />, label: t("delete"), danger: true, action: () => {
            const ch = visibleChars.find(c => c.id === charMenuId);
            setConfirmDestroy({
              title: t("sidebar_delete_character"),
              body: <>{t("sidebar_are_you_sure")} <b>{ch?.name}</b></>,
              confirmLabel: t("delete"),
              onConfirm: () => character.handleDeleteCharacter(charMenuId),
            });
          }},
        ]
      )}

      {chatMenuId && bottomSheet(
        activeCharChats.find(c => c.id === chatMenuId)?.title ?? "",
        [
          { icon: <Ic.edit />, label: t("sidebar_rename"), action: () => {
            const ch = activeCharChats.find(c => c.id === chatMenuId);
            setRenamingChatId(chatMenuId);
            setRenameDraft(ch?.title ?? "");
          }},
          { icon: <Ic.download />, label: t("sidebar_export_jsonl"), action: () => character.handleExportChatJsonl(chatMenuId) },
          { icon: <Ic.del />, label: character.getChatRemovalMode(chatMenuId) === "clear" ? t("sidebar_clear_chat") : t("delete"), danger: true, action: () => {
            const ch = activeCharChats.find(c => c.id === chatMenuId);
            const clearsOnRemove = character.getChatRemovalMode(chatMenuId) === "clear";
            setConfirmDestroy({
              title: clearsOnRemove ? t("sidebar_clear_chat") : t("sidebar_delete_chat"),
              body: clearsOnRemove ? <>{t("sidebar_clear_chat_confirm")} <b>{ch?.title}</b></> : <>{t("sidebar_are_you_sure")} <b>{ch?.title}</b></>,
              confirmLabel: clearsOnRemove ? t("sidebar_clear_chat") : t("delete"),
              onConfirm: () => character.handleRemoveChat(chatMenuId),
            });
          }},
        ]
      )}

      {/* ═══ MODALS ═══ */}
      {importOpen && (
        <CharacterImportModal
          isImporting={character.isImporting}
          onClose={() => setImportOpen(false)}
          onImportFiles={(files) => { void character.handleImportFiles(files); }}
        />
      )}
      {chatImportOpen && (
        <ChatImportModal
          isImporting={character.isImporting}
          activeChatId={activeChatId}
          onClose={() => setChatImportOpen(false)}
          onImportFiles={(files) => { void character.handleImportFiles(files); }}
        />
      )}
    </>
  );
}
