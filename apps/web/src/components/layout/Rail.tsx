import React, { useEffect, useRef, useState } from "react";
import { Ic } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { Ico, NavRow } from "./rail/rail-primitives.js";
import { ActionSheet } from "../shared/ActionSheet.js";
import { TagFilterSheet } from "./rail/TagFilterSheet.js";
import { RailCollapsedStrip } from "./rail/RailCollapsedStrip.js";
import { CharacterChatsSheet } from "./rail/CharacterChatsSheet.js";
import { RailCharacterBrowser } from "./rail/rail-character-browser.js";
import { Drawer } from "@base-ui/react/drawer";
import { getApplicationModalPortal } from "../shared/modal-helpers.js";
import { useSidebarChats } from "./hooks/use-sidebar-chats.js";
import { useSidebarCharacters } from "./hooks/use-sidebar-characters.js";
import { useRowActions } from "./hooks/use-row-actions.js";
import { useActivePersonaDisplay } from "./hooks/use-active-persona-display.js";
import { CharacterImportMobile, type CharacterImportMobileHandle } from "../modals/import/CharacterImportMobile.js";
import { ChatImportMobile, type ChatImportMobileHandle } from "../modals/import/ChatImportMobile.js";

/** Resolve a character list entry's avatar URL (folder avatar when migrated). */
const charAvatarSrc = (c: { id: string; avatarExt: string | null; avatarAssetId: string | null; updatedAt?: string | null }) =>
  resolveEntityAvatarUrl({ kind: "characters", id: c.id, avatarExt: c.avatarExt, avatarAssetId: c.avatarAssetId, updatedAt: c.updatedAt });
import { useT } from "../../i18n/context.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useChatMeta } from "../../stores/chat-selectors.js";
import { useChatList } from "../../stores/snapshot-store.js";
import { useNavigationStore, useChatStore, useModalStore } from "../../stores/index.js";
import { useCharacterStore } from "../../stores/character-store.js";
import { useCharacterController } from "../../hooks/use-character-controller.js";
import { useChatController } from "../../hooks/use-chat-controller.js";
import { useBuildPanels } from "../../hooks/use-build-panels.js";
import { useLastNonNull } from "../../hooks/use-last-non-null.js";


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

// The character ⋮ menu never renames anything; `useRowActions` still requires
// the four rename setters (the chat / branch menus that call them live in the
// character-chats panel, which owns its own `useRowActions`).
const noop = () => {};

export function Rail({ hidden }: { hidden?: boolean }) {
  const { t, tDynamic } = useT();
  const mode = useNavigationStore((s) => s.mode);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const allCharacters = useBootstrapStore((s) => s.data)?.allCharacters ?? [];
  const chatMeta = useChatMeta();
  // The chat list is the sidebar list, independent of any active chat. NOT
  // `chatMeta?.chats`: `useChatMeta()` is null without an active chat, which
  // would blank every character's count and chat list in the drawer.
  const chats = useChatList();
  const branches = chatMeta?.branches ?? [];
  const activeBranchId = chatMeta?.activeBranch?.id ?? null;

  // Branches are only available for the active chat (loaded via snapshot)
  const activeChatBranches = activeChatId ? branches : [];
  // The drawer opens on this character's chats (null without an active chat).
  const activeChatCharacterId = activeChatId ? chatMeta?.activeChat.characterId ?? null : null;
  const buildPanels = useBuildPanels();
  // The bottom panel's persona launcher — the same derivation as the desktop footer.
  const persona = useActivePersonaDisplay();

  const character = useCharacterController();
  const chat = useChatController();
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  const [expanded, setExpanded] = useState(false);
  // Mobile import orchestrators are always-mounted; rail buttons trigger them
  // via imperative `openPicker()` refs (see IF-6 of IMPORT_MOBILE_FLOW_PLAN.md).
  const characterImportRef = useRef<CharacterImportMobileHandle>(null);
  const chatImportRef = useRef<ChatImportMobileHandle>(null);
  // The character whose chats are shown in the CharacterChatsSheet (tablet
  // bottom sheet launched from a collapsed-strip avatar tap). null = closed.
  const [sheetCharId, setSheetCharId] = useState<string | null>(null);

  // Character ⋮ menu (opened from the character screen's header)
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  // Freeze the menu id so the closing ActionSheet keeps rendering its last
  // content during the Base UI exit transition (menuId → null on close;
  // without this the sheet would empty mid-slide). See use-last-non-null.ts.
  const frozenCharMenuId = useLastNonNull(charMenuId);

  // Character list: search + sort + tag-filter (mirrors the desktop Sidebar).
  // Sort mode lives in the navigation store; query + tags are local UI state.
  // Tags are filtered via a bottom sheet rather than a dropdown — the Rail
  // panel is a backdrop-blur root, so a portaled combobox (Sidebar's approach)
  // would be awkward on mobile; a bottom sheet is the native-mobile pattern.
  const [charQuery, setCharQuery] = useState("");
  const [charSelectedTags, setCharSelectedTags] = useState<string[]>([]);
  const [tagsSheetOpen, setTagsSheetOpen] = useState(false);

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

  // Chats for the CharacterChatsSheet — the shared useSidebarChats hook
  // (character-scope + mode split). While the sheet is closed (null) the result
  // is unused; when open on a character, this returns that character's chats.
  // The drawer's character screens derive theirs inside RailCharacterBrowser.
  const { sectionChats: sheetChats } = useSidebarChats({ allChats: chats, characterId: sheetCharId, query: "" });
  const sheetChar = sheetCharId ? allCharacters.find((c) => c.id === sheetCharId) ?? null : null;

  // Drawer open/close is driven by Base UI Drawer.Root — exit animation +
  // unmount are the drawer's own (onOpenChangeComplete), so there is no more
  // `closing` flag + setTimeout teardown. Swipe-left-to-close is the drawer's
  // native `swipeDirection="left"` physics; edge-swipe-to-open is
  // `Drawer.SwipeArea`.
  const toggle = () => setExpanded((v) => !v);
  const close = () => setExpanded(false);

  // Context-menu action builders — only the character menu is built here (the
  // hook is mode-agnostic; chat / branch menus are the panel's).
  const rowActions = useRowActions({
    mode: "rp",
    character,
    setConfirmDestroy,
    setRenamingChatId: noop,
    setRenameDraft: noop,
    setRenamingBranch: noop,
    setBranchRenameDraft: noop,
    openChatImport: () => chatImportRef.current?.openPicker(),
  });

  return (
    <>
      <Drawer.Root open={expanded} onOpenChange={(isOpen) => { if (!isOpen) setExpanded(false); else setExpanded(true); }} modal swipeDirection="left">
      {/* ═══ COLLAPSED RAIL ═══ */}
      {!hidden && (
        <>
        <div
          className="relative z-[200] flex w-[56px] min-w-[56px] shrink-0 flex-col items-center border-r border-border bg-surface backdrop-blur-md"
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
              <Ico key={panel.id} icon={panel.icon} onClick={() => { useCharacterStore.getState().setBuildTab(panel.id); useNavigationStore.getState().setMode('build'); }} title={tDynamic(panel.labelKey)} />
            ))
          ) : (
            <RailCollapsedStrip
              characters={allCharacters}
              selectedCharacterId={selectedCharacterId}
              avatarSrc={charAvatarSrc}
              createManualLabel={t("create_manual")}
              importCharShortLabel={t("import_char_short")}
              onCharacterClick={(id) => setSheetCharId(id)}
              onCreateCharacter={() => { useModalStore.getState().setCreateCharacterModalOpen(true); }}
              onImport={() => { characterImportRef.current?.openPicker(); }}
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
          {/* Edge-swipe to open — invisible strip pinned to the screen's left
              edge. Narrow (w-4) so it does not cover the rail's centered icons;
              swipe-right here opens the drawer. */}
          <Drawer.SwipeArea className="fixed inset-y-0 left-0 z-[201] w-4" />
        </>
      )}

      {/* ═══ EXPANDED OVERLAY PANEL ═══ */}
      {/* App-level host, NOT the overlay stack: the rail must never chase the
       *  topmost sheet anchor — a stack-top change mid-session would re-target
       *  this portal and tear the rail down (SHEET_PORTAL_SELF_TARGETING). */}
      <Drawer.Portal container={getApplicationModalPortal() ?? document.body}>
        <Drawer.Backdrop className="rail-backdrop fixed inset-0 z-[299] bg-black/40 backdrop-blur-sm" />
        <Drawer.Viewport className="fixed inset-0 z-[300]">
          <Drawer.Popup className="rail-popup glass-blur fixed left-0 top-0 bottom-0 flex w-[260px] flex-col border-r border-border bg-glass-bg shadow-theme-xl">
            {mode === "build" ? (
              <>
                {/* Header */}
                <div className="flex h-[48px] shrink-0 items-center border-b border-border px-3">
                  <div className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors active:bg-s3"
                       onClick={toggle}>
                    <Ic.menu />
                  </div>
                  <Drawer.Title className="ml-2 font-ui text-[calc(var(--ui-fs)+1px)] font-semibold text-t1 tracking-tight truncate">
                    {t("editor")}
                  </Drawer.Title>
                </div>

                {/* Scrollable content */}
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-scroll px-2 py-2">
                  {buildPanels.map((panel) => (
                    <RailRow key={panel.id} icon={panel.icon} label={tDynamic(panel.labelKey)}
                         onClick={() => { useCharacterStore.getState().setBuildTab(panel.id); close(); }} />
                  ))}
                </div>
              </>
            ) : (
              // Play mode: two screens — the character list and one character's chats.
              <RailCharacterBrowser
                open={expanded}
                activeCharacterId={activeChatCharacterId}
                characters={allCharacters}
                visibleCharacters={visibleChars}
                chats={chats}
                selectedCharacterId={selectedCharacterId}
                activeChatId={activeChatId}
                branches={activeChatBranches}
                activeBranchId={activeBranchId}
                filters={{
                  query: charQuery,
                  onQueryChange: setCharQuery,
                  tagCount: charSelectedTags.length,
                  tagsSheetOpen,
                  onOpenTags: () => setTagsSheetOpen(true),
                }}
                onClose={close}
                onCreateCharacter={() => { useModalStore.getState().setCreateCharacterModalOpen(true); close(); }}
                onImportCharacter={() => { characterImportRef.current?.openPicker(); close(); }}
                onOpenCharacterMenu={setCharMenuId}
                mode="rp"
                withBranches={true}
                emptyTitleKey="sidebar_send_a_message"
                character={character}
                chat={chat}
                setConfirmDestroy={setConfirmDestroy}
                openChatImport={() => chatImportRef.current?.openPicker()}
                onSwitchChat={(id) => { void chat.handleSwitchChat(id); }}
                onCreateChat={(characterId) => { void character.handleCreateChat(characterId); }}
              />
            )}

            {/* Bottom quick actions */}
            <div className="flex shrink-0 flex-col gap-0.5 border-t border-border bg-s2/30 px-2 py-3">
              <NavRow avatar={{ src: persona.avatarSrc, fallback: persona.fallback }} label={persona.name} onClick={() => { useModalStore.getState().setIsPersonaModalOpen(true); close(); }} />
              <NavRow icon={<Ic.terminal />} label={t("prompt_manager")} onClick={() => { useModalStore.getState().setIsPromptManagerOpen(true); close(); }} />
              <NavRow icon={<Ic.stack />} label={t("scenario_memory")} onClick={() => { useModalStore.getState().setContextMemoryOpen(true); close(); }} />
              <NavRow icon={<Ic.plug />} label={t("provider_settings_tooltip")} onClick={() => { useModalStore.getState().setIsProviderModalOpen(true); close(); }} />
              <NavRow icon={<Ic.sliders />} label={t("interface_settings_tooltip")} onClick={() => { useModalStore.getState().setTweaksOpen(true); close(); }} />
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
      </Drawer.Root>

      {/* ═══ BOTTOM SHEETS (context menus) ═══ */}
      <ActionSheet
        open={charMenuId !== null}
        title={frozenCharMenuId ? (allCharacters.find(c => c.id === frozenCharMenuId)?.name ?? "") : ""}
        items={frozenCharMenuId ? rowActions.buildCharMenuItems(frozenCharMenuId, allCharacters.find(c => c.id === frozenCharMenuId)?.name ?? "") : []}
        onClose={() => setCharMenuId(null)}
      />

      {/* ═══ TAG-FILTER BOTTOM SHEET ═══ */}
      {/* Multi-select tag picker — the mobile-native alternative to the desktop
          Sidebar's portaled tag combobox. Stays open while toggling so the user
          can pick several; backdrop tap or swipe-down dismisses. */}
      <TagFilterSheet
        open={tagsSheetOpen}
        selectedTags={charSelectedTags}
        tagPool={charTagPool}
        filterLabel={t("filter_by_tags")}
        resetLabel={t("reset")}
        onToggle={(tag) => setCharSelectedTags(charSelectedTags.includes(tag) ? charSelectedTags.filter((x) => x !== tag) : [...charSelectedTags, tag])}
        onReset={() => setCharSelectedTags([])}
        onClose={() => setTagsSheetOpen(false)}
      />

      {/* ═══ CHARACTER CHATS SHEET (tablet) ═══ */}
      {/* Launched from a collapsed-strip avatar tap — lists the character's chats
          (+ branches for the active chat) in a bottom sheet: the same
          CharacterChatsPanel the expanded drawer's character screen renders. */}
      {sheetCharId && sheetChar && (
        <CharacterChatsSheet
          characterId={sheetCharId}
          characterName={sheetChar.name}
          characterAvatarSrc={charAvatarSrc(sheetChar)}
          chats={sheetChats}
          activeChatId={activeChatId}
          branches={activeChatBranches}
          activeBranchId={activeBranchId}
          withBranches={true}
          emptyTitleKey="sidebar_send_a_message"
          mode="rp"
          character={character}
          chat={chat}
          setConfirmDestroy={setConfirmDestroy}
          openChatImport={() => chatImportRef.current?.openPicker()}
          onClose={() => setSheetCharId(null)}
          onSwitchChat={(id) => { void chat.handleSwitchChat(id); }}
          onCreateChat={() => { void character.handleCreateChat(sheetCharId ?? undefined); }}
        />
      )}

      {/* ═══ IMPORT ORCHESTRATORS (mobile; always-mounted) ═══ */}
      <CharacterImportMobile
        ref={characterImportRef}
        isImporting={character.isImporting}
        onImportFiles={(files, options) => { void character.handleImportFiles(files, options); }}
      />
      <ChatImportMobile
        ref={chatImportRef}
        isImporting={character.isImporting}
        onImportFiles={(files) => { void character.handleImportFiles(files); }}
      />
    </>
  );
}
