import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatId, ChatBranchId, ChatBranch } from "@rp-platform/domain";
import type { ChatListItem } from "../app-client.js";
import type { CharacterTab } from "./app-shell-types.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";
import { cn } from "../lib/cn.js";
import { avatarUrl } from "../lib/avatar.js";

interface SidebarProps {
  sidebarCollapsed: boolean;
  activeChatId: ChatId | null;
  selectedCharacterId: string | null;
  characterTabs: CharacterTab[];
  chats: ChatListItem[];
  branches: ChatBranch[];
  activeBranchId: ChatBranchId | null;
  personaName: string;
  personaAvatarAssetId: string | null;
  activePromptTraceId: string | null;
  renamingChatId: ChatId | null;
  renameDraft: string;
  onToggleCollapsed: () => void;
  onSwitchChat: (chatId: ChatId) => void;
  onActivateBranch: (branchId: ChatBranchId) => void;
  onFork: () => void;
  onImportFiles: (files: FileList | File[]) => void;
  onOpenPromptManager: () => void;
  onOpenPersonaManager: () => void;
  onCreateChat: (characterId?: string) => void;
  onCloneChat: (chatId: ChatId) => void;
  onExportCharacter: (characterId: string) => void;
  onExportChatJsonl: (chatId: ChatId) => void;
  onExportPromptTrace: (traceId: string) => void;
  onArchiveCharacter: (characterId: string) => void;
  onDeleteCharacter: (characterId: string) => void;
  onDeleteChat: (chatId: ChatId) => void;
  onRenameChat: (chatId: ChatId, title: string) => void;
  onRenameStart: (chatId: ChatId, currentTitle: string) => void;
  onRenameDraftChange: (draft: string) => void;
  onRenameCancel: () => void;
  onRequestDestructiveConfirm: (config: {
    title: string;
    body: import("react").ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
  }) => void;
  onDeleteActiveBranch: () => void;
  onSelectCharacter: (characterId: string) => void;
}

const BACKEND_PENDING_TITLE = "Backend pending — see BACKEND_BACKLOG B8";

export function Sidebar(input: SidebarProps) {
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  const [chatMenuId, setChatMenuId] = useState<ChatId | null>(null);
  const [branchPopId, setBranchPopId] = useState<ChatId | null>(null);
  const [charMenuPos, setCharMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [chatMenuPos, setChatMenuPos] = useState<{ top: number; right: number } | null>(null);

  const charMenuRef = useRef<HTMLDivElement | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  const branchPopRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  function triggerImport(): void {
    fileInputRef.current?.click();
  }

  function onFilePicked(event: React.ChangeEvent<HTMLInputElement>): void {
    if (event.target.files && event.target.files.length > 0) {
      input.onImportFiles(event.target.files);
    }
    event.target.value = "";
  }

  function calcPopoverPos(triggerEl: HTMLElement): { top: number; right: number } {
    const rect = triggerEl.getBoundingClientRect();
    return {
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    };
  }

  return (
    <div className={cn(
      input.sidebarCollapsed ? 'w-[54px] min-w-[54px]' : 'w-[var(--sw)] min-w-[var(--sw)]',
      'shrink-0 overflow-hidden border-r border-border bg-surface flex flex-col transition-all duration-[180ms] ease-out'
    )}>
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-b border-border" style={{ justifyContent: input.sidebarCollapsed ? 'center' : undefined, padding: input.sidebarCollapsed ? '0 6px' : '0 12px' }}>
        {!input.sidebarCollapsed && (
          <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[5px] bg-accent font-body text-[calc(var(--ui-fs)-1px)] font-medium italic text-on-accent">r</div>
        )}
        {!input.sidebarCollapsed && (
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-body text-[length:var(--ui-fs)] font-medium tracking-[-0.01em] text-t1">Claw Tavern</span>
        )}
        <button
          className="iBtn"
          aria-label={input.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={input.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={input.onToggleCollapsed}
        >
          <Icons.Caret direction={input.sidebarCollapsed ? "r" : "l"} />
        </button>
      </div>

      {input.sidebarCollapsed && (
        <div className="flex min-h-0 flex-1 flex-col items-center">
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto" style={{padding:'8px 0'}}>
            {input.characterTabs.map((character) => {
              const isActive = character.chatId === input.activeChatId
                || (!character.chatId && character.id === input.selectedCharacterId);
              return (
                <div
                  key={character.id}
                  className={cn(
                    'flex h-10 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all duration-150 hover:rounded-xl hover:bg-s2',
                    isActive && 'rounded-xl bg-accent-dim ring-2 ring-accent'
                  )}
                  onClick={() => {
                    if (character.chatId) {
                      input.onSwitchChat(character.chatId);
                    } else {
                      input.onSelectCharacter(character.id);
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

            {input.chats.map((chat) => {
              const initial = (chat.title || '?').trim().charAt(0).toUpperCase() || '?';
              return (
                <div
                  key={chat.id}
                  className={cn(
                    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full font-ui text-xs font-medium transition-all duration-150 hover:rounded-xl hover:bg-s2',
                    chat.id === input.activeChatId ? 'rounded-xl bg-accent text-on-accent' : 'bg-s3 text-t2'
                  )}
                  onClick={() => input.onSwitchChat(chat.id)}
                  title={chat.title}
                >
                  {initial}
                </div>
              );
            })}
          </div>

          <div className="h-px w-8 shrink-0 bg-border" />

          <div className="flex shrink-0 flex-col items-center gap-1" style={{padding:'8px 0'}}>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={input.onOpenPromptManager} title="Prompt Manager"><Icons.Terminal /></div>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-s3 text-t2 transition-all duration-150 hover:rounded-xl hover:bg-s2 hover:text-t1" onClick={input.onOpenPersonaManager} title={input.personaName}>
              {initials(input.personaName)}
            </div>
          </div>
        </div>
      )}

      {!input.sidebarCollapsed && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.json,.jsonl"
            multiple
            style={{ display: "none" }}
            onChange={onFilePicked}
          />

          <section className="border-b border-border" style={{padding:'6px 0'}}>
            <div className="flex items-center" style={{paddingRight:'10px'}}>
              <div className="text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ flex: 1, padding:'4px 13px 5px' }}>Characters</div>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={triggerImport} title="Import character (PNG/JSON)">
                <Icons.Import />
              </button>
              <button className="iBtn" style={{ width: 20, height: 20, opacity: 0.45, cursor: "not-allowed" }} title={BACKEND_PENDING_TITLE} disabled>
                <Icons.Plus />
              </button>
            </div>
            {input.characterTabs.length === 0 ? (
              <div className="text-center text-t3 text-xs leading-relaxed" style={{padding:'20px 14px'}}>
                No characters yet — import a card to start.
              </div>
            ) : (
              input.characterTabs.map((character) => {
                const isActive = character.chatId === input.activeChatId
                  || (!character.chatId && character.id === input.selectedCharacterId);
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
                        input.onSwitchChat(character.chatId);
                      } else {
                        input.onSelectCharacter(character.id);
                      }
                    }}
                  >
                    <span className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full font-ui text-[calc(var(--ui-fs)-3px)] not-italic avatar-fallback initials crop-framing',
                      isActive ? 'bg-accent text-on-accent' : 'bg-s3 text-t2'
                    )}>{character.avatarAssetId ? <img src={avatarUrl(character.avatarAssetId)} alt={character.name} className="h-full w-full object-cover object-top" /> : initials(character.name)}</span>
                    <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {character.name}
                    </span>

                    {!menuOpen && (
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 rounded opacity-0 transition-opacity duration-150 group-hover:opacity-100" style={{paddingLeft:'6px'}}>
                        <button
                          className="flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1"
                          aria-label="Character actions"
                          title="Character actions"
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
                            input.onExportCharacter(character.id);
                          }}
                        >
                          <Icons.Download /> Export
                        </div>
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setCharMenuId(null); setCharMenuPos(null);
                            input.onArchiveCharacter(character.id);
                          }}
                        >
                          <Icons.Book /> Archive
                        </div>
                        <div className="my-1 h-px bg-border" />
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-danger-text transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setCharMenuId(null); setCharMenuPos(null);
                            input.onRequestDestructiveConfirm({
                              title: "Delete character?",
                              body: <>Are you sure? <b>{character.name}</b> and all its chats will be deleted permanently.</>,
                              confirmLabel: "Delete",
                              onConfirm: () => input.onDeleteCharacter(character.id),
                            });
                          }}
                        >
                          <Icons.Trash /> Delete
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
              <div className="text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ flex: 1, padding:'4px 13px 5px' }}>Chats</div>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={triggerImport} title="Import chat (JSONL)">
                <Icons.Import />
              </button>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={() => {
                const activeTab = input.characterTabs.find((tab) => tab.chatId === input.activeChatId);
                const charId = activeTab?.id ?? input.selectedCharacterId;
                input.onCreateChat(charId ?? undefined);
              }} title="New chat for active character">
                <Icons.Plus />
              </button>
            </div>
            {input.chats.length === 0 ? (
              <div className="text-center text-t3 text-xs leading-relaxed" style={{padding:'20px 14px'}}>
                Send a message to start a chat.
              </div>
            ) : (
              input.chats.map((chat) => {
                const isActive = chat.id === input.activeChatId;
                const chatMenuOpen = chatMenuId === chat.id;
                const branchPopOpen = branchPopId === chat.id;
                const branchCount = isActive ? input.branches.length : 0;
                return (
                  <div
                    key={chat.id}
                    className={cn(
                      'group relative mx-1 flex cursor-pointer flex-col rounded transition-colors duration-100 hover:bg-s2',
                      isActive && 'bg-accent-dim'
                    )}
                    style={{ position: "relative", zIndex: chatMenuOpen || branchPopOpen ? 100 : 1, cursor: "pointer", padding: '6px 10px' }}
                    onClick={() => input.onSwitchChat(chat.id)}
                  >
                    {input.renamingChatId === chat.id ? (
                      <input
                        className="mb-px w-full rounded border border-accent bg-bg font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none"
                        style={{ padding: '2px 5px' }}
                        value={input.renameDraft}
                        autoFocus
                        onChange={(event) => input.onRenameDraftChange(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={() => {
                          if (input.renameDraft.trim()) {
                            input.onRenameChat(chat.id, input.renameDraft.trim());
                          } else {
                            input.onRenameCancel();
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && input.renameDraft.trim()) {
                            input.onRenameChat(chat.id, input.renameDraft.trim());
                          } else if (event.key === "Escape") {
                            input.onRenameCancel();
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
                          onClick={(event) => {
                            event.stopPropagation();
                            setBranchPopId(branchPopOpen ? null : chat.id);
                            setChatMenuId(null);
                          }}
                          title="Chat branches"
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
                          aria-label="Chat actions"
                          title="Chat actions"
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
                            input.onRenameStart(chat.id, chat.title);
                          }}
                        >
                          <Icons.Edit /> Rename
                        </div>
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setChatMenuId(null); setChatMenuPos(null);
                            input.onCloneChat(chat.id);
                          }}
                        >
                          <Icons.Copy /> Clone chat
                        </div>
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setChatMenuId(null); setChatMenuPos(null);
                            input.onExportChatJsonl(chat.id);
                          }}
                        >
                          <Icons.Download /> Export (JSONL)
                        </div>
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors duration-100 opacity-45 cursor-not-allowed [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          aria-disabled="true"
                          title="Markdown export is deferred; use JSONL export"
                        >
                          <Icons.Download /> Export Markdown
                        </div>
                        <div
                          className={cn(
                            'flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] transition-colors duration-100 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0',
                            chat.id === input.activeChatId && input.activePromptTraceId
                              ? 'text-t2 hover:bg-s2 hover:text-t1'
                              : 'text-t2 opacity-45 cursor-not-allowed'
                          )}
                          role="menuitem"
                          aria-disabled={chat.id !== input.activeChatId || !input.activePromptTraceId}
                          title={chat.id !== input.activeChatId || !input.activePromptTraceId ? "No prompt trace available for this chat" : ""}
                          onClick={() => {
                            if (chat.id === input.activeChatId && input.activePromptTraceId) {
                              setChatMenuId(null); setChatMenuPos(null);
                              input.onExportPromptTrace(input.activePromptTraceId);
                            }
                          }}
                        >
                          <Icons.Download /> Export Prompt Trace
                        </div>
                        <div className="my-1 h-px bg-border" />
                        <div
                          className="flex cursor-pointer items-center gap-2 text-[calc(var(--ui-fs)-2px)] text-danger-text transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                          role="menuitem"
                          style={{ padding: '7px 12px' }}
                          onClick={() => {
                            setChatMenuId(null); setChatMenuPos(null);
                            input.onRequestDestructiveConfirm({
                              title: "Delete chat?",
                              body: <>Delete <b>{chat.title}</b>? All messages on every branch will be removed.</>,
                              confirmLabel: "Delete",
                              onConfirm: () => input.onDeleteChat(chat.id),
                            });
                          }}
                        >
                          <Icons.Trash /> Delete
                        </div>
                      </div>,
                      document.body
                    )}

                    {branchPopOpen && isActive && (
                      <div className="mt-1.5 flex cursor-default flex-col gap-0.5 border-t border-dashed border-border2" style={{paddingTop:'6px'}} ref={branchPopRef} onClick={(event) => event.stopPropagation()}>
                        <div className="mb-1 text-[9px] font-medium uppercase tracking-[0.05em] text-t3" style={{paddingLeft:'4px'}}>
                          Timeline branches
                        </div>
                        {input.branches.map((branch) => {
                          const isActiveBranch = branch.id === input.activeBranchId;
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
                                input.onActivateBranch(branch.id);
                              }}
                            >
                              <div className={cn(
                                'mb-px min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] font-medium text-t2',
                                isActiveBranch && 'text-accent-t'
                              )}>{branch.label || "Unnamed branch"}</div>
                              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[calc(var(--ui-fs)-3px)] italic text-t3">
                                {isActiveBranch ? "Active" : "Tap to switch"}
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
                            input.onFork();
                          }}
                          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); input.onFork(); } }}
                        >
                          + Fork from here
                        </div>
                        {(() => {
                          const rootBranch = input.branches.find((b) => b.parentBranchId === null);
                          const activeIsRoot = rootBranch != null && input.activeBranchId === rootBranch.id;
                          const canAct = !activeIsRoot && input.branches.length > 1;
                          return (
                            <div className={cn(
                              'cursor-pointer rounded border-t border-border text-center text-[calc(var(--ui-fs)-3px)] italic text-t3 transition-colors duration-150 hover:bg-s2 hover:text-t1',
                              !canAct && 'opacity-45 cursor-not-allowed'
                            )}
                              style={{padding:'6px 8px'}}
                              role="button" tabIndex={0} aria-disabled={!canAct}
                              title={canAct ? "" : "Switch to a non-main branch first"}
                              onClick={(event) => {
                                if (!canAct) return;
                                event.stopPropagation();
                                input.onRequestDestructiveConfirm({
                                  title: "Delete branch?",
                                  body: "Delete the active branch and its messages? Main timeline will stay.",
                                  confirmLabel: "Delete branch",
                                  onConfirm: () => input.onDeleteActiveBranch(),
                                });
                              }}
                              onKeyDown={(event) => { if (canAct && (event.key === "Enter" || event.key === " ")) { event.stopPropagation(); input.onRequestDestructiveConfirm({ title: "Delete branch?", body: "Delete the active branch and its messages? Main timeline will stay.", confirmLabel: "Delete branch", onConfirm: () => input.onDeleteActiveBranch(), }); } }}
                            >
                              Delete branch
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
              onClick={input.onOpenPromptManager}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  input.onOpenPromptManager();
                }
              }}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-transparent font-ui text-[calc(var(--ui-fs)-3px)] not-italic text-t2">
                <Icons.Terminal />
              </span>
              <span>Prompt Manager</span>
            </div>
            <div
              className="group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded text-[calc(var(--ui-fs)-1px)] text-t2 transition-colors duration-100 hover:bg-s2 hover:text-t1"
              style={{ padding: '6px 10px' }}
              role="button"
              tabIndex={0}
              onClick={input.onOpenPersonaManager}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  input.onOpenPersonaManager();
                }
              }}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-ui text-[calc(var(--ui-fs)-3px)] not-italic text-t2">{input.personaAvatarAssetId ? <img src={avatarUrl(input.personaAvatarAssetId)} alt="" className="h-full w-full object-cover object-top" /> : initials(input.personaName)}</span>
              <span>{input.personaName}</span>
              <span className="ml-auto shrink-0 text-[calc(var(--ui-fs)-3px)] text-t3">
                Your Persona
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
