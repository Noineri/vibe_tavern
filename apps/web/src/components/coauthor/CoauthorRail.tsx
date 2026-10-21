/**
 * CoauthorRail — the phone / tablet rail of the Co-Author surface: the collapsed
 * strip (+ its tablet chats sheet) and the expanded drawer. The drawer's body is
 * the same two-screen `RailCharacterBrowser` the RP rail mounts (character list
 * ↔ one character's chats), with the Co-Author parameters — no branches, its own
 * chats, "new chat" creates a Co-Author chat. The drawer keeps ITS OWN bottom
 * panel (modules, skills, provider, interface).
 */
import { useEffect, useRef, useState } from "react";
import { Ic } from "../shared/icons.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { Ico, NavRow } from "../layout/rail/rail-primitives.js";
import { ActionSheet } from "../shared/ActionSheet.js";
import { TagFilterSheet } from "../layout/rail/TagFilterSheet.js";
import { RailCollapsedStrip } from "../layout/rail/RailCollapsedStrip.js";
import { CharacterChatsSheet } from "../layout/rail/CharacterChatsSheet.js";
import { RailCharacterBrowser } from "../layout/rail/rail-character-browser.js";
import { Drawer } from "@base-ui/react/drawer";
import { getApplicationModalPortal } from "../shared/modal-helpers.js";
import { useSidebarChats } from "../layout/hooks/use-sidebar-chats.js";
import { useSidebarCharacters } from "../layout/hooks/use-sidebar-characters.js";
import { useRowActions } from "../layout/hooks/use-row-actions.js";
import { CharacterImportMobile, type CharacterImportMobileHandle } from "../modals/import/CharacterImportMobile.js";

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
import { useLastNonNull } from "../../hooks/use-last-non-null.js";

// Co-Author intentionally does not surface JSONL chat import, so every
// `openChatImport` handed to the browser, the tablet sheet and `useRowActions`
// is a no-op. The character ⋮ menu never renames anything; `useRowActions` still
// requires the four rename setters (the chat menu that calls them lives in the
// character-chats panel, which owns its own `useRowActions`).
const noop = () => {};

export function CoauthorRail({ hidden }: { hidden?: boolean }) {
  const { t } = useT();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const selectedCharacterId = useChatStore((s) => s.selectedCharacterId);
  const allCharacters = useBootstrapStore((s) => s.data)?.allCharacters ?? [];
  const chatMeta = useChatMeta();
  // The chat list is the sidebar list, independent of any active chat. NOT
  // `chatMeta?.chats` — the same single source the RP rail reads (`Rail.tsx`).
  const chats = useChatList();
  // The drawer opens on this character's chats (null without an active chat).
  const activeChatCharacterId = activeChatId ? chatMeta?.activeChat.characterId ?? null : null;

  const character = useCharacterController();
  const chat = useChatController();
  const setConfirmDestroy = useCharacterStore((s) => s.setConfirmDestroy);

  const [expanded, setExpanded] = useState(false);
  const characterImportRef = useRef<CharacterImportMobileHandle>(null);
  // The character whose chats are shown in the CharacterChatsSheet (tablet bottom
  // sheet launched from a collapsed-strip avatar tap). null = closed.
  const [sheetCharId, setSheetCharId] = useState<string | null>(null);

  // Character ⋮ menu (opened from the character screen's header)
  const [charMenuId, setCharMenuId] = useState<string | null>(null);
  // Freeze the menu id so the closing ActionSheet keeps rendering its last
  // content during the Base UI exit transition (menuId → null on close).
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

  // Drawer open/close driven by Base UI Drawer.Root — exit animation + unmount
  // are the drawer's own (onOpenChangeComplete). Swipe-left-to-close is the
  // drawer's native swipeDirection="left"; edge-swipe-to-open is Drawer.SwipeArea.
  const toggle = () => setExpanded((v) => !v);
  const close = () => setExpanded(false);

  // Context-menu action builders — only the character menu is built here (the
  // hook is mode-agnostic; the chat menu is the panel's). Co-author has no
  // branches, so buildBranchMenuItems is never called.
  const rowActions = useRowActions({
    mode: "coauthor",
    character,
    setConfirmDestroy,
    setRenamingChatId: noop,
    setRenameDraft: noop,
    setRenamingBranch: noop,
    setBranchRenameDraft: noop,
    openChatImport: noop,
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
        </div>

        {/* Bottom quick actions */}
        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border py-2">
          <Ico icon={<Ic.tool />} onClick={() => useModalStore.getState().setCoauthorModuleModalOpen(true)} title={t("coauthor.sidebar.modules")} />
          <Ico icon={<Ic.book />} onClick={() => useModalStore.getState().setCoauthorSkillModalOpen(true)} title={t("coauthor.sidebar.skills")} />
          <Ico icon={<Ic.plug />} onClick={() => useModalStore.getState().setCoauthorProviderModalOpen(true)} title={t("provider_settings_tooltip")} />
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
       *  this portal and tear the rail down (SHEET_PORTAL_SELF_TARGETING). The
       *  panel's chat ⋮ sheets open from INSIDE this popup, so this holds for
       *  Co-Author exactly as for the RP rail. */}
      <Drawer.Portal container={getApplicationModalPortal() ?? document.body}>
        <Drawer.Backdrop className="rail-backdrop fixed inset-0 z-[299] bg-black/40 backdrop-blur-sm" />
        <Drawer.Viewport className="fixed inset-0 z-[300]">
          <Drawer.Popup className="rail-popup glass-blur fixed left-0 top-0 bottom-0 flex w-[260px] flex-col border-r border-border bg-glass-bg shadow-theme-xl">
            {/* Two screens — the character list and one character's chats. Co-Author
                has no branches: no `chat`, `withBranches={false}`, an empty branch list. */}
            <RailCharacterBrowser
              open={expanded}
              activeCharacterId={activeChatCharacterId}
              characters={allCharacters}
              visibleCharacters={visibleChars}
              chats={chats}
              selectedCharacterId={selectedCharacterId}
              activeChatId={activeChatId}
              branches={[]}
              activeBranchId={null}
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
              mode="coauthor"
              withBranches={false}
              emptyTitleKey="coauthor.list_empty"
              character={character}
              setConfirmDestroy={setConfirmDestroy}
              openChatImport={noop}
              onSwitchChat={(id) => { void chat.handleSwitchChat(id); }}
              onCreateChat={(characterId) => { void character.handleCreateChat(characterId, "coauthor"); }}
            />

            {/* Bottom quick actions */}
            <div className="flex shrink-0 flex-col gap-0.5 border-t border-border bg-s2/30 px-2 py-3">
              <NavRow icon={<Ic.tool />} label={t("coauthor.sidebar.modules")} onClick={() => { useModalStore.getState().setCoauthorModuleModalOpen(true); close(); }} />
              <NavRow icon={<Ic.book />} label={t("coauthor.sidebar.skills")} onClick={() => { useModalStore.getState().setCoauthorSkillModalOpen(true); close(); }} />
              <NavRow icon={<Ic.plug />} label={t("provider_settings_tooltip")} onClick={() => { useModalStore.getState().setCoauthorProviderModalOpen(true); close(); }} />
              <NavRow icon={<Ic.sliders />} label={t("interface_settings_tooltip")} onClick={() => { useModalStore.getState().setTweaksOpen(true); close(); }} />
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
      </Drawer.Root>

      {/* ═══ BOTTOM SHEET (character context menu) ═══ */}
      <ActionSheet
        open={charMenuId !== null}
        title={frozenCharMenuId ? (allCharacters.find(c => c.id === frozenCharMenuId)?.name ?? "") : ""}
        items={frozenCharMenuId ? rowActions.buildCharMenuItems(frozenCharMenuId, allCharacters.find(c => c.id === frozenCharMenuId)?.name ?? "") : []}
        onClose={() => setCharMenuId(null)}
      />

      {/* ═══ TAG-FILTER BOTTOM SHEET ═══ */}
      {/* Multi-select tag picker — the mobile-native alternative to the desktop
          Sidebar's portaled tag combobox. Stays open while toggling so the user
          can pick several tags; backdrop tap or swipe-down dismisses. */}
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
          in a bottom sheet. Co-author has no branches, so withBranches=false and
          the empty state covers a character with zero chats. */}
      {sheetCharId && sheetChar && (
        <CharacterChatsSheet
          characterId={sheetCharId}
          characterName={sheetChar.name}
          characterAvatarSrc={charAvatarSrc(sheetChar)}
          chats={sheetChats}
          activeChatId={activeChatId}
          branches={[]}
          activeBranchId={null}
          withBranches={false}
          emptyTitleKey="coauthor.list_empty"
          mode="coauthor"
          character={character}
          setConfirmDestroy={setConfirmDestroy}
          openChatImport={noop}
          onClose={() => setSheetCharId(null)}
          onSwitchChat={(id) => { void chat.handleSwitchChat(id); }}
          onCreateChat={() => { void character.handleCreateChat(sheetCharId ?? undefined, "coauthor"); }}
        />
      )}

      {/* ═══ IMPORT ORCHESTRATOR (mobile; always-mounted) ═══ */}
      <CharacterImportMobile
        ref={characterImportRef}
        isImporting={character.isImporting}
        onImportFiles={(files, options) => { void character.handleImportFiles(files, options); }}
      />
    </>
  );
}
