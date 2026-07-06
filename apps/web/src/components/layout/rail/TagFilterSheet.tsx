/**
 * TagFilterSheet — the mobile multi-select tag picker shared by the RP `Rail`
 * and `CoauthorRail` (E5d, post-SF-5 dedup). Byte-identical 53-line block in
 * both rails before extraction.
 *
 * Built on the shared `BottomSheet` primitive (vaul Drawer underneath), so the
 * chrome — scrim, slide-up, drag handle, swipe-to-dismiss, focus trap, ESC,
 * focus restoration — is inherited. This file owns only the tag-list content:
 * a header row (filter label + conditional reset button) and a scrollable list
 * of toggleable tag rows. Stays open while toggling tags (backdrop tap or
 * swipe-down dismisses) so the user can pick several — the mobile-native
 * counterpart to the desktop Sidebar's portaled tag combobox.
 *
 * The header is rendered as the first child (not via `BottomSheet`'s `title`
 * prop) because it is a flex row pairing the label with the reset button;
 * `BottomSheet` then emits its visually-hidden `Drawer.Title` fallback so the
 * dialog still has an accessible name (Radix Dialog requires one).
 */
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { BottomSheet } from "../../shared/BottomSheet.js";

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
  return (
    <BottomSheet open={true} onClose={onClose}>
      <div className="flex max-h-[65vh] flex-col">
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
    </BottomSheet>
  );
}
