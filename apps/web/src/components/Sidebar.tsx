import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatId, ChatBranchId, ChatBranch } from "@rp-platform/domain";
import type { ChatListItem } from "../app-client.js";
import type { CharacterTab } from "./app-shell-types.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";
import { cn } from "../lib/cn.js";
import { avatarUrl } from "../lib/avatar.js";
import { CharacterImportModal, ChatImportModal } from "./ImportModals.js";
import { useT } from "../i18n/context.js";
import { useAppActions } from "./AppShell.js";
import { useNavigationStore, useChatStore, useCharacterStore } from "../stores/index.js";
import { buildCharacterTabs } from "../lib/character-tabs.js";
import { useMemo } from "react";

export function Sidebar() {
  const { t } = useT();
  const actions = useAppActions();

  // --- Store subscriptions ---
  const sidebarCollapsed = useNavigationStore((s) => s.sidebarCollapsed);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const snapshot = actions.snapshot;
  const renamingChatId = useCharacterStore((s) => s.renamingChatId);
  const renameDraft = useCharacterStore((s) => s.renameDraft);

  // --- Derived from stores ---
  const chats = snapshot?.chats ?? [];
  const branches = snapshot?.branches ?? [];
  const activeBranchId = snapshot?.activeBranch?.id ?? null;
  const personaName = snapshot?.persona?.name ?? t("no_persona");
  const personaAvatarAssetId = snapshot?.persona?.avatarAssetId ?? null;

  const characterTabs = useMemo(
    () => buildCharacterTabs(actions.allCharacters, chats),
    [actions.allCharacters, chats],
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

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node;
      if (charMenuRef.current && !charMenuRef.current.contains(target)) setCharMenuId(null);
      if (chatMenuRef.current && !chatMenuRef.current.contains(target)) setChatMenuId(null);
      if (branchPopRef.current && !branchPopRef.current.contains(target)) setBranchPopId(null);
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

      {sidebarCollapsed && (
        <div className="flex min-h-0 flex-1 flex-col items-center">
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto" style={{padding:'8px 0'}}>
            {characterTabs.map((character) => {
              const isActive = character.chatId === activeChatId
                || (!character.chatId && character.id === selectedCharacterId);
              return (
                <div
                  key={character.id}
                  className={cn(
                    'flex h-11 w-11 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all duration-150 hover:rounded-xl hover:bg-s2',
                    isActive && 'rounded-xl bg-accent-dim ring-2 ring-accent'
                  )}
                  onClick={() => {
                    if (character.chatId) {
                      void actions.handleSwitchChat(character.chatId);
                    } else {
                      useChatStore.getState().setSelectedCharacterId(character.id);
                    }
                  }}
                  title={character.name}
                >
                  <span className={cn('flex h-full w-full items-center justify-center rounded-full font-ui text-sm', isActive ? 'bg-accent text-on-accent' : 'bg-s3 text-t2')}>
                    {character.avatarAssetId ? <img src={avatarUrl(character.avatarAssetId)} alt={character.name} className="h-full w-full object-cover object-top" /> : initials(character.name)}
                  </span>
                </div>
              );
            })}

            <div className="my-1 h-px w-8 shrink-0 bg-border" />

            {chats.map((chat) => {
              const initial = (chat.title || '?').trim().charAt(0).toUpperCase() || '?';
              return (
                <div
                  key={chat.id}
                  className={cn(
                    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full font-ui text-xs font-medium transition-all duration-150 hover:rounded-xl hover:bg-s2',
                    chat.id === activeChatId ? 'rounded-xl bg-accent text-on-accent' : 'bg-s3 text-t2'
                  )}
                  onClick={() => void actions.handleSwitchChat(chat.id)}
                  title={chat.title}
                >
                  {initial}
                </div>
              );
            })}
          </div>

          <div className="h-px w-8 shrink-0 bg-border" />

          <div className="flex shrink-0 flex-col items-center gap-1" style={{padding:'8px 0'}}>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={actions.openPromptManager} title={t("sidebar_prompt_manager")}><Icons.Terminal /></div>
            <div className="flex h-10 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={actions.openPersonaModal} title={personaName}>
              {initials(personaName)}
            </div>
          </div>
        </div>
      )}

      {!sidebarCollapsed && (
        <>
          <section className="border-b border-border" style={{padding:'6px 0'}}>
            <div className="flex items-center" style={{paddingRight:'10px'}}>
              <div className="text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ flex: 1, padding:'4px 13px 5px' }}>{t("sidebar_characters")}</div>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={() => setImportModal("character")} title={t("sidebar_import_character")}>
                <Icons.Import />
              </button>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={actions.openCreateCharacterModal} title={t("sidebar_create_character")}>
                <Icons.Plus />
              </button>
            </div>
            {characterTabs.length === 0 ? (
              <div className="text-center text-t3 text-xs leading-relaxed" style={{padding:'20px 14px'}}>
                {t("sidebar_no_characters")}
              </div>
            ) : (
              characterTabs.map((character) => {
                const isActive = character.chatId === activeChatId
                  || (!character.chatId && character.id === selectedCharacterId);
                const menuOpen = charMenuId === character.id;
                return (
                  <div
                    key={character.id}
                    className={cn(
                      'group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded text-[calc(var(--ui-fs)-1px)] transition-colors duration-100 hover:bg-s2 hover:text-t1',
                      isActive ? 'bg-accent-dim text-accent-t' : 'text-t2'
                    )}
                    style={{ position: "relative", zIndex: menuOpen ? 100 : 1, padding: '6px 10px' }}
                    onClick={() => {
                      if (character.chatId) {
                        void actions.handleSwitchChat(character.chatId);
                      } else {
                        useChatStore.getState().setSelectedCharacterId(character.id);
                      }
                    }}
                  >
                    <span className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full font-ui text-[calc(var(--ui-fs)-2px)] not-italic avatar-fallback initials crop-framing',
                      isActive ? 'bg-accent text-on-accent' : 'bg-s3 text-t2'
                    )}>{character.avatarAssetId ? <img src={avatarUrl(character.avatarAssetId)} alt={character.name} className="h-full w-full object-cover object-top" /> : initials(character.name)}</span>
                    <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {character.name}
                    </span>

                    {!menuOpen && (
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 rounded opacity-0 transition-opacity duration-150 group-hover:opacity-100" style={{paddingLeft:'6px'}}>
                        <button
                          className="flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1"
                          aria-label={t("sidebar_character_actions")}
                          title={t("sidebar_character_actions")}
                          onClick={(event) => {
                            event.stopPropagation();
                            setCharMenuId(character.id);
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
                        className="absolute z-[200] w-[190px] rounded-md border border-border2 bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                        ref={charMenuRef}
                        onClick={(event) => event.stopPropagation()}
                        style={{ top: charMenuPos.top, right: charMenuPos.right, padding:'4px 0' }}
                      >
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setCharMenuId(null); setCharMenuPos(null);
                            actions.onExportCharacter(character.id);
                          }}
                        >
                          <Icons.Download /> {t("sidebar_export")}
                        </div>
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setCharMenuId(null); setCharMenuPos(null);
                            actions.handleArchiveCharacter(character.id);
                          }}
                        >
                          <Icons.Book /> {t("sidebar_archive")}
                        </div>
                        <div className="my-1 h-px bg-border" />
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-danger-text transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setCharMenuId(null); setCharMenuPos(null);
                            setConfirmDestroy({
                              title: t("sidebar_delete_character"),
                              body: <>{t("sidebar_are_you_sure")} <b>{character.name}</b></>,
                              confirmLabel: t("delete"),
                              onConfirm: () => actions.handleDeleteCharacter(character.id),
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

          <section className="flex-1 overflow-y-auto border-b-0" style={{ padding:'6px 0' }}>
            <div className="flex items-center" style={{paddingRight:'10px'}}>
              <div className="text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ flex: 1, padding:'4px 13px 5px' }}>{t("sidebar_chats")}</div>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={() => setImportModal("chat")} title={t("sidebar_import_chat")}>
                <Icons.Import />
              </button>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={() => {
                const activeTab = characterTabs.find((tab) => tab.chatId === activeChatId);
                const charId = activeTab?.id ?? selectedCharacterId;
                void actions.onCreateChat(charId ?? undefined);
              }} title={t("sidebar_new_chat_active_char")}>
                <Icons.Plus />
              </button>
            </div>
            {chats.length === 0 ? (
              <div className="text-center text-t3 text-xs leading-relaxed" style={{padding:'20px 14px'}}>
                {t("sidebar_send_a_message")}
              </div>
            ) : (
              chats.map((chat) => {
                const isActive = chat.id === activeChatId;
                const chatMenuOpen = chatMenuId === chat.id;
                const branchPopOpen = branchPopId === chat.id;
                const branchCount = isActive ? branches.length : 0;
                const commitRename = () => {
                  const nextTitle = renameDraft.trim();
                  const currentTitle = chat.title.trim();
                  if (!nextTitle || nextTitle === currentTitle) {
                    setRenamingChatId(null);
                    return;
                  }
                  void actions.handleRenameChat(chat.id, nextTitle);
                  setRenamingChatId(null);
                };
                return (
                  <div
                    key={chat.id}
                    className={cn(
                      'group relative mx-1 flex cursor-pointer flex-col rounded transition-colors duration-100 hover:bg-s2',
                      isActive && 'bg-accent-dim'
                    )}
                    style={{ position: "relative", zIndex: chatMenuOpen || branchPopOpen ? 100 : 1, cursor: "pointer", padding: '6px 10px' }}
                    onClick={() => void actions.handleSwitchChat(chat.id)}
                  >
                    {renamingChatId === chat.id ? (
                      <input
                        className="mb-px w-full rounded border border-accent bg-bg font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none"
                        style={{ padding: '2px 5px' }}
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
                      )}>{chat.title}</div>
                    )}
                    <div className="mt-px flex items-center gap-1.5">
                      <div className="text-[calc(var(--ui-fs)-3px)] text-t3">
                        {chat.characterName} · {chat.messageCount} msgs
                      </div>
                      {isActive && branchCount > 0 && (
                        <div
                          className="inline-flex cursor-pointer items-center gap-[3px] rounded font-ui text-[calc(var(--ui-fs)-3px)] tabular-nums text-t3 transition-colors duration-100 hover:bg-border hover:text-t1 [&_svg]:h-2.5 [&_svg]:w-2.5"
                          style={{padding:'1px 4px'}}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setBranchPopId((current) => current === chat.id ? null : chat.id);
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
                            setChatMenuId(chat.id);
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
                        className="absolute z-[200] w-[190px] rounded-md border border-border2 bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                        ref={chatMenuRef}
                        onClick={(event) => event.stopPropagation()}
                        style={{ top: chatMenuPos.top, right: chatMenuPos.right, padding:'4px 0' }}
                      >
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setChatMenuId(null); setChatMenuPos(null);
                            setRenamingChatId(chat.id);
                            setRenameDraft(chat.title);
                          }}
                        >
                          <Icons.Edit /> {t("sidebar_rename")}
                        </div>
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setChatMenuId(null); setChatMenuPos(null);
                            void actions.onCloneChat(chat.id);
                          }}
                        >
                          <Icons.Copy /> {t("sidebar_clone_chat")}
                        </div>
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setChatMenuId(null); setChatMenuPos(null);
                            actions.onExportChatJsonl(chat.id);
                          }}
                        >
                          <Icons.Download /> {t("sidebar_export_jsonl")}
                        </div>
                        <div className="my-1 h-px bg-border" />
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-danger-text transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setChatMenuId(null); setChatMenuPos(null);
                            setConfirmDestroy({
                              title: t("sidebar_delete_chat"),
                              body: <>{t("sidebar_are_you_sure")} <b>{chat.title}</b></>,
                              confirmLabel: t("delete"),
                              onConfirm: () => actions.handleDeleteChat(chat.id),
                            });
                          }}
                        >
                          <Icons.Trash /> {t("delete")}
                        </div>
                      </div>,
                      document.body
                    )}

                    {branchPopOpen && isActive && (
                      <div className="mt-1.5 flex cursor-default flex-col gap-0.5 border-t border-dashed border-border2" style={{paddingTop:'6px'}} ref={branchPopRef} onClick={(event) => event.stopPropagation()}>
                        <div className="mb-1 text-[9px] font-medium uppercase tracking-[0.05em] text-t3" style={{paddingLeft:'4px'}}>
                          {t("sidebar_timeline_branches")}
                        </div>
                        {branches.map((branch) => {
                          const isActiveBranch = branch.id === activeBranchId;
                          return (
                            <div
                              key={branch.id}
                              className={cn(
                                'group/br relative cursor-pointer rounded pl-3.5 pr-2 transition-colors duration-100 before:absolute before:left-[5px] before:top-[9px] before:h-1 before:w-1 before:rounded-full before:bg-border2 before:transition-colors hover:bg-s2 hover:before:bg-t3',
                                isActiveBranch && 'bg-accent-dim before:bg-accent'
                              )}
                              style={{ paddingTop: 5, paddingBottom: 5 }}
                              onClick={(event) => {
                                event.stopPropagation();
                                void actions.handleActivateBranch(branch.id);
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
                          className="mt-0.5 cursor-pointer rounded border-t border-border text-center text-[calc(var(--ui-fs)-3px)] italic text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1"
                          style={{padding:'6px 8px'}}
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            void actions.handleFork();
                          }}
                          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); void actions.handleFork(); } }}
                        >
                          {t("sidebar_fork_from_here")}
                        </div>
                        {(() => {
                          const rootBranch = branches.find((b) => b.parentBranchId === null);
                          const activeIsRoot = rootBranch != null && activeBranchId === rootBranch.id;
                          const canAct = !activeIsRoot && branches.length > 1;
                          return (
                            <div className={cn(
                              'cursor-pointer rounded border-t border-border text-center text-[calc(var(--ui-fs)-3px)] italic text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1',
                              !canAct && 'opacity-45 cursor-not-allowed'
                            )}
                              style={{padding:'6px 8px'}}
                              role="button" tabIndex={0} aria-disabled={!canAct}
                              title={canAct ? "" : t("sidebar_switch_to_non_main")}
                              onClick={(event) => {
                                if (!canAct) return;
                                event.stopPropagation();
                                setConfirmDestroy({
                                  title: t("sidebar_delete_branch"),
                                  body: t("sidebar_delete_branch_body"),
                                  confirmLabel: t("sidebar_delete_branch"),
                                  onConfirm: () => void actions.handleDeleteActiveBranch(),
                                });
                              }}
                              onKeyDown={(event) => { if (canAct && (event.key === "Enter" || event.key === " ")) { event.stopPropagation(); setConfirmDestroy({ title: t("sidebar_delete_branch"), body: t("sidebar_delete_branch_body"), confirmLabel: t("sidebar_delete_branch"), onConfirm: () => void actions.handleDeleteActiveBranch(), }); } }}
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

          <section className="mt-auto shrink-0 border-t border-border" style={{padding:'6px 4px'}}>
            <div
              className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
              style={{ padding: '6px 10px' }}
              role="button"
              tabIndex={0}
              onClick={actions.openPromptManager}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  actions.openPromptManager();
                }
              }}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-transparent font-ui text-[calc(var(--ui-fs)-3px)] not-italic text-t2">
                <Icons.Terminal />
              </span>
              <span>{t("sidebar_prompt_manager")}</span>
            </div>
            <div
              className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
              style={{ padding: '6px 10px' }}
              role="button"
              tabIndex={0}
              onClick={actions.openPersonaModal}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  actions.openPersonaModal();
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
      {importModal === "character" && (
        <CharacterImportModal
          isImporting={actions.isImporting}
          importNotice={actions.importNotice}
          onClose={() => setImportModal(null)}
          onImportFiles={(files) => void actions.handleImportFiles(files)}
        />
      )}
      {importModal === "chat" && (
        <ChatImportModal
          activeChatId={activeChatId}
          isImporting={actions.isImporting}
          importNotice={actions.importNotice}
          onClose={() => setImportModal(null)}
          onImportFiles={(files) => void actions.handleImportFiles(files)}
        />
      )}
    </div>
  );
}
