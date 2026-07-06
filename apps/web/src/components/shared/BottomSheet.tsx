import { type ReactNode } from "react";
import { Drawer } from "vaul";
import { getModalPortal } from "./modal-helpers.js";

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
 * Built on **vaul** (`Drawer.Root`/`Overlay`/`Content`/`Handle`/`Title`), which
 * is itself Radix Dialog underneath. That brings the a11y layer the hand-rolled
 * version lacked: `role="dialog"` + `aria-modal`, a focus trap, ESC-to-close,
 * and focus restoration to the trigger — all free. Swipe-to-dismiss is vaul's
 * own drag physics (`close_threshold` fraction of sheet height, default ~0.5),
 * replacing the former inline 80px-absolute threshold; see
 * `reports/bottomsheet-vaul-migration.md` for the migration rationale.
 *
 * The `container={getModalPortal() ?? document.body}` wiring on `Drawer.Portal`
 * portals the sheet into the nearest Radix Dialog's `#modal-portal` when the
 * sheet is rendered inside a modal (so it stays within that dialog's focus
 * trap); otherwise it portals to `document.body`. The explicit fallback is
 * load-bearing under happy-dom: Radix Portal's default container resolution
 * does not fire there (no layout), so the portal must be given a concrete node.
 */
export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      onClose={onClose}
      dismissible
      modal
      direction="bottom"
    >
      <Drawer.Portal container={getModalPortal() ?? document.body}>
        {/* Scrim — `.inset-0` is the chrome selector BottomSheet.test.tsx
         *  resolves; keep it verbatim across any restyling. */}
        <Drawer.Overlay className="fixed inset-0 z-[500] bg-black/50 backdrop-blur-sm" />
        {/* Sheet body — `.glass-blur` + safe-area + shadow are the chrome
         *  selectors BottomSheet.test.tsx resolves; carried verbatim from the
         *  pre-vaul implementation. */}
        <Drawer.Content className="glass-blur fixed inset-x-0 bottom-0 z-[501] flex flex-col rounded-t-2xl border-t border-border2 bg-glass-bg pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_24px_rgba(0,0,0,0.5)]">
          {/* Drag handle — vaul owns the drag gesture via Drawer.Handle; the
           *  className reproduces the former grabber bar (h-1 w-10 rounded-full
           *  bg-border) with margin substituting for the old padding wrapper. */}
          <Drawer.Handle className="mx-auto mb-1 mt-2 block h-1 w-10 shrink-0 rounded-full bg-border" />
          {/* Title — Radix Dialog requires an accessible name. When the caller
           *  passes a title it is rendered visibly AND serves as the name; when
           *  omitted, a visually-hidden fallback satisfies the requirement so
           *  the dialog validates without surfacing a stray label. */}
          {title != null ? (
            <Drawer.Title className="px-5 pb-2 pt-1 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">
              {title}
            </Drawer.Title>
          ) : (
            <Drawer.Title className="sr-only">Sheet</Drawer.Title>
          )}
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
