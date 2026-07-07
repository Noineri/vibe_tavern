import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ChatId } from "@vibe-tavern/domain";
import { initials } from "./app-shell-helpers.js";
import { formatRelativeTime, formatShortDate, tabAvatarSrc } from "./sidebar-utils.js";
import { useSidebarChats } from "./hooks/use-sidebar-chats.js";
import { useSidebarCharacters } from "./hooks/use-sidebar-characters.js";
import { SidebarHeader } from "./sections/SidebarHeader.js";
import { SidebarImportModals } from "./sections/SidebarImportModals.js";
import { CollapsedCharacterStrip } from "./sections/CollapsedCharacterStrip.js";
import { CharacterListSection } from "./sections/CharacterListSection.js";
import { SidebarFlyout } from "./sections/SidebarFlyout.js";
import { Icons } from "../shared/icons.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { cn } from "../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { useT } from "../../i18n/context.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useNavigationStore, useChatStore, useCharacterStore, useModalStore } from "../../stores/index.js";
import { ListSortToggle } from "../shared/ListSortToggle.js";
import { ListSearchPanel } from "../shared/ListSearchPanel.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { OverflowTooltip } from "../shared/OverflowTooltip.js";
import { useBuildPanels } from "../../hooks/use-build-panels.js";

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

  // --- Character list: sort + search state ---
  const characterSortMode = useNavigationStore((s) => s.characterSortMode);
  const setCharacterSortMode = useNavigationStore((s) => s.setCharacterSortMode);
  const [charQuery, setCharQuery] = useState("");
  const [charSelectedTags, setCharSelectedTags] = useState<string[]>([]);
  const [charSearchOpen, setCharSearchOpen] = useState(false);

  const { characterTabs, charTagPool, visibleCharacterTabs } = useSidebarCharacters({
    allCharacters,
    allChats,
    query: charQuery,
    selectedTags: charSelectedTags,
  });

  // --- Chat list: sort + search state ---
  const chatSortMode = useNavigationStore((s) => s.chatSortMode);
  const setChatSortMode = useNavigationStore((s) => s.setChatSortMode);
  const [chatListQuery, setChatListQuery] = useState("");
  const [chatSearchOpen, setChatSearchOpen] = useState(false);

  const { chats, rpVisibleChats, sectionChats } = useSidebarChats({
    allChats,
    characterId: currentCharacterId ?? null,
    query: chatListQuery,
  });

  // --- Store actions ---
  const setSidebarCollapsed = useNavigationStore((s) => s.setSidebarCollapsed);
  const setRenamingChatId = useCharacterStore((s) => s.setRenamingChatId);
  const setRenameDraft = useCharacterStore((s) => s.setRenameDraft);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  // --- Local UI state ---
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  const [chatMenuId, setChatMenuId] = useState<ChatId | null>(null);
  const [branchPopId, setBranchPopId] = useState<ChatId | null>(null);

  const branchPopRef = useRef<HTMLDivElement | null>(null);
  const [importModal, setImportModal] = useState<"character" | "chat" | null>(null);
  const [charSwitcherOpen, setCharSwitcherOpen] = useState(false);
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
    () => flyoutCharId ? allChats.filter(c => c.characterId === flyoutCharId && c.mode !== "coauthor") : [],
    [allChats, flyoutCharId],
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node;
      if (branchPopRef.current && !branchPopRef.current.contains(target)) setBranchPopId(null);
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

  return (
    <div className={cn(
        sidebarCollapsed ? 'w-[54px] min-w-[54px]' : 'w-[var(--sw)] min-w-[var(--sw)]',
        'shrink-0 overflow-hidden border-r border-border bg-surface flex flex-col backdrop-blur-md transition-all duration-[180ms] ease-out'
      )}>
        <SidebarHeader sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed} t={t} />

        {sidebarCollapsed && mode === 'play' && (
          <div className="flex min-h-0 flex-1 flex-col items-center">
            <CollapsedCharacterStrip
              characterTabs={characterTabs}
              activeChatCharacterId={activeChatCharacterId}
              activeChatId={activeChatId}
              flyoutCharId={flyoutCharId}
              flyoutAvatarRefs={flyoutAvatarRefs}
              setFlyoutAvatarPos={setFlyoutAvatarPos}
              setFlyoutCharId={setFlyoutCharId}
            />

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

        <SidebarFlyout
          flyoutCharId={flyoutCharId}
          sidebarCollapsed={sidebarCollapsed}
          characterTabs={characterTabs}
          flyoutChats={flyoutChats}
          chatQuery={chatQuery}
          setChatQuery={setChatQuery}
          activeChatId={activeChatId}
          chat={chat}
          character={character}
          setFlyoutCharId={setFlyoutCharId}
          flyoutRef={flyoutRef}
          flyoutListRef={flyoutListRef}
          flyoutTop={flyoutTop}
          flyoutMaxH={flyoutMaxH}
          flyoutFlipped={flyoutFlipped}
          emptyTitleKey="sidebar_send_a_message"
          t={t}
        />
        {sidebarCollapsed && mode === 'build' && (
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-0 py-2">
            <Popover.Root open={charSwitcherOpen} onOpenChange={setCharSwitcherOpen}>
              <CustomTooltip content={snapshot?.character?.name ?? t('switch_character')} side="right">
                <Popover.Trigger asChild>
                  <div
                    className={cn('flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all duration-150', charSwitcherOpen ? '' : 'hover:bg-s2')}
                  >
                    <span className={cn("flex h-full w-full items-center justify-center overflow-hidden rounded-full font-ui text-sm", activeCharAvatarSrc ? "bg-s3" : "bg-accent text-on-accent", charSwitcherOpen && "ring-1 ring-accent/50 ring-offset-2 ring-offset-surface")}>
                      {activeCharAvatarSrc
                        ? <img src={activeCharAvatarSrc!} alt="" className="h-full w-full object-cover" />
                        : initials(snapshot?.character?.name ?? '?')}
                    </span>
                  </div>
                </Popover.Trigger>
              </CustomTooltip>
              <Popover.Portal container={getModalPortal() ?? undefined}>
                <Popover.Content
                  side="right"
                  align="start"
                  sideOffset={6}
                  className="glass-blur z-[301] flex w-[300px] max-w-[calc(100vw-70px)] flex-col overflow-hidden rounded-r-xl border border-border bg-glass-bg shadow-[16px_8px_24px_-8px_rgba(0,0,0,0.4)] outline-none"
                  style={{ animation: "flyoutIn 0.18s ease-out" }}
                >
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1" style={{ maxHeight: "var(--radix-popper-available-height)" }}>
                    {characterTabs.map((tab, index) => {
                      const isActive = tab.id === snapshot?.character?.id;
                      return (
                        <div
                          key={tab.id}
                          role="button"
                          tabIndex={0}
                          style={{ animation: "flyoutCardIn 0.22s ease-out backwards", animationDelay: `${Math.min(index, 12) * 26}ms` }}
                          className={cn(
                            "relative mx-1 mb-0.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors duration-150",
                            isActive ? "bg-accent-dim" : "hover:bg-s2 focus-visible:bg-s2",
                          )}
                          onClick={() => {
                            if (tab.chatId) { void chat.handleSwitchChat(tab.chatId); }
                            else { void character.handleCreateChat(tab.id); }
                            setCharSwitcherOpen(false);
                          }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (tab.chatId) { void chat.handleSwitchChat(tab.chatId); } else { void character.handleCreateChat(tab.id); } setCharSwitcherOpen(false); } }}
                        >
                          {isActive && <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-accent" />}
                          <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full", tabAvatarSrc(tab) ? "" : isActive ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>
                            {tabAvatarSrc(tab)
                              ? <img className="h-full w-full object-cover" src={tabAvatarSrc(tab)!} alt={tab.name} />
                              : <span className="font-ui text-[calc(var(--ui-fs)-4px)]">{initials(tab.name)}</span>}
                          </div>
                          <span className={cn("truncate text-[calc(var(--ui-fs)-1px)]", isActive ? "font-medium text-accent-t" : "text-t2")}>{tab.name}</span>
                        </div>
                      );
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

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
            <CharacterListSection
              t={t}
              characterSortMode={characterSortMode}
              setCharacterSortMode={setCharacterSortMode}
              charSearchOpen={charSearchOpen}
              setCharSearchOpen={setCharSearchOpen}
              charQuery={charQuery}
              setCharQuery={setCharQuery}
              charSelectedTags={charSelectedTags}
              setCharSelectedTags={setCharSelectedTags}
              charTagPool={charTagPool}
              characterTabs={characterTabs}
              visibleCharacterTabs={visibleCharacterTabs}
              isCharacterTabActive={isCharacterTabActive}
              onSelectCharacter={(tab) => {
                useChatStore.getState().setSelectedCharacterId(tab.id);
                if (tab.chatId) { void chat.handleSwitchChat(tab.chatId); }
              }}
              onImportCharacter={() => setImportModal("character")}
              character={character}
              setConfirmDestroy={setConfirmDestroy}
              charMenuId={charMenuId}
              setCharMenuId={setCharMenuId}
              onCloseOtherMenus={() => { setChatMenuId(null); setBranchPopId(null); }}
            />

            <section className="min-h-0 max-h-[50%] overflow-y-auto border-b-0 pb-1.5">
              <div className="sticky top-0 z-10 glass-blur bg-surface">
                <div className="flex items-center pr-2.5">
                  <div className="flex-1 px-[13px] pt-1 pb-[5px] text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("sidebar_chats")}</div>
                  <ListSortToggle mode={chatSortMode} onChange={setChatSortMode} />
                  <CustomTooltip content={t("search_name_placeholder")}>
                    <button type="button" className={cn("iBtn size-5", chatSearchOpen && "text-accent-t")} aria-pressed={chatSearchOpen} onClick={() => setChatSearchOpen((v) => !v)}>
                      <Icons.Search />
                    </button>
                  </CustomTooltip>
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
              {chatSearchOpen && (
                <ListSearchPanel
                  query={chatListQuery}
                  onQueryChange={setChatListQuery}
                  selectedTags={[]}
                  onSelectedTagsChange={() => {}}
                />
              )}
              </div>
              {chats.length === 0 ? (
                <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
                  {t("sidebar_send_a_message")}
                </div>
              ) : sectionChats.length === 0 ? (
                <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
                  {t("search_no_results")}
                </div>
              ) : (
                <>
                {rpVisibleChats.map((chatItem) => {
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

                      {renamingChatId !== chatItem.id && (
                        <DropdownMenu.Root
                          modal={false}
                          open={chatMenuOpen}
                          onOpenChange={(open) => {
                            if (open) { setChatMenuId(chatItem.id); setBranchPopId(null); }
                            else setChatMenuId(null);
                          }}
                        >
                          <div className="absolute right-1 top-2 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                            <CustomTooltip content={t("sidebar_chat_actions")}>
                              <DropdownMenu.Trigger asChild>
                                <button type="button"
                                  className={cn(
                                    'flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1 data-[state=open]:text-t1',
                                    isActive && 'hover:text-accent-t'
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
                                onSelect={() => { setRenamingChatId(chatItem.id); setRenameDraft(chatItem.title); }}
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
                })}
                </>
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
              <Popover.Root open={charSwitcherOpen} onOpenChange={setCharSwitcherOpen}>
                <Popover.Trigger asChild>
                  <div
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg transition-colors hover:bg-s2"
                    style={{ padding: '6px 8px' }}
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
                </Popover.Trigger>
                {characterTabs.length > 1 && (
                  <Popover.Portal container={getModalPortal() ?? undefined}>
                    <Popover.Content
                      side="bottom"
                      align="start"
                      sideOffset={4}
                      className="glass-blur z-[400] max-h-[240px] overflow-y-auto rounded-lg border border-border bg-glass-bg py-1 shadow-theme-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
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
                            setCharSwitcherOpen(false);
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
                    </Popover.Content>
                  </Popover.Portal>
                )}
              </Popover.Root>
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
        <SidebarImportModals importModal={importModal} setImportModal={setImportModal} character={character} activeChatId={activeChatId} />
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
