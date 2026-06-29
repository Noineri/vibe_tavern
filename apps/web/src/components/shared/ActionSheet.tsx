import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { BottomSheet } from "./BottomSheet.js";

export interface ActionSheetSubAction {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  action: () => void;
}

export interface ActionSheetItem {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  action: () => void;
  /** Optional always-visible trailing icon buttons rendered at the row's right
   *  edge (e.g. per-version rename/delete). Mobile has no hover, so these are
   *  shown by default — NOT revealed on hover. The row's main tap target still
   *  fires `action`; tapping a trailing button fires its own `action` instead.
   *  Both close the sheet first so any modal they open isn't stacked. */
  trailing?: ActionSheetSubAction[];
}

interface ActionSheetProps {
  open: boolean;
  title: string;
  items: ActionSheetItem[];
  onClose: () => void;
}

/**
 * Mobile action sheet — bottom-anchored overlay with swipe-to-dismiss.
 *
 * Extracted from Rail's inline `bottomSheet` (the three-dots character rail
 * menu) so the VTF-18 VersionSwitcher and any future mobile action menu share
 * one implementation. The swipe-to-dismiss touch logic lives in the
 * `BottomSheet` primitive this component renders on top of.
 *
 * Visual chrome (overlay + sheet container + slideUp/fadeIn + grabber + swipe)
 * is shared with QueueManager.MobileSheet; that one renders custom job rows so
 * it stays separate for now, but see jscpd-copy-paste-audit.md §2.9 for the
 * BottomSheet-primitive extraction candidate that would unify them.
 */
export function ActionSheet({ open, title, items, onClose }: ActionSheetProps) {
  const { t } = useT();
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      {items.map((item, i) => {
        // The row is a <button> when there are no trailing actions (preserves
        // the original semantics + styling for all current callers). When
        // trailing actions exist, nested <button>s would be invalid HTML, so
        // the row becomes a flex <div>: a flex-1 activate button + sibling
        // trailing icon buttons. Mobile shows trailing always (no hover).
        if (!item.trailing || item.trailing.length === 0) {
          return (
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
          );
        }
        return (
          <div key={i} className="flex items-center pr-3">
            <button type="button"
              className={cn(
                "flex flex-1 cursor-pointer items-center gap-4 px-5 min-h-[52px] text-[calc(var(--ui-fs)+1px)] transition-colors duration-100 active:bg-s3 text-left",
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
            {item.trailing.map((sub, j) => (
              <button key={j} type="button"
                className={cn(
                  "flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors",
                  sub.danger ? "text-t3 hover:bg-s3 hover:text-danger-text" : "text-t3 hover:bg-s3 hover:text-t1",
                )}
                aria-label={sub.label}
                title={sub.label}
                onClick={() => { onClose(); sub.action(); }}
              >
                {sub.icon}
              </button>
            ))}
          </div>
        );
      })}
      {/* Cancel */}
      <div className="h-px bg-border mx-4 mt-2" />
      <button type="button"
        className="flex w-full cursor-pointer items-center justify-center min-h-[52px] text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3 rounded-b-2xl"
        onClick={onClose}
      >
        {t("cancel")}
      </button>
    </BottomSheet>
  );
}
