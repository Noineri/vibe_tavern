/**
 * TagFilterSheet — the mobile multi-select tag picker shared by the RP `Rail`
 * and `CoauthorRail` (E5d, post-SF-5 dedup). Byte-identical 53-line block in
 * both rails before extraction.
 *
 * Self-contained like `ActionSheet`: owns its swipe-to-dismiss via
 * `useSheetDrag(onClose)` and portals itself to `document.body`. Stays open
 * while toggling tags (backdrop tap or swipe-down dismisses) so the user can
 * pick several tags — the mobile-native counterpart to the desktop Sidebar's
 * portaled tag combobox.
 */
import { createPortal } from "react-dom";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { useSheetDrag } from "../hooks/use-swipe-sheet.js";

export function TagFilterSheet({
  selectedTags,
  tagPool,
  filterLabel,
  resetLabel,
  onToggle,
  onReset,
  onClose,
}: {
  selectedTags: string[];
  tagPool: readonly string[];
  filterLabel: string;
  resetLabel: string;
  onToggle: (tag: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { sheetRef, onTouchStart, onTouchMove, onTouchEnd } = useSheetDrag(onClose);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[500] bg-black/50 backdrop-blur-sm"
        style={{ animation: "fadeIn 0.15s ease-out" }}
        onClick={onClose}
      />
      <div
        className="glass-blur fixed inset-x-0 bottom-0 z-[501] flex max-h-[65vh] flex-col rounded-t-2xl border-t border-border2 bg-glass-bg pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_24px_rgba(0,0,0,0.5)]"
        ref={sheetRef}
        style={{ animation: "slideUp 0.2s ease-out" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        <div className="flex items-center justify-between px-5 pb-2 pt-1">
          <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{filterLabel}</span>
          {selectedTags.length > 0 && (
            <button type="button" className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-accent-t transition-opacity active:opacity-70" onClick={onReset}>
              {resetLabel}
            </button>
          )}
        </div>
        <div className="max-h-[45vh] overflow-y-auto px-2 pb-3">
          {tagPool.map((tag) => {
            const selected = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={cn("flex w-full min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-3 text-left transition-colors active:bg-s3", selected ? "text-accent-t" : "text-t2")}
                onClick={() => onToggle(tag)}
              >
                <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors", selected ? "border-accent bg-accent text-on-accent" : "border-border2")}>
                  {selected && <Ic.check />}
                </span>
                <span className="font-ui text-[calc(var(--ui-fs)-1px)]">{tag}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}
