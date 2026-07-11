/**
 * ListSearchPanel — name + optional tag-filter inputs for a sidebar list.
 *
 * Shared by the characters list (name + tags), the chats list (name only), and
 * the lorebook accordion (name/content + primary activation keys + secondary
 * activation keys). Renders a name text input plus one or two tag comboboxes.
 *
 * Each tag combobox: type to filter the pool, click a suggestion (or press
 * Enter) to add it as a removable chip. Multiple chips combine with AND
 * semantics (enforced downstream by the caller's filter). The primary and
 * secondary pools filter independently (both must match) — the lorebook uses
 * the secondary slot for secondary activation keys, kept as a DISTINCT input
 * (not merged into the primary pool) so users can target them specifically.
 *
 * The panel is controlled: the parent owns `query` and the selected-tags arrays
 * so the same state drives the downstream filter. The tag input draft
 * (`tagInput`) and the dropdown open state are the only local concerns —
 * encapsulated in `TagCombobox`, which is why two independent comboboxes can
 * share one panel without their draft/focus state colliding.
 *
 * The tag suggestion dropdown is a Radix Popover anchored to the input wrapper
 * (Popover.Anchor) with a controlled open state derived from `tagFocused` +
 * non-empty suggestions. `onOpenAutoFocus` is prevented so the input keeps
 * focus while the dropdown is open (combobox behavior). The Popover is portaled
 * to document.body so glass-blur escapes the sidebar's backdrop root (same
 * requirement as Sidebar's own menus). Radix handles positioning + collision +
 * outside-click, replacing the former manual getBoundingClientRect + scroll/
 * resize listeners + useOutsideClick.
 */

import { useRef, useState, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../lib/cn.js";

import { useT } from "../../i18n/context.js";

// ── TagCombobox (internal) ──────────────────────────────────────────────

interface TagComboboxProps {
  selectedTags: readonly string[];
  onSelectedTagsChange: (tags: string[]) => void;
  availableTags: readonly string[];
  /** Placeholder shown when no chip is selected. The parent resolves the i18n
   *  string so this combobox stays locale-agnostic. */
  placeholder: string;
}

function TagCombobox({
  selectedTags,
  onSelectedTagsChange,
  availableTags,
  placeholder,
}: TagComboboxProps) {
  const [tagInput, setTagInput] = useState("");
  const [tagFocused, setTagFocused] = useState(false);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const comboboxRef = useRef<HTMLDivElement | null>(null);

  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    return availableTags
      .filter((tag) => !selectedTags.includes(tag))
      .filter((tag) => (q ? tag.toLowerCase().includes(q) : true));
  }, [availableTags, tagInput, selectedTags]);

  const dropdownOpen = tagFocused && suggestions.length > 0;

  function addTag(tag: string) {
    const clean = tag.trim();
    if (clean && !selectedTags.includes(clean)) {
      onSelectedTagsChange([...selectedTags, clean]);
    }
    setTagInput("");
  }

  function removeTag(tag: string) {
    onSelectedTagsChange(selectedTags.filter((x) => x !== tag));
  }

  function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      // Prefer an exact filtered match, else the first suggestion, else the raw input.
      const exact = suggestions.find((s) => s.toLowerCase() === tagInput.trim().toLowerCase());
      addTag(exact ?? suggestions[0] ?? tagInput);
    } else if (e.key === "Backspace" && tagInput === "" && selectedTags.length > 0) {
      removeTag(selectedTags[selectedTags.length - 1]);
    }
  }

  return (
    <Popover.Root open={dropdownOpen} onOpenChange={(o) => { if (!o) setTagFocused(false); }}>
      <Popover.Anchor asChild>
        <div className="tag-combobox-wrap relative">
          <div
            ref={comboboxRef}
            className={cn(
              "flex min-h-[30px] flex-wrap items-center gap-1 rounded border bg-s2 px-1.5 py-1 transition-colors",
              tagFocused ? "border-accent" : "border-border",
            )}
            onClick={() => { tagInputRef.current?.focus(); setTagFocused(true); }}
          >
            {selectedTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
                onClick={() => removeTag(tag)}
              >
                {tag}
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
                  <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
                </svg>
              </span>
            ))}
            <input
              ref={tagInputRef}
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onFocus={() => setTagFocused(true)}
              placeholder={selectedTags.length === 0 ? placeholder : ""}
              className="min-w-[70px] flex-1 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t3/60"
            />
          </div>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={2}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // The combobox input lives in the Anchor, not the Content, so a
            // pointerdown on it (incl. the opening click) is "outside the
            // content" — guard it so only genuine outside clicks dismiss.
            const target = e.target as Node | null;
            if (target && comboboxRef.current?.contains(target)) e.preventDefault();
          }}
          className="glass-blur z-[400] max-h-[180px] overflow-y-auto rounded-md border border-border2 bg-glass-bg py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="block w-full cursor-pointer px-2.5 py-1 text-left font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors hover:bg-s2 hover:text-t1"
              onMouseDown={(e) => {
                // mousedown fires before the input blur/close; commit directly.
                e.preventDefault();
                addTag(tag);
                tagInputRef.current?.focus();
              }}
              onClick={() => addTag(tag)}
            >
              {tag}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── ListSearchPanel ─────────────────────────────────────────────────────

interface ListSearchPanelProps {
  query: string;
  onQueryChange: (query: string) => void;
  selectedTags: readonly string[];
  onSelectedTagsChange: (tags: string[]) => void;
  /** Tag pool for the primary combobox. Omit entirely for lists without tags
   *  (chats). */
  availableTags?: readonly string[];
  /** Placeholder for the primary combobox (default "Search by tags"). Relabel
   *  for non-tag pools, e.g. lorebook activation keys. */
  tagInputPlaceholder?: string;
  /** Optional SECONDARY tag pool (e.g. lorebook secondary activation keys).
   *  When all three are provided, a second, independent combobox renders below
   *  the primary one — a distinct input, not a merged pool. */
  secondarySelectedTags?: readonly string[];
  onSecondarySelectedTagsChange?: (tags: string[]) => void;
  secondaryAvailableTags?: readonly string[];
  secondaryTagInputPlaceholder?: string;
  className?: string;
}

export function ListSearchPanel({
  query,
  onQueryChange,
  selectedTags,
  onSelectedTagsChange,
  availableTags,
  tagInputPlaceholder,
  secondarySelectedTags,
  onSecondarySelectedTagsChange,
  secondaryAvailableTags,
  secondaryTagInputPlaceholder,
  className,
}: ListSearchPanelProps) {
  const { t } = useT();
  const showTags = availableTags !== undefined;
  const showSecondary =
    secondaryAvailableTags !== undefined &&
    secondarySelectedTags !== undefined &&
    onSecondarySelectedTagsChange !== undefined;

  return (
    <div className={cn("flex flex-col gap-1.5 px-2.5 pb-1.5 pt-0.5", className)}>
      {/* Name search */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t("search_name_placeholder")}
          className="w-full rounded border border-border bg-s2 px-2 py-[5px] font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none transition-colors placeholder:text-t3/60 focus:border-accent"
        />
      </div>

      {/* Primary tag/keys combobox */}
      {showTags && (
        <TagCombobox
          selectedTags={selectedTags}
          onSelectedTagsChange={onSelectedTagsChange}
          availableTags={availableTags!}
          placeholder={tagInputPlaceholder ?? t("search_tags_placeholder")}
        />
      )}

      {/* Secondary tag/keys combobox (distinct input — e.g. lorebook secondary keys) */}
      {showSecondary && (
        <TagCombobox
          selectedTags={secondarySelectedTags!}
          onSelectedTagsChange={onSecondarySelectedTagsChange!}
          availableTags={secondaryAvailableTags!}
          placeholder={secondaryTagInputPlaceholder ?? t("search_tags_placeholder")}
        />
      )}
    </div>
  );
}
