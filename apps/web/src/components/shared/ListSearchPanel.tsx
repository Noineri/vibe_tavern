/**
 * ListSearchPanel — name + optional tag-filter inputs for a sidebar list.
 *
 * Shared by the characters list (name + tags) and the chats list (name only).
 * Renders a name text input, and — when `availableTags` is provided — a tag
 * combobox: type to filter the tag pool, click a suggestion (or press Enter) to
 * add it as a removable chip. Multiple chips combine with AND semantics
 * (enforced downstream by filterAndSortList).
 *
 * The panel is controlled: the parent owns `query` and `selectedTags` so the
 * same state drives filterAndSortList. The tag input draft (`tagInput`) and the
 * dropdown open state are the only local concerns.
 *
 * The tag suggestion dropdown is portaled to document.body. The sidebar is
 * itself a glass surface (backdrop-blur), which makes it a CSS backdrop root —
 * a dropdown rendered inside it can only blur the sidebar's own pixels, not the
 * page behind the sidebar, so it reads as a flat opaque box. Portal escapes
 * that root so glass-blur blurs the real page. Same pattern Sidebar uses for
 * its own character/chat action menus. Position is recomputed from the input's
 * getBoundingClientRect whenever the dropdown opens.
 */

import { useLayoutEffect, useRef, useState, useMemo, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.js";
import { useOutsideClick } from "../../hooks/use-outside-click.js";
import { useT } from "../../i18n/context.js";

interface ListSearchPanelProps {
  query: string;
  onQueryChange: (query: string) => void;
  selectedTags: readonly string[];
  onSelectedTagsChange: (tags: string[]) => void;
  /** Tag pool for autocomplete. Omit entirely for lists without tags (chats). */
  availableTags?: readonly string[];
  className?: string;
}

const MAX_SUGGESTIONS = 12;

export function ListSearchPanel({
  query,
  onQueryChange,
  selectedTags,
  onSelectedTagsChange,
  availableTags,
  className,
}: ListSearchPanelProps) {
  const { t } = useT();
  const [tagInput, setTagInput] = useState("");
  const [tagFocused, setTagFocused] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const tagWrapRef = useRef<HTMLDivElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const showTags = availableTags !== undefined;

  const suggestions = useMemo(() => {
    if (!showTags) return [];
    const q = tagInput.trim().toLowerCase();
    return availableTags!
      .filter((tag) => !selectedTags.includes(tag))
      .filter((tag) => (q ? tag.toLowerCase().includes(q) : true))
      .slice(0, MAX_SUGGESTIONS);
  }, [showTags, availableTags, tagInput, selectedTags]);

  const dropdownOpen = tagFocused && suggestions.length > 0;

  // Recompute portal position from the input rect each time the dropdown opens.
  // useLayoutEffect (not useEffect) so the portal is positioned before paint,
  // avoiding a one-frame flash at the wrong location.
  useLayoutEffect(() => {
    if (!dropdownOpen) {
      setDropdownPos(null);
      return;
    }
    const measure = () => {
      const el = tagInputRef.current;
      if (!el) return;
      const wrap = el.closest(".tag-combobox-wrap") as HTMLElement | null;
      const base = wrap ?? el;
      const r = base.getBoundingClientRect();
      setDropdownPos({ top: r.bottom + 2, left: r.left, width: r.width });
    };
    measure();
    // Re-measure on scroll/resize (the sidebar scrolls, shifting the anchor).
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [dropdownOpen]);

  // Close the dropdown on outside click. Keep it enabled only while focused so
  // it does not interfere with the rest of the sidebar.
  useOutsideClick(tagWrapRef as RefObject<HTMLDivElement | null>, () => setTagFocused(false), {
    enabled: tagFocused,
    event: "pointerdown",
  });

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

      {/* Tag search (characters only) */}
      {showTags && (
        <div ref={tagWrapRef} className="tag-combobox-wrap relative">
          <div
            className={cn(
              "flex min-h-[30px] flex-wrap items-center gap-1 rounded border bg-s2 px-1.5 py-1 transition-colors",
              tagFocused ? "border-accent" : "border-border",
            )}
            onClick={() => tagInputRef.current?.focus()}
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
              placeholder={selectedTags.length === 0 ? t("search_tags_placeholder") : ""}
              className="min-w-[70px] flex-1 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t3/60"
            />
          </div>

          {dropdownOpen && dropdownPos && createPortal(
            <div
              className="glass-blur fixed z-[400] max-h-[180px] overflow-y-auto rounded-md border border-border2 bg-glass-bg py-1 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
              style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}
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
            </div>,
            document.body,
          )}
        </div>
      )}
    </div>
  );
}
