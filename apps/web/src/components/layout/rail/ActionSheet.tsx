/**
 * ActionSheet — the mobile bottom-sheet context menu shared by the RP `Rail`
 * and `CoauthorRail` (E5c, post-SF-5 dedup).
 *
 * Self-contained: owns its swipe-to-dismiss (via `useSheetDrag`, the same hook
 * the tag-filter sheet uses — previously this was a duplicated inline
 * implementation), renders its own backdrop, and portals itself to
 * `document.body`. The parent only decides whether to mount it and what the
 * items/title/onClose are.
 *
 * Replaces the inline `bottomSheet = (title, items) => createPortal(...)`
 * closure that lived in each rail, plus the per-rail `sheetDragRef` /
 * `onSheetTouch*` / `menuRef` / `useOutsideClick(menuRef, …)` infrastructure.
 * The outside-click hook was redundant here: the fullscreen backdrop
 * (`fixed inset-0`) already captures every pointer event outside the sheet
 * and dismisses on click.
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../../lib/cn.js";
import { useSheetDrag } from "../hooks/use-swipe-sheet.js";

export interface ActionSheetItem {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  action: () => void;
}

export function ActionSheet({
  title,
  items,
  onClose,
  cancelLabel,
}: {
  title: string;
  items: ActionSheetItem[];
  onClose: () => void;
  cancelLabel: string;
}) {
  const { sheetRef, onTouchStart, onTouchMove, onTouchEnd } = useSheetDrag(onClose);

  return createPortal(
    <>
      {/* Затемнение */}
      <div
        className="fixed inset-0 z-[500] bg-black/50 backdrop-blur-sm"
        style={{ animation: "fadeIn 0.15s ease-out" }}
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        className="glass-blur fixed inset-x-0 bottom-0 z-[501] rounded-t-2xl border-t border-border2 bg-glass-bg pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_24px_rgba(0,0,0,0.5)]"
        ref={sheetRef}
        style={{ animation: "slideUp 0.2s ease-out" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        {/* Title */}
        <div className="px-5 pb-2 pt-1">
          <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{title}</span>
        </div>
        {/* Items */}
        {items.map((item, i) => (
          <button type="button"
            key={i}
            className={cn(
              "flex w-full cursor-pointer items-center gap-4 px-5 min-h-[52px] text-[calc(var(--ui-fs)+1px)] transition-colors duration-100 active:bg-s3 text-left",
              item.danger ? "text-danger-text" : "text-t2",
            )}
            onClick={() => { onClose(); item.action(); }}
          >
            <span className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              item.danger ? "bg-danger-dim/50" : "bg-s2",
            )}>
              {item.icon}
            </span>
            <span className={cn("font-ui", item.danger && "font-medium")}>{item.label}</span>
          </button>
        ))}
        {/* Cancel */}
        <div className="h-px bg-border mx-4 mt-2" />
        <button type="button"
          className="flex w-full cursor-pointer items-center justify-center min-h-[52px] text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3 rounded-b-2xl"
          onClick={onClose}
        >
          {cancelLabel}
        </button>
      </div>
    </>,
    document.body,
  );
}
