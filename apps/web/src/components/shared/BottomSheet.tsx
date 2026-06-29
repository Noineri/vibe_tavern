import { useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Optional title row rendered above the content. Omit for a header-less
   *  sheet (e.g. one that renders its own custom header as the first child). */
  title?: ReactNode;
  /** Content below the title (rows, list, footer, cancel button, ...). */
  children: ReactNode;
}

/**
 * Mobile bottom sheet — the shared chrome (scrim + slide-up container + grabber
 * + swipe-to-dismiss) extracted so selection lists, action menus, and custom
 * sheets reuse one implementation. See `reports/jscpd-copy-paste-audit.md` §9.
 *
 * `ActionSheet` is the action-list layer on top of this primitive (it passes
 * its flat `{icon,label,action}` items + cancel button as `children`). Callers
 * with bespoke content (selection lists with checkmarks, custom headers) use
 * `BottomSheet` directly and render their own rows + footer as `children`.
 *
 * Swipe-to-dismiss: drag the sheet down past ~80px to close. The touch logic
 * is identical to the former inline `ActionSheet` implementation (and Rail's
 * `bottomSheet` helper, from which ActionSheet was originally extracted).
 */
export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, startY: 0, currentY: 0 });

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    dragRef.current = { active: true, startY: e.touches[0].clientY, currentY: e.touches[0].clientY };
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.currentY = e.touches[0].clientY;
    const delta = dragRef.current.currentY - dragRef.current.startY;
    if (delta > 0 && sheetRef.current) {
      sheetRef.current.style.transition = "none";
      sheetRef.current.style.transform = `translateY(${delta}px)`;
    }
  }, []);
  const onTouchEnd = useCallback(() => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const delta = dragRef.current.currentY - dragRef.current.startY;
    if (sheetRef.current) {
      sheetRef.current.style.transition = "";
      sheetRef.current.style.transform = "";
    }
    if (delta > 80) onClose();
  }, [onClose]);

  if (!open) return null;

  return createPortal(
    <>
      {/* Scrim */}
      <div
        className="fixed inset-0 z-[500] bg-black/50 backdrop-blur-sm"
        style={{ animation: "fadeIn 0.15s ease-out" }}
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        ref={sheetRef}
        className="glass-blur fixed inset-x-0 bottom-0 z-[501] rounded-t-2xl border-t border-border2 bg-glass-bg pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_24px_rgba(0,0,0,0.5)]"
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
        {title != null && (
          <div className="px-5 pb-2 pt-1">
            <span className="font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">{title}</span>
          </div>
        )}
        {children}
      </div>
    </>,
    document.body,
  );
}
