/**
 * CoauthorSidebar — the desktop sidebar for co-author chats.
 *
 * Forked from the RP `Sidebar` (SF-4, COAUTHOR_SHELL_FORK_PLAN.md Wave 2). This
 * is the co-author surface only: character list (selection), co-author chat
 * list with flat rows (no branch/swipe/rename affordances — the flat-editor
 * design), and the "Author Modules" launcher. Persona launcher, Prompt
 * Manager, build mode, and all RP chat-row chrome are absent.
 *
 * Wave 1 shared substrate is consumed: `useSidebarChats` (chat-bucket split by
 * the active chat's `ChatMode`) and `useSidebarCharacters` (character-tabs +
 * filter/sort), plus the `sidebar-utils` pure helpers. The `mode` is hardcoded
 * to `"coauthor"` here — there is no runtime mode switch inside this component
 * (the shell dispatch in `useShellSurface` selects between `<Sidebar/>` and
 * `<CoauthorSidebar/>` by `activeChat.mode`, i.e. the chat's `ChatMode`, not a
 * navigation mode).
 *
 * NOTE: large portions of JSX are duplicated verbatim from `Sidebar.tsx`
 * (header, character list section, flyout). This is intentional for the fork
 * step — once both concrete files exist, the shared sections are extracted as
 * a follow-up (the "fork first, extract later" sequencing endorsed by the
 * owner). Do not drift these against `Sidebar.tsx` until that extraction.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSidebarChats } from "../layout/hooks/use-sidebar-chats.js";
import { useSidebarCharacters } from "../layout/hooks/use-sidebar-characters.js";
import { SidebarHeader } from "../layout/sections/SidebarHeader.js";
import { SidebarImportModals } from "../layout/sections/SidebarImportModals.js";
import { CollapsedCharacterStrip } from "../layout/sections/CollapsedCharacterStrip.js";
import { CharacterListSection } from "../layout/sections/CharacterListSection.js";
import { CoauthorSidebarFlyout } from "./CoauthorSidebarFlyout.js";
import { SidebarFooter, type FooterLauncherItem } from "../layout/sections/SidebarFooter.js";
import { Icons } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useNavigationStore, useChatStore, useCharacterStore, useModalStore } from "../../stores/index.js";
import { ListSectionHeader } from "../layout/sections/ListSectionHeader.js";
import { ChatListSection } from "../layout/sections/ChatListSection.js";
import { FlatChatRow } from "../layout/sections/FlatChatRow.js";

export function CoauthorSidebar() {
  const { t } = useT();

  // --- Sub-hooks --- (identical to the RP Sidebar — both modes drive the same
  // chat/character controller actions; only the row affordances differ.)
  const chat = useChatController();
  const character = useCharacterController();

  // --- Store subscriptions ---
  const sidebarCollapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const chatMeta = useChatMeta();
  const snapshot = chatMeta;

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
  const [flyoutCharId, setFlyoutCharId] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState("");
  const flyoutAvatarRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [flyoutAvatarPos, setFlyoutAvatarPos] = useState<{ top: number; bottom: number } | null>(null);

  const flyoutChats = useMemo(
    () => flyoutCharId ? allChats.filter(c => c.characterId === flyoutCharId && c.mode === "coauthor") : [],
    [allChats, flyoutCharId],
  );

  useEffect(() => { if (!flyoutCharId) setChatQuery(""); }, [flyoutCharId]);

  const coauthorFooterItems: FooterLauncherItem[] = [
    { key: "modules", label: t("coauthor.sidebar.modules"), onClick: () => useModalStore.getState().setCoauthorModuleModalOpen(true), icon: <Icons.Tool /> },
    { key: "skills", label: t("coauthor.sidebar.skills"), onClick: () => useModalStore.getState().setCoauthorSkillModalOpen(true), icon: <Icons.Book /> },
  ];

  return (
    <div className={cn(
        sidebarCollapsed ? 'w-[54px] min-w-[54px]' : 'w-[var(--sw)] min-w-[var(--sw)]',
        'shrink-0 overflow-hidden border-r border-border bg-surface flex flex-col backdrop-blur-md transition-all duration-[180ms] ease-out'
      )}>
        <SidebarHeader sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed} t={t} />

        {sidebarCollapsed && (
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
              <SidebarFooter collapsed items={coauthorFooterItems} />
            </div>
          </div>
        )}

        <CoauthorSidebarFlyout
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
          flyoutAvatarPos={flyoutAvatarPos}
          createChatMode="coauthor"
          emptyTitleKey="coauthor.list_empty"
          t={t}
        />

        {!sidebarCollapsed && (
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
              sectionClassName="min-h-0 max-h-[50%] overflow-y-auto border-b-0 pb-1.5"
              header={
                <ListSectionHeader
                  titleKey="sidebar_coauthor_chats"
                  sortMode={chatSortMode}
                  onSortChange={setChatSortMode}
                  searchOpen={chatSearchOpen}
                  onToggleSearch={() => setChatSearchOpen((v) => !v)}
                  searchQuery={chatListQuery}
                  onSearchQueryChange={setChatListQuery}
                  importTooltipKey="sidebar_import_chat"
                  onImport={() => setImportModal("chat")}
                  createTooltipKey="sidebar_new_chat_active_char"
                  onCreate={() => { void character.handleCreateChat(currentCharacterId ?? undefined, "coauthor"); }}
                />
              }
              chats={chats}
              sectionChats={sectionChats}
              activeChatId={activeChatId}
              emptyAllKey="coauthor.list_empty"
              emptyFilteredKey="coauthor.list_empty"
              renderRow={(chatItem, isActive) => (
                <FlatChatRow
                  key={chatItem.id}
                  chatItem={chatItem}
                  isActive={isActive}
                  chat={chat}
                  character={character}
                  setConfirmDestroy={setConfirmDestroy}
                />
              )}
            />
            </div>

            <SidebarFooter items={coauthorFooterItems} />
          </>
        )}
        <SidebarImportModals importModal={importModal} setImportModal={setImportModal} character={character} activeChatId={activeChatId} />
      </div>
  );
}
