import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatId, ChatBranchId, ChatBranch } from "@rp-platform/domain";
import type { ChatListItem } from "../app-client.js";
import type { CharacterTab } from "./app-shell-types.js";
import type { BuildTab } from "./BuildMode.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";
import { cn } from "../lib/cn.js";
import { avatarUrl } from "../lib/avatar.js";
import { CharacterImportModal, ChatImportModal } from "./ImportModals.js";
import { useT } from "../i18n/context.js";
import { useChatController } from "../hooks/use-chat-controller.js";
import { useCharacterController } from "../hooks/use-character-controller.js";
import { useBootstrapQuery } from "../queries/bootstrap-queries.js";
import { useChatSnapshot } from "../queries/chat-queries.js";
import { useNavigationStore, useChatStore, useCharacterStore, useModalStore } from "../stores/index.js";
import { buildCharacterTabs } from "../lib/character-tabs.js";
import { useMemo } from "react";

export function Sidebar() {
  const { t } = useT();

  // --- Sub-hooks ---
  const chat = useChatController();
  const character = useCharacterController();
  const bootstrapQuery = useBootstrapQuery();

  // --- Store subscriptions ---
  const sidebarCollapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const mode = useNavigationStore((s) => s.mode);
  const buildTab = useCharacterStore((s) => s.buildTab);
  const setBuildTab = useCharacterStore((s) => s.setBuildTab);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const snapshotQuery = useChatSnapshot(activeChatId);
  const snapshot = snapshotQuery.data ?? null;
  const renamingChatId = useCharacterStore((s) => s.renamingChatId);
  const renameDraft = useCharacterStore((s) => s.renameDraft);

  // --- Derived from bootstrap ---
  const allCharacters = bootstrapQuery.data?.allCharacters ?? [];

  // --- Derived from stores ---
  const allChats = snapshot?.chats ?? [];
  const activeChatCharacterId = snapshot?.activeChat?.characterId;
  const currentCharacterId = selectedCharacterId ?? activeChatCharacterId;

  // Filter chats to show only those belonging to the current character
  const chats = useMemo(
    () => currentCharacterId
      ? allChats.filter((c) => c.characterId === currentCharacterId)
      : allChats,
    [allChats, currentCharacterId],
  );
  const branches = snapshot?.branches ?? [];
  const activeBranchId = snapshot?.activeBranch?.id ?? null;
  const personaName = snapshot?.persona?.name ?? t("no_persona");
  const personaAvatarAssetId = snapshot?.persona?.avatarAssetId ?? null;

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
  const charSwitcherRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node;
      if (charMenuRef.current && !charMenuRef.current.contains(target)) setCharMenuId(null);
      if (chatMenuRef.current && !chatMenuRef.current.contains(target)) setChatMenuId(null);
      if (branchPopRef.current && !branchPopRef.current.contains(target)) setBranchPopId(null);
      if (charSwitcherRef.current && !charSwitcherRef.current.contains(target)) setCharSwitcherOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function calcPopoverPos(triggerEl: HTMLElement): { top: number; right: number } {
    const rect = triggerEl.getBoundingClientRect();
    return {
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    };
  }

  return (
    <div className={cn(
      sidebarCollapsed ? 'w-[54px] min-w-[54px]' : 'w-[var(--sw)] min-w-[var(--sw)]',
      'shrink-0 overflow-hidden border-r border-border bg-surface flex flex-col transition-all duration-[180ms] ease-out'
    )}>
      {/* DYNAMIC: justifyContent and padding depend on sidebarCollapsed state */}
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-b border-border" style={{ justifyContent: sidebarCollapsed ? 'center' : undefined, padding: sidebarCollapsed ? '0 6px' : '0 12px' }}>
        {!sidebarCollapsed && (
          <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[5px] bg-accent font-body text-[calc(var(--ui-fs)-1px)] font-medium italic text-on-accent">r</div>
        )}
        {!sidebarCollapsed && (
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-body text-[length:var(--ui-fs)] font-medium tracking-[-0.01em] text-t1">{t("app_name")}</span>
        )}
        <button
          className="iBtn"
          aria-label={sidebarCollapsed ? t("sidebar_expand") : t("sidebar_collapse")}
          title={sidebarCollapsed ? t("sidebar_expand") : t("sidebar_collapse")}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          <Icons.Caret direction={sidebarCollapsed ? "r" : "l"} />
        </button>
      </div>

      {sidebarCollapsed && mode === 'play' && (
        <div className="flex min-h-0 flex-1 flex-col items-center">
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
            {characterTabs.map((tab) => {
              const isActive = tab.chatId === activeChatId
                || (!tab.chatId && tab.id === selectedCharacterId);
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'flex h-11 w-11 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all duration-150 hover:rounded-xl hover:bg-s2',
                    isActive && 'rounded-xl bg-accent-dim ring-2 ring-accent'
                  )}
                  onClick={() => {
                    if (tab.chatId) {
                      void chat.handleSwitchChat(tab.chatId);
                    } else {
                      useChatStore.getState().setSelectedCharacterId(tab.id);
                    }
                  }}
                  title={tab.name}
                >
                  <span className={cn('flex h-full w-full items-center justify-center rounded-full font-ui text-sm', isActive ? 'bg-accent text-on-accent' : 'bg-s3 text-t2')}>
                    {tab.avatarAssetId ? <img src={avatarUrl(tab.avatarAssetId)} alt={tab.name} className="h-full w-full object-cover object-top" /> : initials(tab.name)}
                  </span>
                </div>
              );
            })}

            <div className="my-1 h-px w-8 shrink-0 bg-border" />

            {chats.map((chatItem) => {
              const initial = (chatItem.title || '?').trim().charAt(0).toUpperCase() || '?';
              return (
                <div
                  key={chatItem.id}
                  className={cn(
                    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full font-ui text-xs font-medium transition-all duration-150 hover:rounded-xl hover:bg-s2',
                    chatItem.id === activeChatId ? 'rounded-xl bg-accent text-on-accent' : 'bg-s3 text-t2'
                  )}
                  onClick={() => void chat.handleSwitchChat(chatItem.id)}
                  title={chatItem.title}
                >
                  {initial}
                </div>
              );
            })}
          </div>

          <div className="h-px w-8 shrink-0 bg-border" />

          <div className="flex shrink-0 flex-col items-center gap-1 py-2">
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)} title={t("sidebar_prompt_manager")}><Icons.Terminal /></div>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPersonaModalOpen(true)} title={personaName}>
              {personaAvatarAssetId ? <img src={avatarUrl(personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" /> : initials(personaName)}
            </div>
          </div>
        </div>
      )}

      {sidebarCollapsed && mode === 'build' && (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-0 py-2">
          <div
            className={cn('flex h-10 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all duration-150 hover:rounded-xl hover:bg-s2', charSwitcherOpen && 'rounded-xl bg-accent-dim ring-2 ring-accent')}
            onClick={() => setCharSwitcherOpen(v => !v)}
            title={snapshot?.character?.name ?? t('switch_character')}
          >
            <span className="flex h-full w-full items-center justify-center rounded-full bg-accent font-ui text-sm text-on-accent">
              {snapshot?.character?.avatarAssetId
                ? <img src={avatarUrl(snapshot.character.avatarAssetId)} alt="" className="h-full w-full object-cover object-top" />
                : initials(snapshot?.character?.name ?? '?')}
            </span>
          </div>
          {charSwitcherOpen && (
            <div className="max-h-[280px] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-theme-md z-[200]" ref={charSwitcherRef} style={{ width: 52 }}>
              <div className="grid grid-cols-1 gap-1">
              {characterTabs.map(tab => (
                <div
                  key={tab.id}
                  className={cn('flex h-10 w-10 mx-auto cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all hover:bg-s2', tab.id === snapshot?.character?.id && 'ring-2 ring-accent')}
                  onClick={() => {
                    if (tab.chatId) { void chat.handleSwitchChat(tab.chatId); }
                    else { void character.handleCreateChat(tab.id); }
                    setCharSwitcherOpen(false);
                  }}
                  title={tab.name}
                >
                  {tab.avatarAssetId
                    ? <img className="h-full w-full object-cover object-top" src={avatarUrl(tab.avatarAssetId)} alt={tab.name} />
                    : <span className="flex h-full w-full items-center justify-center rounded-full bg-s3 font-ui text-xs text-t2">{initials(tab.name)}</span>}
                </div>
              ))}
              </div>
            </div>
          )}

          <div className="my-1 h-px w-8 shrink-0 bg-border" />

          {([
            { id: 'character' as BuildTab, icon: <Icons.Wrench /> },
            { id: 'lorebook' as BuildTab, icon: <Icons.Book /> },
            { id: 'trace' as BuildTab, icon: <Icons.Trace /> },
          ]).map((item) => (
            <div
              key={item.id}
              className={cn(
                'flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition-all duration-150 hover:rounded-xl hover:bg-s2',
                buildTab === item.id && 'rounded-xl bg-accent-dim text-accent-t'
              )}
              onClick={() => setBuildTab(item.id)}
              title={t(`sidebar_build_${item.id === 'character' ? 'char' : item.id === 'lorebook' ? 'lore' : item.id}`)}
            >
              {item.icon}
            </div>
          ))}

          <div className="mt-auto flex shrink-0 flex-col items-center gap-1">
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPromptManagerOpen(true)} title={t("sidebar_prompt_manager")}><Icons.Terminal /></div>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={() => useModalStore.getState().setIsPersonaModalOpen(true)} title={personaName}>
              {personaAvatarAssetId ? <img src={avatarUrl(personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" /> : initials(personaName)}
            </div>
          </div>
        </div>
      )}

      {!sidebarCollapsed && mode === 'play' && (
        <>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <section className="min-h-0 max-h-[50%] overflow-y-auto border-b border-border py-1.5">
            <div className="flex items-center pr-2.5">
              <div className="flex-1 px-[13px] pt-1 pb-[5px] text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("sidebar_characters")}</div>
              <button className="iBtn size-5" onClick={() => setImportModal("character")} title={t("sidebar_import_character")}>
                <Icons.Import />
              </button>
              <button className="iBtn size-5" onClick={() => useModalStore.getState().setCreateCharacterModalOpen(true)} title={t("sidebar_create_character")}>
                <Icons.Plus />
              </button>
            </div>
            {characterTabs.length === 0 ? (
              <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
                {t("sidebar_no_characters")}
              </div>
            ) : (
              characterTabs.map((tab) => {
                const isActive = tab.chatId === activeChatId
                  || (!tab.chatId && tab.id === selectedCharacterId);
                const menuOpen = charMenuId === tab.id;
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      'group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] transition-colors duration-100 hover:bg-s2 hover:text-t1',
                      isActive ? 'bg-accent-dim text-accent-t' : 'text-t2'
                    )}
                    style={{ zIndex: menuOpen ? 100 : 1 }}
                    onClick={() => {
                      if (tab.chatId) {
                        void chat.handleSwitchChat(tab.chatId);
                      } else {
                        useChatStore.getState().setSelectedCharacterId(tab.id);
                      }
                    }}
                  >
                    <span className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full font-ui text-[calc(var(--ui-fs)-2px)] not-italic avatar-fallback initials crop-framing',
                      isActive ? 'bg-accent text-on-accent' : 'bg-s3 text-t2'
                    )}>{tab.avatarAssetId ? <img src={avatarUrl(tab.avatarAssetId)} alt={tab.name} className="h-full w-full object-cover object-top" /> : initials(tab.name)}</span>
                    <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {tab.name}
                    </span>

                    {!menuOpen && (
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 rounded pl-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <button
                          className="flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1"
                          aria-label={t("sidebar_character_actions")}
                          title={t("sidebar_character_actions")}
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
                      </div>
                    )}

                    {menuOpen && charMenuPos && createPortal(
                      <div
                        className="absolute z-[200] w-[190px] rounded-md border border-border2 bg-surface py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
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
              <button className="iBtn size-5" onClick={() => setImportModal("chat")} title={t("sidebar_import_chat")}>
                <Icons.Import />
              </button>
              <button className="iBtn size-5" onClick={() => {
                const activeTab = characterTabs.find((tab) => tab.chatId === activeChatId);
                const charId = activeTab?.id ?? selectedCharacterId;
                void character.handleCreateChat(charId ?? undefined);
              }} title={t("sidebar_new_chat_active_char")}>
                <Icons.Plus />
              </button>
            </div>
            {chats.length === 0 ? (
              <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
                {t("sidebar_send_a_message")}
              </div>
            ) : (
              chats.map((chatItem) => {
                const isActive = chatItem.id === activeChatId;
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
                    className={cn(
                      'group relative mx-1 flex cursor-pointer flex-col rounded px-2.5 py-1.5 transition-colors duration-100 hover:bg-s2',
                      isActive && 'bg-accent-dim'
                    )}
                    style={{ zIndex: chatMenuOpen || branchPopOpen ? 100 : 1 }}
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
                      <div className={cn(
                        'overflow-hidden text-ellipsis whitespace-nowrap pr-4 text-[calc(var(--ui-fs)-1px)] text-t1',
                        isActive && 'text-accent-t'
                      )}>{chatItem.title}</div>
                    )}
                    <div className="mt-px flex items-center gap-1.5">
                      <div className="text-[calc(var(--ui-fs)-3px)] text-t3">
                        {chatItem.characterName} · {chatItem.messageCount} msgs
                      </div>
                      {isActive && branchCount > 0 && (
                        <div
                          className="inline-flex cursor-pointer items-center gap-[3px] rounded px-1 py-px font-ui text-[calc(var(--ui-fs)-3px)] tabular-nums text-t3 transition-colors duration-100 hover:bg-border hover:text-t1 [&_svg]:h-2.5 [&_svg]:w-2.5"
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setBranchPopId((current) => current === chatItem.id ? null : chatItem.id);
                            setChatMenuId(null);
                          }}
                          title={t("sidebar_chat_branches")}
                        >
                          <Icons.Stack /> {branchCount}
                        </div>
                      )}
                    </div>

                    {!chatMenuOpen && (
                      <div className="absolute right-1 top-2 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <button
                          className={cn(
                            'flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1',
                            isActive && 'hover:text-accent-t'
                          )}
                          aria-label={t("sidebar_chat_actions")}
                          title={t("sidebar_chat_actions")}
                          onClick={(event) => {
                            event.stopPropagation();
                            setChatMenuId(chatItem.id);
                            setChatMenuPos(calcPopoverPos(event.currentTarget));
                            setBranchPopId(null);
                          }}
                        >
                          <Icons.Ellipsis />
                        </button>
                      </div>
                    )}

                    {chatMenuOpen && chatMenuPos && createPortal(
                      <div
                        className="absolute z-[200] w-[190px] rounded-md border border-border2 bg-surface py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
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
                              title: t("sidebar_delete_chat"),
                              body: <>{t("sidebar_are_you_sure")} <b>{chatItem.title}</b></>,
                              confirmLabel: t("delete"),
                              onConfirm: () => character.handleDeleteChat(chatItem.id),
                            });
                          }}
                        >
                          <Icons.Trash /> {t("delete")}
                        </div>
                      </div>,
                      document.body
                    )}

                    {branchPopOpen && isActive && (
                      <div className="mt-1.5 flex cursor-default flex-col gap-0.5 border-t border-dashed border-border2 pt-1.5" ref={branchPopRef} onClick={(event) => event.stopPropagation()}>
                        <div className="mb-1 pl-1 text-[9px] font-medium uppercase tracking-[0.05em] text-t3">
                          {t("sidebar_timeline_branches")}
                        </div>
                        {branches.map((branch) => {
                          const isActiveBranch = branch.id === activeBranchId;
                          return (
                            <div
                              key={branch.id}
                              className={cn(
                                'group/br relative cursor-pointer rounded pl-3.5 pr-2 transition-colors duration-100 before:absolute before:left-[5px] before:top-[9px] before:h-1 before:w-1 before:rounded-full before:transition-colors',
                                isActiveBranch ? 'bg-accent-dim before:bg-accent' : 'before:bg-border2 hover:bg-s2 hover:before:bg-t3'
                              )}
                              style={{ paddingTop: 5, paddingBottom: 5 }}
                              onClick={(event) => {
                                event.stopPropagation();
                                void chat.handleActivateBranch(branch.id);
                              }}
                            >
                              <div className={cn(
                                'mb-px min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] font-medium text-t2',
                                isActiveBranch && 'text-accent-t'
                              )}>{branch.label || t("sidebar_unnamed_branch")}</div>
                              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] italic text-t3">
                                {isActiveBranch ? t("sidebar_active") : t("sidebar_tap_to_switch")}
                              </div>
                            </div>
                          );
                        })}
                        <div
                          className="mt-0.5 cursor-pointer rounded border-t border-border px-2 py-1.5 text-center text-[calc(var(--ui-fs)-3px)] italic text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1"
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            void chat.handleFork(undefined);
                          }}
                          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); void chat.handleFork(undefined); } }}
                        >
                          {t("sidebar_fork_from_here")}
                        </div>
                        {(() => {
                          const rootBranch = branches.find((b) => b.parentBranchId === null);
                          const activeIsRoot = rootBranch != null && activeBranchId === rootBranch.id;
                          const canAct = !activeIsRoot && branches.length > 1;
                          return (
                            <div className={cn(
                              'cursor-pointer rounded border-t border-border px-2 py-1.5 text-center text-[calc(var(--ui-fs)-3px)] italic text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1',
                              !canAct && 'opacity-45 cursor-not-allowed'
                            )}
                              role="button" tabIndex={0} aria-disabled={!canAct}
                              title={canAct ? "" : t("sidebar_switch_to_non_main")}
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
                              onKeyDown={(event) => { if (canAct && (event.key === "Enter" || event.key === " ")) { event.stopPropagation(); setConfirmDestroy({ title: t("sidebar_delete_branch"), body: t("sidebar_delete_branch_body"), confirmLabel: t("sidebar_delete_branch"), onConfirm: () => void chat.handleDeleteActiveBranch(), }); } }}
                            >
                              {t("sidebar_delete_branch")}
                            </div>
                          );
                        })()}
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
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-ui text-[calc(var(--ui-fs)-2px)] not-italic text-t2">{personaAvatarAssetId ? <img src={avatarUrl(personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" /> : initials(personaName)}</span>
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
            <div className="relative" ref={charSwitcherRef}>
              <div
                className="flex cursor-pointer items-center gap-2.5 rounded-lg transition-colors hover:bg-s2"
                style={{ padding: '6px 8px' }}
                onClick={() => setCharSwitcherOpen(v => !v)}
              >
                <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full', snapshot?.character?.avatarAssetId ? '' : 'bg-accent text-on-accent')}>
                  {snapshot?.character?.avatarAssetId ? (
                    <img className="h-full w-full object-cover object-top" src={avatarUrl(snapshot.character.avatarAssetId)} alt="" />
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
              {charSwitcherOpen && (
                <div className="absolute left-0 right-0 top-full z-[200] mt-1 max-h-[240px] overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-theme-md">
                  {characterTabs.map(tab => (
                    <div
                      key={tab.id}
                      className={cn('flex cursor-pointer items-center gap-2.5 transition-colors hover:bg-s2', tab.id === snapshot?.character?.id && 'bg-accent-dim')}
                      style={{ padding: '6px 12px' }}
                      onClick={() => {
                        if (tab.chatId) { void chat.handleSwitchChat(tab.chatId); }
                        else { void character.handleCreateChat(tab.id); }
                        setCharSwitcherOpen(false);
                      }}
                    >
                      <div className={cn('flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full', tab.avatarAssetId ? '' : tab.id === snapshot?.character?.id ? 'bg-accent text-on-accent' : 'bg-s3 text-t2')}>
                        {tab.avatarAssetId
                          ? <img className="h-full w-full object-cover object-top" src={avatarUrl(tab.avatarAssetId)} alt={tab.name} />
                          : <span className="font-ui text-[calc(var(--ui-fs)-4px)]">{initials(tab.name)}</span>}
                      </div>
                      <span className={cn('truncate text-[calc(var(--ui-fs)-1px)]', tab.id === snapshot?.character?.id ? 'text-accent-t font-medium' : 'text-t2')}>{tab.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Build sections navigation */}
          <div className="flex-1 overflow-y-auto py-1">
            <div className="font-ui text-[calc(var(--ui-fs)-5px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ padding: '9px 15px 7px' }}>{t('sidebar_build_editor')}</div>
            {([
              { id: 'character' as BuildTab, icon: <Icons.Wrench />, label: t('sidebar_build_char') },
              { id: 'lorebook' as BuildTab, icon: <Icons.Book />, label: t('sidebar_build_lore') },
              { id: 'trace' as BuildTab, icon: <Icons.Trace />, label: t('sidebar_build_trace') },
            ]).map((navItem) => (
              <div
                key={navItem.id}
                className={cn(
                  'mx-1 flex cursor-pointer items-center gap-2.5 rounded px-3.5 py-2 font-ui text-[calc(var(--ui-fs)-1px)] text-t2 transition-all hover:bg-s2 hover:text-t1',
                  buildTab === navItem.id && 'bg-accent-dim text-accent-t'
                )}
                onClick={() => setBuildTab(navItem.id)}
              >
                {navItem.icon}
                <span>{navItem.label}</span>
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
                {personaAvatarAssetId ? <img src={avatarUrl(personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" /> : initials(personaName)}
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
