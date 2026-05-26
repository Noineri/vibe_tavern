import React, { useCallback, useRef, useState } from "react";
import type { ChatId } from "@rp-platform/domain";
import { Ic } from "./shared/icons.js";
import { cn } from "../lib/cn.js";
import { avatarUrl } from "../lib/avatar.js";
import { initials } from "./app-shell-helpers.js";
import { useT } from "../i18n/context.js";
import { useBootstrapStore } from "../stores/api-actions/bootstrap-actions.js";
import { useChatDataStore } from "../stores/chat-data-store.js";
import { useNavigationStore, useChatStore, useModalStore } from "../stores/index.js";
import { useBuildPanels } from "../hooks/use-build-panels.js";
import type { ChatListItem } from "../app-client.js";

export function Rail() {
  const { t } = useT();
  const mode = useNavigationStore((s) => s.mode);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const allCharacters = useBootstrapStore((s) => s.data)?.allCharacters ?? [];
  const chatMeta = useChatDataStore((s) => s.chatMeta);
  const chats: ChatListItem[] = chatMeta?.chats ?? [];
  const buildPanels = useBuildPanels();

  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);

  // Filter: only non-archived characters
  const visibleChars = allCharacters.filter((c) => {
    // Bootstrap data doesn't have status; treat all as visible
    return true;
  });

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

  /* ── Mini icon button (collapsed rail item) ── */
  const Ico = ({ icon, active, onClick, title }: { icon: React.ReactNode; active?: boolean; onClick: () => void; title: string }) => (
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

  /* ── Expanded row (build sections) ── */
  const Row = ({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) => (
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

  /* ── Nav row (bottom actions) ── */
  const NavRow = ({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) => (
    <div
      className="flex h-9 cursor-pointer items-center rounded-md transition-colors duration-100 active:bg-s3 gap-3 px-2.5 w-full"
      onClick={onClick}
    >
      <div className="flex h-4 w-4 shrink-0 items-center justify-center opacity-80">{icon}</div>
      <span className="min-w-0 truncate font-ui text-[clamp(11px,calc(var(--ui-fs)-2px),15px)] font-medium tracking-wide text-t2">{label}</span>
    </div>
  );

  return (
    <>
      {/* ═══ COLLAPSED RAIL ═══ */}
      <div
        className="relative z-[200] flex w-[56px] min-w-[56px] shrink-0 flex-col items-center border-r border-border bg-surface"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Hamburger */}
        <div className="flex h-[52px] w-full shrink-0 items-center justify-center border-b border-border">
          <div className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors duration-100 active:bg-s3"
               onClick={toggle}>
            <Ic.menu />
          </div>
        </div>

        {/* Middle icons */}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-scroll overflow-x-hidden py-2">
          {mode === "build" ? (
            buildPanels.map((panel) => (
              <Ico key={panel.id} icon={panel.icon} onClick={() => close()} title={t(panel.labelKey)} />
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
                     onClick={() => { useModalStore.getState().setCreateCharacterModalOpen(true); }}
                     title={t("import_char_short")}>
                  <Ic.import />
                </div>
              </div>
              <div className="h-px w-8 shrink-0 bg-border" />
              {/* Character avatars */}
              {visibleChars.map((c) => (
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
                    <img className="h-full w-full object-cover object-top" src={avatarUrl(c.avatarAssetId)} alt={c.name} />
                  ) : (
                    <span className={cn("flex h-full w-full items-center justify-center rounded-full font-ui text-sm", selectedCharacterId === c.id ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>{initials(c.name)}</span>
                  )}
                </div>
              ))}
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
                       onClick={() => { useChatStore.getState().setActiveChatId(ch.id); }}
                       title={ch.title}>
                    {initial}
                  </div>
                );
              })}
              <div className="my-0.5 h-px w-8 shrink-0 bg-border" />
            </>
          )}
        </div>

        {/* Bottom quick actions */}
        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border py-2">
          <Ico icon={<Ic.terminal />} onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)} title={t("prompt_manager")} />
          <Ico icon={<Ic.stack />} onClick={() => { /* Memory modal skipped */ }} title={t("scenario_memory")} />
          <Ico icon={<Ic.plug />} onClick={() => useModalStore.getState().setIsProviderModalOpen(true)} title={t("provider_settings_tooltip")} />
          <Ico icon={<Ic.sliders />} onClick={() => { /* Settings not yet wired */ }} title={t("interface_settings_tooltip")} />
        </div>
      </div>

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
            <div className="flex h-[52px] shrink-0 items-center border-b border-border px-3">
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
                  <Row key={panel.id} icon={panel.icon} label={t(panel.labelKey)}
                       onClick={() => { close(); }} />
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
                         onClick={() => { useModalStore.getState().setCreateCharacterModalOpen(true); close(); }}>
                      <Ic.import /> <span className="truncate">{t("import_char_short")}</span>
                    </div>
                  </div>
                  <div className="my-1 h-px bg-border" />

                  {visibleChars.map((c) => (
                    <React.Fragment key={c.id}>
                      {/* Character row */}
                      <div
                        className={cn(
                          "flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors active:bg-s3 active:scale-[0.97]",
                          selectedCharacterId === c.id ? "bg-s2 border border-accent/20" : "",
                        )}
                        onClick={() => { useChatStore.getState().setSelectedCharacterId(c.id); }}
                      >
                        <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md", selectedCharacterId === c.id ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>
                          {c.avatarAssetId ? <img className="h-full w-full object-cover object-top" src={avatarUrl(c.avatarAssetId)} alt={c.name} /> : initials(c.name)}
                        </div>
                        <span className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)] text-t2">{c.name}</span>
                        {c.id === selectedCharacterId && <span className="shrink-0 rounded bg-s3 px-1.5 py-0.5 text-[calc(var(--ui-fs)-4px)] text-t3">{t("active")}</span>}
                      </div>

                      {/* Chats for active character */}
                      {c.id === selectedCharacterId && activeCharChats.length > 0 && (
                        <div className="ml-3 border-l border-border pl-1.5">
                          {activeCharChats.map((ch) => (
                            <div key={ch.id}
                                 className={cn(
                                   "flex min-h-[36px] cursor-pointer flex-col rounded-md px-2 py-1.5 transition-colors active:bg-s3",
                                   ch.id === activeChatId && "bg-accent-dim",
                                 )}
                                 onClick={() => { useChatStore.getState().setActiveChatId(ch.id); }}>
                              <span className={cn("min-w-0 truncate text-[calc(var(--ui-fs)-2px)]", ch.id === activeChatId ? "text-accent-t font-medium" : "text-t2")}>
                                {ch.title}
                              </span>
                              <span className="min-w-0 truncate text-[calc(var(--ui-fs)-4px)] text-t3">
                                {ch.subtitle}
                              </span>
                            </div>
                          ))}
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
              <NavRow icon={<Ic.stack />} label={t("scenario_memory")} onClick={() => { close(); }} />
              <NavRow icon={<Ic.plug />} label={t("provider_settings_tooltip")} onClick={() => { useModalStore.getState().setIsProviderModalOpen(true); close(); }} />
              <NavRow icon={<Ic.sliders />} label={t("interface_settings_tooltip")} onClick={() => { close(); }} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
