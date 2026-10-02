/**
 * BuildCharacterSwitcher — the build-mode character switcher in BOTH sidebar
 * shapes (LB-3A, extracted verbatim from Sidebar.tsx):
 *
 *   - "expanded": the «name + character-editing» trigger row (the
 *     sidebar_editing_character label) with a bottom popover (24px row
 *     avatars, portal only when > 1 tab).
 *   - "collapsed": the 40px avatar trigger with a right-side flyout
 *     (flyoutCardIn stagger animation, 3px active bar).
 *
 * The two variants share ONE search row + ONE filtered-list derivation:
 * `query` (reset whenever `open` goes false), `showSearch` when the tab count
 * exceeds MAX_VISIBLE_ITEMS, `visibleTabs` through `matchesLinkQuery` from
 * `lib/link-binding-sections.ts` (the Wave-2 binding-popover matcher —
 * trimmed, case-insensitive, Cyrillic-safe). Order is UNCHANGED — the
 * «recently updated» ordering decision covers the binding popover only.
 */
import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../lib/cn.js";
import { matchesLinkQuery } from "../../../lib/link-binding-sections.js";
import { MAX_VISIBLE_ITEMS } from "../../shared/popover-constants.js";
import { SearchInput } from "../../shared/SearchInput.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Icons } from "../../shared/icons.js";
import { initials } from "../app-shell-helpers.js";
import { tabAvatarSrc } from "../sidebar-utils.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import type { CharacterTab } from "../app-shell-types.js";
import type { TFn } from "./section-types.js";

export interface BuildCharacterSwitcherProps {
  variant: "expanded" | "collapsed";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterTabs: readonly CharacterTab[];
  activeCharacterId: string | null;
  activeCharacterName: string | null;
  activeAvatarSrc: string | null;
  onPick: (tab: CharacterTab) => void;
  t: TFn;
}

export function BuildCharacterSwitcher({
  variant,
  open,
  onOpenChange,
  characterTabs,
  activeCharacterId,
  activeCharacterName,
  activeAvatarSrc,
  onPick,
  t,
}: BuildCharacterSwitcherProps) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const showSearch = characterTabs.length > MAX_VISIBLE_ITEMS;
  const visibleTabs = query.trim()
    ? characterTabs.filter((tab) => matchesLinkQuery(tab.name, query))
    : characterTabs;

  const searchRow = showSearch ? (
    <div className="shrink-0 border-b border-border px-2 py-1.5">
      <SearchInput
        ref={searchInputRef}
        className="w-full"
        placeholder={t("link_binding_search_placeholder")}
        aria-label={t("link_binding_search_placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
    </div>
  ) : null;

  const noResultsRow = query.trim() !== "" && visibleTabs.length === 0 ? (
    <div className="px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("link_binding_no_results")}</div>
  ) : null;

  // Focus the search row when it exists — desktop only (no keyboard pop on
  // phones); otherwise keep Radix's default focus (first focusable item).
  const handleOpenAutoFocus = (e: Event) => {
    if (showSearch && !isMobile) {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  };

  if (variant === "collapsed") {
    return (
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <CustomTooltip content={activeCharacterName ?? t('switch_character')} side="right">
          <Popover.Trigger asChild>
            <div
              className={cn('flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all duration-150', open ? '' : 'hover:bg-s2')}
            >
              <span className={cn("flex h-full w-full items-center justify-center overflow-hidden rounded-full font-ui text-sm", activeAvatarSrc ? "bg-s3" : "bg-accent text-on-accent", open && "ring-1 ring-accent/50 ring-offset-2 ring-offset-surface")}>
                {activeAvatarSrc
                  ? <img src={activeAvatarSrc} alt="" className="h-full w-full object-cover" />
                  : initials(activeCharacterName ?? '?')}
              </span>
            </div>
          </Popover.Trigger>
        </CustomTooltip>
        <Popover.Portal>
          <Popover.Content
            side="right"
            align="start"
            sideOffset={6}
            onOpenAutoFocus={handleOpenAutoFocus}
            className="glass-blur z-[301] flex w-[300px] max-w-[calc(100vw-70px)] flex-col overflow-hidden rounded-r-xl border border-border bg-glass-bg shadow-[16px_8px_24px_-8px_rgba(0,0,0,0.4)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            style={{ animation: "flyoutIn 0.18s ease-out" }}
          >
            {searchRow}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1" style={{ maxHeight: "var(--radix-popper-available-height)" }}>
              {visibleTabs.map((tab, index) => {
                const isActive = tab.id === activeCharacterId;
                return (
                  <div
                    key={tab.id}
                    role="button"
                    tabIndex={0}
                    style={{ animation: "flyoutCardIn 0.22s ease-out backwards", animationDelay: `${Math.min(index, 12) * 26}ms` }}
                    className={cn(
                      "relative mx-1 mb-0.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors duration-150",
                      isActive ? "bg-accent-dim" : "hover:bg-s2 focus-visible:bg-s2",
                    )}
                    onClick={() => onPick(tab)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(tab); } }}
                  >
                    {isActive && <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-accent" />}
                    <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full", tabAvatarSrc(tab) ? "" : isActive ? "bg-accent text-on-accent" : "bg-s3 text-t2")}>
                      {tabAvatarSrc(tab)
                        ? <img className="h-full w-full object-cover" src={tabAvatarSrc(tab)!} alt={tab.name} loading="lazy" decoding="async" />
                        : <span className="font-ui text-[calc(var(--ui-fs)-4px)]">{initials(tab.name)}</span>}
                    </div>
                    <span className={cn("truncate text-[calc(var(--ui-fs)-1px)]", isActive ? "font-medium text-accent-t" : "text-t2")}>{tab.name}</span>
                  </div>
                );
              })}
              {noResultsRow}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <div
          className="flex cursor-pointer items-center gap-2.5 rounded-lg transition-colors hover:bg-s2"
          style={{ padding: '6px 8px' }}
        >
          <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full', activeAvatarSrc ? '' : 'bg-accent text-on-accent')}>
            {activeAvatarSrc ? (
              <img className="h-full w-full object-cover" src={activeAvatarSrc} alt="" />
            ) : (
              <span className="font-ui text-sm">{initials(activeCharacterName ?? '?')}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[calc(var(--ui-fs)-1px)] font-medium text-t1">{activeCharacterName ?? t('unnamed')}</div>
            <div className="truncate text-[calc(var(--ui-fs)-3px)] text-t3">{t('sidebar_editing_character')}</div>
          </div>
          <Icons.Caret direction={open ? "u" : "d"} />
        </div>
      </Popover.Trigger>
      {characterTabs.length > 1 && (
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={handleOpenAutoFocus}
            className="glass-blur z-[400] rounded-lg border border-border bg-glass-bg shadow-theme-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 flex min-w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden"
          >
            {searchRow}
            <div className="max-h-[240px] overflow-y-auto py-1">
              {visibleTabs.map(tab => (
                <div
                  key={tab.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 transition-colors',
                    tab.id === activeCharacterId ? 'bg-accent-dim hover:bg-accent-dim' : 'hover:bg-s2'
                  )}
                  style={{ padding: '6px 12px' }}
                  onClick={() => onPick(tab)}
                >
                  <div className={cn('flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full', tabAvatarSrc(tab) ? '' : tab.id === activeCharacterId ? 'bg-accent text-on-accent' : 'bg-s3 text-t2')}>
                    {tabAvatarSrc(tab)
                      ? <img className="h-full w-full object-cover" src={tabAvatarSrc(tab)!} alt={tab.name} loading="lazy" decoding="async" />
                      : <span className="font-ui text-[calc(var(--ui-fs)-4px)]">{initials(tab.name)}</span>}
                  </div>
                  <span className={cn('truncate text-[calc(var(--ui-fs)-1px)]', tab.id === activeCharacterId ? 'text-accent-t font-medium' : 'text-t2')}>{tab.name}</span>
                </div>
              ))}
              {noResultsRow}
            </div>
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );
}
