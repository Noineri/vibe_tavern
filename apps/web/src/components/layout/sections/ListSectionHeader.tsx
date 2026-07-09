/**
 * ListSectionHeader — the sticky toolbar that caps every sidebar list section
 * (characters + chats, RP + coauthor). Renders the section title plus four
 * controls: sort cycle, search toggle, import, and create/new. When search is
 * open, the `ListSearchPanel` (name + optional tag filter) mounts beneath.
 *
 * Shared by `CharacterListSection` and the chat-list sections of both
 * `Sidebar` and `CoauthorSidebar` (SIDEBAR_GOD_OBJECT_AUDIT step 3a, decision A
 * — full unification of the three byte-identical header copies). All variation
 * (title, tooltips, actions, sort mode, optional tags) is parameterized via
 * props; the chrome is identical.
 *
 * Intentional unification: the coauthor chat header used `z-10` on its sticky
 * wrapper while RP + the character list used `z-[110]`. The coauthor sidebar
 * already renders a `z-[110]` sticky header via the shared `CharacterListSection`
 * (its character list), so `z-10` was drift, not intent — unified to `z-[110]`
 * here (same call as the footer h-8->h-9 fold in step 2).
 *
 * Tag filtering is characters-only: chats omit `availableTags` (the panel then
 * renders the name input alone, per `ListSearchPanel`'s `availableTags?` opt).
 */
import { ListSortToggle } from "../../shared/ListSortToggle.js";
import { ListSearchPanel } from "../../shared/ListSearchPanel.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import type { ListSortMode } from "../../../stores/navigation-store.js";
import type Resources from "../../../i18n/resources.js";

type ListSectionHeaderProps = {
  titleKey: keyof Resources["en"];
  sortMode: ListSortMode;
  onSortChange: (mode: ListSortMode) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  importTooltipKey: keyof Resources["en"];
  onImport: () => void;
  createTooltipKey: keyof Resources["en"];
  onCreate: () => void;
  /** Tag-filter state (characters only; chats leave these unset). */
  selectedTags?: readonly string[];
  onSelectedTagsChange?: (tags: string[]) => void;
  /** Tag pool for autocomplete; omit for lists without tags (chats). */
  availableTags?: readonly string[];
};

export function ListSectionHeader({
  titleKey,
  sortMode,
  onSortChange,
  searchOpen,
  onToggleSearch,
  searchQuery,
  onSearchQueryChange,
  importTooltipKey,
  onImport,
  createTooltipKey,
  onCreate,
  selectedTags,
  onSelectedTagsChange,
  availableTags,
}: ListSectionHeaderProps) {
  const { t } = useT();
  return (
    <div className="sticky top-0 z-[110] glass-blur bg-surface">
      <div className="flex items-center pr-2.5">
        <div className="flex-1 px-[13px] pt-1 pb-[5px] text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">{t(titleKey)}</div>
        <ListSortToggle mode={sortMode} onChange={onSortChange} />
        <CustomTooltip content={t("search_name_placeholder")}>
          <button type="button" className={cn("iBtn size-5", searchOpen && "text-accent-t")} aria-pressed={searchOpen} onClick={onToggleSearch}>
            <Icons.Search />
          </button>
        </CustomTooltip>
        <CustomTooltip content={t(importTooltipKey)}>
          <button type="button" className="iBtn size-5" onClick={onImport}>
            <Icons.Import />
          </button>
        </CustomTooltip>
        <CustomTooltip content={t(createTooltipKey)}>
          <button type="button" className="iBtn size-5" onClick={onCreate}>
            <Icons.Plus />
          </button>
        </CustomTooltip>
      </div>
      {searchOpen && (
        <ListSearchPanel
          query={searchQuery}
          onQueryChange={onSearchQueryChange}
          selectedTags={selectedTags ?? []}
          onSelectedTagsChange={onSelectedTagsChange ?? (() => {})}
          availableTags={availableTags}
        />
      )}
    </div>
  );
}
