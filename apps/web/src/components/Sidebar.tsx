import { useEffect, useRef, useState } from "react";
import type { ChatId, ChatBranchId, ChatBranch } from "@rp-platform/domain";
import type { AppSnapshot, ChatListItem } from "../app-client.js";
import type { CharacterTab } from "./app-shell-types.js";
import { initials } from "./app-shell-helpers.js";
import { Icons } from "./shared/icons.js";

interface SidebarProps {
  sidebarCollapsed: boolean;
  activeChatId: ChatId;
  characterTabs: CharacterTab[];
  chats: ChatListItem[];
  branches: ChatBranch[];
  activeBranchId: ChatBranchId | null;
  personaName: string;
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
  onMergeActiveBranchIntoRoot: () => void;
  onDeleteActiveBranch: () => void;
}

const BACKEND_PENDING_TITLE = "Backend pending — see BACKEND_BACKLOG B8";

export function Sidebar(input: SidebarProps) {
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  const [chatMenuId, setChatMenuId] = useState<ChatId | null>(null);
  const [branchPopId, setBranchPopId] = useState<ChatId | null>(null);

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

  return (
    <aside className={`sidebar${input.sidebarCollapsed ? " col" : ""}`}>
      <div className="sb-head">
        <div className="logo-mark">r</div>
        {!input.sidebarCollapsed && <div className="app-name">Claw Tavern</div>}
        <button
          className="iBtn"
          aria-label={input.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={input.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={input.onToggleCollapsed}
        >
          <Icons.Caret direction={input.sidebarCollapsed ? "r" : "l"} />
        </button>
      </div>

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

          <section className="sb-sec">
            <div style={{ display: "flex", alignItems: "center", paddingRight: 10 }}>
              <div className="sb-lbl" style={{ flex: 1 }}>Characters</div>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={triggerImport} title="Import character (PNG/JSON)">
                <Icons.Import />
              </button>
              <button className="iBtn" style={{ width: 20, height: 20, opacity: 0.45, cursor: "not-allowed" }} title={BACKEND_PENDING_TITLE} disabled>
                <Icons.Plus />
              </button>
            </div>
            {input.characterTabs.length === 0 ? (
              <div style={{ padding: "16px 14px", textAlign: "center", color: "var(--t3)", fontSize: 12 }}>
                No characters yet — import a card to start.
              </div>
            ) : (
              input.characterTabs.map((character) => {
                const isActive = character.chatId === input.activeChatId;
                const menuOpen = charMenuId === character.id;
                return (
                  <div
                    key={character.id}
                    className={`sb-item${isActive ? " act" : ""}`}
                    style={{ position: "relative", zIndex: menuOpen ? 100 : 1, cursor: "pointer" }}
                    onClick={() => input.onSwitchChat(character.chatId)}
                  >
                    <span className={`sb-ava${isActive ? " on" : ""}`}>{initials(character.name)}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {character.name}
                    </span>
                    {!menuOpen && (
                      <div className="sb-char-acts">
                        <button
                          className="sb-chat-btn"
                          aria-label="Character actions"
                          title="Character actions"
                          onClick={(event) => {
                            event.stopPropagation();
                            setCharMenuId(menuOpen ? null : character.id);
                            setChatMenuId(null);
                            setBranchPopId(null);
                          }}
                        >
                          <Icons.Ellipsis />
                        </button>
                      </div>
                    )}
                    {menuOpen && (
                      <div
                        className="sb-chat-menu-popover"
                        ref={charMenuRef}
                        onClick={(event) => event.stopPropagation()}
                        style={{ top: 28, right: 4 }}
                      >
                        <div
                          className="sb-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setCharMenuId(null);
                            input.onExportCharacter(character.id);
                          }}
                        >
                          <Icons.Download /> Export
                        </div>
                        <div
                          className="sb-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setCharMenuId(null);
                            input.onArchiveCharacter(character.id);
                          }}
                        >
                          <Icons.Book /> Archive
                        </div>
                        <div className="sb-menu-sep" />
                        <div
                          className="sb-menu-item danger"
                          role="menuitem"
                          onClick={() => {
                            setCharMenuId(null);
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
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>

          <section className="sb-sec grow">
            <div style={{ display: "flex", alignItems: "center", paddingRight: 10 }}>
              <div className="sb-lbl" style={{ flex: 1 }}>Chats</div>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={triggerImport} title="Import chat (JSONL)">
                <Icons.Import />
              </button>
              <button className="iBtn" style={{ width: 20, height: 20 }} onClick={() => { const activeTab = input.characterTabs.find((tab) => tab.chatId === input.activeChatId); input.onCreateChat(activeTab?.id); }} title="New chat for active character">
                <Icons.Plus />
              </button>
            </div>
            {input.chats.length === 0 ? (
              <div style={{ padding: "20px 14px", textAlign: "center", color: "var(--t3)", fontSize: 12, lineHeight: 1.5 }}>
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
                    className={`sb-chat${isActive ? " act" : ""}`}
                    style={{ position: "relative", zIndex: chatMenuOpen || branchPopOpen ? 100 : 1, cursor: "pointer" }}
                    onClick={() => input.onSwitchChat(chat.id)}
                  >
                    {input.renamingChatId === chat.id ? (
                      <input
                        className="sb-chat-rename-input"
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
                      <div className="sb-ct">{chat.title}</div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 1 }}>
                      <div className="sb-cm" style={{ marginTop: 0 }}>
                        {chat.characterName} · {chat.messageCount} msgs
                      </div>
                      {isActive && branchCount > 0 && (
                        <div
                          className="sb-quick-branch"
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
                      <div className="sb-chat-acts">
                        <button
                          className="sb-chat-btn"
                          aria-label="Chat actions"
                          title="Chat actions"
                          onClick={(event) => {
                            event.stopPropagation();
                            setChatMenuId(chatMenuOpen ? null : chat.id);
                            setBranchPopId(null);
                          }}
                        >
                          <Icons.Ellipsis />
                        </button>
                      </div>
                    )}

                    {chatMenuOpen && (
                      <div className="sb-chat-menu-popover" ref={chatMenuRef} onClick={(event) => event.stopPropagation()}>
                        <div
                          className="sb-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setChatMenuId(null);
                            input.onRenameStart(chat.id, chat.title);
                          }}
                        >
                          <Icons.Edit /> Rename
                        </div>
                        <div
                          className="sb-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setChatMenuId(null);
                            input.onCloneChat(chat.id);
                          }}
                        >
                          <Icons.Copy /> Clone chat
                        </div>
                        <div
                          className="sb-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setChatMenuId(null);
                            input.onExportChatJsonl(chat.id);
                          }}
                        >
                          <Icons.Download /> Export (JSONL)
                        </div>
                        <div className="sb-menu-item disabled" role="menuitem" aria-disabled="true" title="Markdown export is deferred; use JSONL export">
                          <Icons.Download /> Export Markdown
                        </div>
                        <div
                          className={`sb-menu-item${chat.id === input.activeChatId && input.activePromptTraceId ? "" : " disabled"}`}
                          role="menuitem"
                          aria-disabled={chat.id !== input.activeChatId || !input.activePromptTraceId}
                          title={chat.id !== input.activeChatId || !input.activePromptTraceId ? "No prompt trace available for this chat" : ""}
                          onClick={() => {
                            if (chat.id === input.activeChatId && input.activePromptTraceId) {
                              setChatMenuId(null);
                              input.onExportPromptTrace(input.activePromptTraceId);
                            }
                          }}
                        >
                          <Icons.Download /> Export Prompt Trace
                        </div>
                        <div className="sb-menu-sep" />
                        <div
                          className="sb-menu-item danger"
                          role="menuitem"
                          onClick={() => {
                            setChatMenuId(null);
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
                      </div>
                    )}

                    {branchPopOpen && isActive && (
                      <div className="sb-chat-branches" ref={branchPopRef} onClick={(event) => event.stopPropagation()}>
                        <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--t3)", marginBottom: 4, paddingLeft: 4, fontWeight: 500, letterSpacing: ".05em" }}>
                          Timeline branches
                        </div>
                        {input.branches.map((branch) => {
                          const isActiveBranch = branch.id === input.activeBranchId;
                          return (
                            <div
                              key={branch.id}
                              className={`sb-branch-item${isActiveBranch ? " act" : ""}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                input.onActivateBranch(branch.id);
                                setBranchPopId(null);
                              }}
                            >
                              <div className="sb-br-title">{branch.label || "Unnamed branch"}</div>
                              <div className="sb-br-preview">
                                {isActiveBranch ? "Active" : "Tap to switch"}
                              </div>
                            </div>
                          );
                        })}
                        <div
                          className="sb-branch-action"
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            input.onFork();
                            setBranchPopId(null);
                          }}
                          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); input.onFork(); setBranchPopId(null); } }}
                        >
                          + Fork from here
                        </div>
                        {(() => {
                          const rootBranch = input.branches.find((b) => b.parentBranchId === null);
                          const activeIsRoot = rootBranch != null && input.activeBranchId === rootBranch.id;
                          const canAct = !activeIsRoot && input.branches.length > 1;
                          return (
                            <>
                              <div
                                className={`sb-branch-action${canAct ? "" : " disabled"}`}
                                role="button"
                                tabIndex={0}
                                aria-disabled={!canAct}
                                style={canAct ? undefined : { opacity: 0.45, cursor: "not-allowed" }}
                                title={canAct ? "" : "Switch to a non-main branch first"}
                                onClick={(event) => {
                                  if (!canAct) return;
                                  event.stopPropagation();
                                  input.onMergeActiveBranchIntoRoot();
                                  setBranchPopId(null);
                                }}
                                onKeyDown={(event) => { if (canAct && (event.key === "Enter" || event.key === " ")) { event.stopPropagation(); input.onMergeActiveBranchIntoRoot(); setBranchPopId(null); } }}
                              >
                                Merge active branch into main
                              </div>
                              <div
                                className={`sb-branch-action${canAct ? "" : " disabled"}`}
                                role="button"
                                tabIndex={0}
                                aria-disabled={!canAct}
                                style={canAct ? undefined : { opacity: 0.45, cursor: "not-allowed" }}
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
                                  setBranchPopId(null);
                                }}
                                onKeyDown={(event) => { if (canAct && (event.key === "Enter" || event.key === " ")) { event.stopPropagation(); input.onRequestDestructiveConfirm({ title: "Delete branch?", body: "Delete the active branch and its messages? Main timeline will stay.", confirmLabel: "Delete branch", onConfirm: () => input.onDeleteActiveBranch() }); setBranchPopId(null); } }}
                              >
                                Delete branch
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>

          <section className="sb-foot">
            <div
              className="sb-item"
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
              <span className="sb-ava" style={{ background: "transparent", color: "var(--t2)" }}>
                <Icons.Terminal />
              </span>
              <span>Prompt Manager</span>
            </div>
            <div
              className="sb-item"
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
              <span className="sb-ava">Y</span>
              <span>{input.personaName}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--t3)", flexShrink: 0 }}>
                Your Persona
              </span>
            </div>
          </section>
        </>
      )}
    </aside>
  );
}
