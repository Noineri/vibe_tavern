import React, { useEffect, useMemo, useState } from "react";
import { ListSortToggle } from "../shared/ListSortToggle.js";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { Ic } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { initials } from "./app-shell-helpers.js";
import { Ico, NavRow } from "./rail/rail-primitives.js";
import { ActionSheet } from "../shared/ActionSheet.js";
import { TagFilterSheet } from "./rail/TagFilterSheet.js";
import { RailCollapsedStrip } from "./rail/RailCollapsedStrip.js";
import { usePanelSwipe, useRailEdgeSwipe } from "./hooks/use-swipe-sheet.js";
import { useSidebarChats } from "./hooks/use-sidebar-chats.js";
import { useSidebarCharacters } from "./hooks/use-sidebar-characters.js";
import { useRowActions } from "./hooks/use-row-actions.js";
import { CharacterImportModal, ChatImportModal } from "../modals/ImportModals.js";

/** Resolve a character list entry's avatar URL (folder avatar when migrated). */
const charAvatarSrc = (c: { id: string; avatarExt: string | null; avatarAssetId: string | null; updatedAt?: string | null }) =>
  resolveEntityAvatarUrl({ kind: "characters", id: c.id, avatarExt: c.avatarExt, avatarAssetId: c.avatarAssetId, updatedAt: c.updatedAt });
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

  // Branches are only available for the active chat (loaded via snapshot)
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
  const [branchMenuId, setBranchMenuId] = useState<{ chatId: ChatId; branchId: ChatBranchId; label: string } | null>(null);

  // Character list: search + sort + tag-filter (mirrors the desktop Sidebar).
  // Sort mode lives in the navigation store; query + tags are local UI state.
  // Tags are filtered via a bottom sheet rather than a dropdown — the Rail
  // panel is a backdrop-blur root, so a portaled combobox (Sidebar's approach)
  // would be awkward on mobile; a bottom sheet is the native-mobile pattern.
  const characterSortMode = useNavigationStore((s) => s.characterSortMode);
  const setCharacterSortMode = useNavigationStore((s) => s.setCharacterSortMode);
  const [charQuery, setCharQuery] = useState("");
  const [charSelectedTags, setCharSelectedTags] = useState<string[]>([]);
  const [tagsSheetOpen, setTagsSheetOpen] = useState(false);

  // Chat rename
  const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Hamburger force-open from TopBar
  const forceOpen = useNavigationStore((s) => s.railForceOpen);
  useEffect(() => {
    if (forceOpen > 0) setExpanded(true);
  }, [forceOpen]);


  // Character-list derivation (tag pool + sort/search/tag-filter) lives in
  // the useSidebarCharacters hook, shared with the desktop Sidebar. Rail does
  // not use the chatId-bearing characterTabs (it switches chats by explicit
  // click, so it's immune to F-6), but consumes the same visible list + tag
  // pool so desktop and mobile can't drift on character sort/filter.
  const { visibleCharacterTabs: visibleChars, charTagPool } = useSidebarCharacters({
    allCharacters,
    allChats: chats,
    query: charQuery,
    selectedTags: charSelectedTags,
  });

  // Active character — its chats are derived via the shared useSidebarChats
  // hook (character-scope + mode split), which is also where the rail's
  // mode-awareness lands: previously the rail rendered every chat for the
  // active character regardless of mode (the never-integrated mode work).
  // The rail has no chat search box (SF-1 scope), so query is ""; the desktop
  // sort mode from the nav store still applies via the hook.
  const activeCharId = selectedCharacterId ?? chatMeta?.character?.id ?? null;
  const { sectionChats } = useSidebarChats({ allChats: chats, characterId: activeCharId, query: "" });

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

  const commitRename = () => {
    const nextTitle = renameDraft.trim();
    if (nextTitle && renamingChatId) {
      void character.handleRenameChat(renamingChatId, nextTitle);
    }
    setRenamingChatId(null);
  };

  // Branch rename — mirrors chat-rename's inline-input pattern, but targets
  // renameBranchAction(chatId, branchId, label). renamingBranchId holds the
  // exact {chatId, branchId} being edited so the inline input knows which row
  // to replace.
  const [renamingBranch, setRenamingBranch] = useState<{ chatId: ChatId; branchId: ChatBranchId } | null>(null);
  const [branchRenameDraft, setBranchRenameDraft] = useState("");

  // Context-menu action builders (character / chat / branch). The hook is
  // mode-agnostic — rename and delete are offered for every chat. Branch menu
  // is RP-only in practice (co-author has no branches, so this Rail's
  // co-author fork never calls buildBranchMenuItems).
  const rowActions = useRowActions({
    mode: "rp",
    character,
    setConfirmDestroy,
    setRenamingChatId,
    setRenameDraft,
    setRenamingBranch,
    setBranchRenameDraft,
    setChatImportOpen,
  });
  const commitBranchRename = () => {
    const nextLabel = branchRenameDraft.trim();
    if (nextLabel && renamingBranch) {
      void renameBranchAction(renamingBranch.chatId, renamingBranch.branchId, nextLabel);
    }
    setRenamingBranch(null);
  };

  /* ── Swipe on expanded panel to close ── */
  const { onTouchStart: onPanelTouchStart, onTouchMove: onPanelTouchMove, onTouchEnd: onPanelTouchEnd } = usePanelSwipe(close);

  const { onTouchStart, onTouchMove, onTouchEnd } = useRailEdgeSwipe(expanded, setExpanded);

  return (
    <>
      {/* ═══ COLLAPSED RAIL ═══ */}
      {!hidden && (
      <div
        className="relative z-[200] flex w-[56px] min-w-[56px] shrink-0 flex-col items-center border-r border-border bg-surface backdrop-blur-md"
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
            <RailCollapsedStrip
              characters={allCharacters}
              selectedCharacterId={selectedCharacterId}
              avatarSrc={charAvatarSrc}
              chats={sectionChats}
              activeChatId={activeChatId}
              createManualLabel={t("create_manual")}
              importCharShortLabel={t("import_char_short")}
              moreCharactersLabel={t("more_characters") ?? `${allCharacters.length - 5} more`}
              newChatLabel={t("new_chat")}
              onSelectCharacter={(id) => { useChatStore.getState().setSelectedCharacterId(id); }}
              onSwitchChat={(id) => { void chat.handleSwitchChat(id); }}
              onCreateChat={() => { void character.handleCreateChat(selectedCharacterId ?? undefined); }}
              onCreateCharacter={() => { useModalStore.getState().setCreateCharacterModalOpen(true); }}
              onImport={() => { setImportOpen(true); }}
              onMoreCharacters={() => setExpanded(true)}
            />
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
            className="fixed inset-0 z-[299] bg-black/40 backdrop-blur-sm"
            style={{ animation: closing ? "fadeOut 0.2s ease-in forwards" : "fadeIn 0.2s ease-out" }}
            onClick={close}
          />

          {/* Panel */}
          <div
            className="glass-blur fixed left-0 top-0 bottom-0 z-[300] flex w-[260px] flex-col border-r border-border bg-glass-bg shadow-theme-xl"
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
                    <div className="flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border2 bg-s2/50 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-[background-color,transform] duration-150 ease-out active:bg-s3 active:scale-[0.96]"
                         onClick={() => { useModalStore.getState().setCreateCharacterModalOpen(true); close(); }}>
                      <Ic.plus /> <span className="truncate">{t("create_manual")}</span>
                    </div>
                    <div className="flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border2 bg-s2/50 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-[background-color,transform] duration-150 ease-out active:bg-s3 active:scale-[0.96]"
                         onClick={() => { setImportOpen(true); close(); }}>
                      <Ic.import /> <span className="truncate">{t("import_char_short")}</span>
                    </div>
                  </div>
                  <div className="my-1 h-px bg-border" />

                  {/* Search + sort + tag-filter row. No section header on mobile
                      — just the controls, compact. Tags open a bottom sheet. */}
                  <div className="flex items-center gap-1.5 px-1">
                    <input
                      type="text"
                      value={charQuery}
                      onChange={(e) => setCharQuery(e.target.value)}
                      placeholder={t("search_name_placeholder")}
                      className="min-w-0 flex-1 rounded border border-border bg-s2 px-2 py-[5px] font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none transition-colors placeholder:text-t3/60 focus:border-accent"
                    />
                    <ListSortToggle mode={characterSortMode} onChange={setCharacterSortMode} className="shrink-0" />
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        className={cn(
                          "flex h-[30px] w-8 items-center justify-center rounded border bg-s2 transition-colors active:bg-s3",
                          tagsSheetOpen || charSelectedTags.length > 0 ? "border-accent text-accent-t" : "border-border text-t3",
                        )}
                        onClick={() => setTagsSheetOpen(true)}
                        aria-label={t("filter_by_tags")}
                      >
                        <Ic.filter />
                      </button>
                      {charSelectedTags.length > 0 && (
                        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-ui text-[9px] font-bold text-on-accent">
                          {charSelectedTags.length}
                        </span>
                      )}
                    </div>
                  </div>
                  {visibleChars.length === 0 && (
                    <div className="px-3 py-6 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
                      {t("search_no_results")}
                    </div>
                  )}

                  {visibleChars.map((c) => (
                    <React.Fragment key={c.id}>
                      {/* Character row — soft card */}
                      <div
                        className={cn(
                          "group relative flex min-h-[56px] cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-[background-color,transform] duration-150 ease-out active:bg-s3 active:scale-[0.96]",
                          selectedCharacterId === c.id ? "bg-s2 border border-accent/20" : "bg-s2/30",
                        )}
                        onClick={() => { useChatStore.getState().setSelectedCharacterId(c.id); }}
                      >
                        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg", selectedCharacterId === c.id ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>
                          {charAvatarSrc(c) ? <img className="h-full w-full object-cover" src={charAvatarSrc(c)!} alt={c.name} /> : initials(c.name)}
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
                          sectionChats.some(ch => ch.id === activeChatId) ? "border-accent/50" : "border-border"
                        )}>
                          {sectionChats.map((ch) => (
                            <div key={ch.id}
                                 className={cn(
                                   "group relative flex min-h-[48px] cursor-pointer flex-col rounded-lg px-3 py-2 transition-[background-color,transform] duration-150 ease-out active:scale-[0.96]",
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

                              {/* Chat three-dot menu — enlarged touch target */}
                              <button type="button"
                                className={cn(
                                  "absolute right-1 inset-y-0 my-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-t3 transition-colors hover:text-t1 active:bg-s3",
                                  chatMenuId === ch.id && "text-t1 bg-s3",
                                )}
                                onClick={(e) => { e.stopPropagation(); setChatMenuId(ch.id); setCharMenuId(null); }}
                              >
                                <Ic.ellipsis />
                              </button>

                              {/* Branches — active chat only (data lives in the snapshot) */}
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
                                    {activeChatBranches.map((b) => {
                                      const isRenamingThisBranch = renamingBranch?.branchId === b.id && renamingBranch?.chatId === ch.id;
                                      return (
                                      <div
                                        key={b.id}
                                        className={cn(
                                          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 min-h-[44px] text-[calc(var(--ui-fs)-2px)] transition-colors active:bg-s3",
                                          b.id === activeBranchId ? "text-accent-t font-medium bg-accent-dim/50" : "text-t3"
                                        )}
                                        onClick={(e) => { if (!isRenamingThisBranch) { e.stopPropagation(); void activateBranchAction(ch.id as ChatId, b.id as ChatBranchId); } }}
                                      >
                                        <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", b.id === activeBranchId ? "bg-accent" : "bg-border2")} />
                                        {isRenamingThisBranch ? (
                                          <input
                                            className="mb-px w-full rounded border border-accent bg-bg px-1 py-0.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none"
                                            value={branchRenameDraft}
                                            autoFocus
                                            onChange={(e) => setBranchRenameDraft(e.target.value)}
                                            onClick={(e) => e.stopPropagation()}
                                            onBlur={commitBranchRename}
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") { e.preventDefault(); commitBranchRename(); }
                                              else if (e.key === "Escape") { e.preventDefault(); setRenamingBranch(null); }
                                            }}
                                          />
                                        ) : (
                                          <span className="truncate">{b.label || t("sidebar_unnamed_branch")}</span>
                                        )}
                                        <button type="button" className={cn("ml-auto shrink-0 cursor-pointer items-center justify-center rounded p-1 text-t3 transition-all active:bg-s3 active:text-t1", branchMenuId?.branchId === b.id && "text-t1 bg-s3")} onClick={(e) => { e.stopPropagation(); setCharMenuId(null); setChatMenuId(null); setBranchMenuId({ chatId: ch.id as ChatId, branchId: b.id as ChatBranchId, label: b.label }); }}>
                                          <Ic.ellipsis />
                                        </button>
                                      </div>
                                      );
                                    })}
                                  </div>
                                )}
                                </>
                              )}
                              {/* For inactive chats — show the branch label */}
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

      {/* ═══ BOTTOM SHEETS (context menus) ═══ */}
      {charMenuId && (
        <ActionSheet
          open={true}
          title={allCharacters.find(c => c.id === charMenuId)?.name ?? ""}
          items={rowActions.buildCharMenuItems(charMenuId, allCharacters.find(c => c.id === charMenuId)?.name ?? "")}
          onClose={() => setCharMenuId(null)}
        />
      )}

      {chatMenuId && (
        <ActionSheet
          open={true}
          title={sectionChats.find(c => c.id === chatMenuId)?.title ?? ""}
          items={rowActions.buildChatMenuItems(chatMenuId, sectionChats.find(c => c.id === chatMenuId)?.title ?? "")}
          onClose={() => setChatMenuId(null)}
        />
      )}

      {branchMenuId && (
        <ActionSheet
          open={true}
          title={branchMenuId.label || t("sidebar_unnamed_branch")}
          items={rowActions.buildBranchMenuItems({
            chatId: branchMenuId.chatId,
            branchId: branchMenuId.branchId,
            label: branchMenuId.label,
          })}
          onClose={() => setBranchMenuId(null)}
        />
      )}

      {/* ═══ TAG-FILTER BOTTOM SHEET ═══ */}
      {/* Multi-select tag picker — the mobile-native alternative to the desktop
          Sidebar's portaled tag combobox. Stays open while toggling so the user
          can pick several tags; backdrop tap or swipe-down dismisses. */}
      {tagsSheetOpen && (
        <TagFilterSheet
          selectedTags={charSelectedTags}
          tagPool={charTagPool}
          filterLabel={t("filter_by_tags")}
          resetLabel={t("reset")}
          onToggle={(tag) => setCharSelectedTags(charSelectedTags.includes(tag) ? charSelectedTags.filter((x) => x !== tag) : [...charSelectedTags, tag])}
          onReset={() => setCharSelectedTags([])}
          onClose={() => setTagsSheetOpen(false)}
        />
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
