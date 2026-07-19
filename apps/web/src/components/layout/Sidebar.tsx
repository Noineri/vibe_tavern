import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { initials } from "./app-shell-helpers.js";
import { tabAvatarSrc } from "./sidebar-utils.js";
import { useSidebarChats } from "./hooks/use-sidebar-chats.js";
import { useSidebarCharacters } from "./hooks/use-sidebar-characters.js";
import { useFlyoutPosition } from "./hooks/use-flyout-position.js";
import { SidebarHeader } from "./sections/SidebarHeader.js";
import { SidebarImportModals } from "./sections/SidebarImportModals.js";
import { CollapsedCharacterStrip } from "./sections/CollapsedCharacterStrip.js";
import { CharacterListSection } from "./sections/CharacterListSection.js";
import { SidebarFlyout } from "./sections/SidebarFlyout.js";
import { SidebarFooter, type FooterLauncherItem } from "./sections/SidebarFooter.js";
import { SidebarBranchRename } from "./sections/SidebarBranchRename.js";
import { RichChatRow } from "./sections/RichChatRow.js";
import { ChatListSection } from "./sections/ChatListSection.js";
import { Icons } from "../shared/icons.js";

import { cn } from "../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { useT } from "../../i18n/context.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useNavigationStore, useChatStore, useCharacterStore, useModalStore } from "../../stores/index.js";
import { ListSectionHeader } from "./sections/ListSectionHeader.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { OverflowTooltip } from "../shared/OverflowTooltip.js";
import { useBuildPanels } from "../../hooks/use-build-panels.js";

export function Sidebar() {
  const { t, tDynamic } = useT();

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

  const { chats, sectionChats } = useSidebarChats({
    allChats,
    characterId: currentCharacterId ?? null,
    query: chatListQuery,
  });

  // --- Store actions ---
  const setSidebarCollapsed = useNavigationStore((s) => s.setSidebarCollapsed);
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  // --- Local UI state ---
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  const [importModal, setImportModal] = useState<"character" | "chat" | null>(null);
  const [charSwitcherOpen, setCharSwitcherOpen] = useState(false);
  const [flyoutCharId, setFlyoutCharId] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState("");
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const flyoutListRef = useRef<HTMLDivElement | null>(null);
  const flyoutAvatarRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [flyoutAvatarPos, setFlyoutAvatarPos] = useState<{ top: number; bottom: number } | null>(null);
  const flyout = useFlyoutPosition(flyoutCharId, flyoutAvatarPos, flyoutRef, flyoutListRef);

  const flyoutChats = useMemo(
    () => flyoutCharId ? allChats.filter(c => c.characterId === flyoutCharId && c.mode !== "coauthor") : [],
    [allChats, flyoutCharId],
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node;
      if (flyoutRef.current && !flyoutRef.current.contains(target)) setFlyoutCharId(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => { if (!flyoutCharId) setChatQuery(""); }, [flyoutCharId]);

  const rpFooterItems: FooterLauncherItem[] = [
    { key: "prompt-manager", label: t("sidebar_prompt_manager"), onClick: () => useModalStore.getState().setIsPromptManagerOpen(true), icon: <Icons.Terminal /> },
    { key: "persona", label: personaName, onClick: () => useModalStore.getState().setIsPersonaModalOpen(true), avatar: { src: personaAvatarSrc, fallback: initials(personaName) }, expandedSuffix: t("sidebar_your_persona") },
  ];

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
              <SidebarFooter collapsed items={rpFooterItems} />
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
          setConfirmDestroy={setConfirmDestroy}
          branches={branches}
          activeBranchId={activeBranchId}
          setFlyoutCharId={setFlyoutCharId}
          flyoutRef={flyoutRef}
          flyoutListRef={flyoutListRef}
          flyoutTop={flyout.top}
          flyoutMaxH={flyout.maxH}
          flyoutFlipped={flyout.flipped}
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
              <Popover.Portal>
                <Popover.Content
                  side="right"
                  align="start"
                  sideOffset={6}
                  className="glass-blur z-[301] flex w-[300px] max-w-[calc(100vw-70px)] flex-col overflow-hidden rounded-r-xl border border-border bg-glass-bg shadow-[16px_8px_24px_-8px_rgba(0,0,0,0.4)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
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
              <CustomTooltip key={item.id} content={tDynamic(item.labelKey)} side="right">
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
              <SidebarFooter collapsed items={rpFooterItems} />
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
            />

            <ChatListSection
              sectionClassName="min-h-0 flex-1 overflow-y-auto border-b-0 pb-1.5"
              header={
                <ListSectionHeader
                  titleKey="sidebar_chats"
                  sortMode={chatSortMode}
                  onSortChange={setChatSortMode}
                  searchOpen={chatSearchOpen}
                  onToggleSearch={() => setChatSearchOpen((v) => !v)}
                  searchQuery={chatListQuery}
                  onSearchQueryChange={setChatListQuery}
                  importTooltipKey="sidebar_import_chat"
                  onImport={() => setImportModal("chat")}
                  createTooltipKey="sidebar_new_chat_active_char"
                  onCreate={() => { void character.handleCreateChat(currentCharacterId ?? undefined); }}
                />
              }
              chats={chats}
              sectionChats={sectionChats}
              activeChatId={activeChatId}
              emptyAllKey="sidebar_send_a_message"
              emptyFilteredKey="search_no_results"
              renderRow={(chatItem, isActive) => (
                <RichChatRow
                  key={chatItem.id}
                  chatItem={chatItem}
                  isActive={isActive}
                  branches={branches}
                  activeBranchId={activeBranchId}
                  chat={chat}
                  character={character}
                  setConfirmDestroy={setConfirmDestroy}
                />
              )}
            />
            </div>

            <SidebarFooter items={rpFooterItems} />
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
                  <Popover.Portal>
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
                  <span>{tDynamic(item.labelKey)}</span>
                </div>
              ))}
            </div>

            <SidebarFooter items={rpFooterItems} />
          </>
        )}
        <SidebarImportModals importModal={importModal} setImportModal={setImportModal} character={character} activeChatId={activeChatId} />
      </div>
  );
}
