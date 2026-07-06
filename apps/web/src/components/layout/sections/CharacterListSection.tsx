/**
 * CharacterListSection — the expanded character list (title + sort/search/
 * import/create toolbar + tag-search panel + the character rows with their
 * export/duplicate/delete context menu). Shared by the RP `Sidebar` and
 * `CoauthorSidebar` (E3, post-SF-4 dedup). Structurally identical JSX between
 * the two; the only divergence is that the RP sidebar additionally closes the
 * chat/branch menus when a character menu opens (passed via the optional
 * `onCloseOtherMenus` callback — absent in coauthor, which has no chat/branch
 * menus).
 *
 * Local UI state (search toggle, query, selected tags, the char menu open/pos/
 * ref) is owned by the parent and passed in — both sidebars declare it
 * identically. A future `useCharacterSectionState` hook could consolidate it;
 * for now the JSX extraction is the priority (it removes ~115 lines × 2).
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { initials } from "../app-shell-helpers.js";
import { tabAvatarSrc } from "../sidebar-utils.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { ListSortToggle } from "../../shared/ListSortToggle.js";
import { ListSearchPanel } from "../../shared/ListSearchPanel.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useModalStore } from "../../../stores/index.js";
import type { ListSortMode } from "../../../stores/navigation-store.js";
import type { CharacterControllerActions } from "../../../hooks/use-character-controller.js";
import type { ConfirmDestroyDialog } from "../../../stores/character-store.js";
import type { CharacterTab } from "../app-shell-types.js";
import type { TFn } from "./section-types.js";

export function CharacterListSection({
  t,
  characterSortMode,
  setCharacterSortMode,
  charSearchOpen,
  setCharSearchOpen,
  charQuery,
  setCharQuery,
  charSelectedTags,
  setCharSelectedTags,
  charTagPool,
  characterTabs,
  visibleCharacterTabs,
  isCharacterTabActive,
  onSelectCharacter,
  onImportCharacter,
  character,
  setConfirmDestroy,
  charMenuId,
  setCharMenuId,
  onCloseOtherMenus,
}: {
  t: TFn;
  characterSortMode: ListSortMode;
  setCharacterSortMode: (v: ListSortMode) => void;
  charSearchOpen: boolean;
  setCharSearchOpen: (updater: (v: boolean) => boolean) => void;
  charQuery: string;
  setCharQuery: (v: string) => void;
  charSelectedTags: string[];
  setCharSelectedTags: (v: string[]) => void;
  charTagPool: readonly string[];
  characterTabs: readonly CharacterTab[];
  visibleCharacterTabs: readonly CharacterTab[];
  isCharacterTabActive: (tab: { id: string; chatId?: string | null }) => boolean;
  onSelectCharacter: (tab: CharacterTab) => void;
  onImportCharacter: () => void;
  character: CharacterControllerActions;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
  charMenuId: string | null;
  setCharMenuId: (v: string | null) => void;
  onCloseOtherMenus?: () => void;
}) {
  return (
    <section className="min-h-0 max-h-[50%] overflow-y-auto border-b border-border pb-1.5">
      <div className="sticky top-0 z-10 glass-blur bg-surface">
        <div className="flex items-center pr-2.5">
          <div className="flex-1 px-[13px] pt-1 pb-[5px] text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t("sidebar_characters")}</div>
          <ListSortToggle mode={characterSortMode} onChange={setCharacterSortMode} />
          <CustomTooltip content={t("search_name_placeholder")}>
            <button type="button" className={cn("iBtn size-5", charSearchOpen && "text-accent-t")} aria-pressed={charSearchOpen} onClick={() => setCharSearchOpen((v) => !v)}>
              <Icons.Search />
            </button>
          </CustomTooltip>
          <CustomTooltip content={t("sidebar_import_character")}>
            <button type="button" className="iBtn size-5" onClick={onImportCharacter}>
              <Icons.Import />
            </button>
          </CustomTooltip>
          <CustomTooltip content={t("sidebar_create_character")}>
            <button type="button" className="iBtn size-5" onClick={() => useModalStore.getState().setCreateCharacterModalOpen(true)}>
              <Icons.Plus />
            </button>
          </CustomTooltip>
        </div>
        {charSearchOpen && (
          <ListSearchPanel
            query={charQuery}
            onQueryChange={setCharQuery}
            selectedTags={charSelectedTags}
            onSelectedTagsChange={setCharSelectedTags}
            availableTags={charTagPool}
          />
        )}
      </div>
      {characterTabs.length === 0 ? (
        <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
          {t("sidebar_no_characters")}
        </div>
      ) : visibleCharacterTabs.length === 0 ? (
        <div className="px-[14px] py-5 text-center text-xs leading-relaxed text-t3">
          {t("search_no_results")}
        </div>
      ) : (
        visibleCharacterTabs.map((tab) => {
          const isActive = isCharacterTabActive(tab);
          const menuOpen = charMenuId === tab.id;
          return (
            <div
              key={tab.id}
              className={cn(
                'group relative mx-1 flex cursor-pointer items-center gap-[9px] rounded px-2.5 py-1.5 text-[calc(var(--ui-fs)-1px)] transition-colors duration-100',
                isActive ? 'bg-accent-dim text-accent-t hover:bg-accent-dim hover:text-accent-t' : 'text-t2 hover:bg-s2 hover:text-t1'
              )}
              style={{ zIndex: menuOpen ? 100 : 1 }}
              onClick={() => onSelectCharacter(tab)}
            >
              <span className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full font-ui text-[calc(var(--ui-fs)-2px)] not-italic avatar-fallback initials crop-framing',
                isActive ? 'bg-accent text-on-accent' : 'bg-s3 text-t2'
              )}>{tabAvatarSrc(tab) ? <img src={tabAvatarSrc(tab)!} alt={tab.name} className="h-full w-full object-cover" /> : initials(tab.name)}</span>
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {tab.name}
              </span>

              <DropdownMenu.Root
                modal={false}
                open={menuOpen}
                onOpenChange={(open) => {
                  if (open) { setCharMenuId(tab.id); onCloseOtherMenus?.(); }
                  else setCharMenuId(null);
                }}
              >
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 rounded pl-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                  <CustomTooltip content={t("sidebar_character_actions")}>
                    <DropdownMenu.Trigger asChild>
                      <button type="button"
                        className="flex h-[22px] w-[22px] scale-90 items-center justify-center rounded text-t3 transition-colors duration-100 hover:text-t1 data-[state=open]:text-t1"
                        aria-label={t("sidebar_character_actions")}
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
                      onSelect={() => character.handleExportCharacter(tab.id)}
                    >
                      <Icons.Download /> {t("sidebar_export")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-t2 outline-none transition-colors duration-100 hover:bg-s2 hover:text-t1 data-[highlighted]:bg-s2 data-[highlighted]:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                      onSelect={() => character.handleDuplicateCharacter(tab.id)}
                    >
                      <Icons.Copy /> {t("duplicate")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 px-3 py-[7px] text-[calc(var(--ui-fs)-2px)] text-danger-text outline-none transition-colors duration-100 hover:bg-danger-dim hover:text-danger-text data-[highlighted]:bg-danger-dim data-[highlighted]:text-danger-text [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
                      onSelect={() => setConfirmDestroy({
                        title: t("sidebar_delete_character"),
                        body: <>{t("sidebar_are_you_sure")} <b>{tab.name}</b></>,
                        confirmLabel: t("delete"),
                        onConfirm: () => character.handleDeleteCharacter(tab.id),
                      })}
                    >
                      <Icons.Trash /> {t("delete")}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          );
        })
      )}
    </section>
  );
}
