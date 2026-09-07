import { useCallback, useLayoutEffect, useState, type ReactNode } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { getModalPortal, registerOverlayPortal } from "./modal-helpers.js";

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
 * Built on **Base UI** (`@base-ui/react/drawer`), which extends Base UI `Dialog`
 * — so portal / focus-trap / outside-click / Escape / a11y are inherited, and
 * swipe-to-dismiss (`swipeDirection="down"`, the default) is the drawer's own
 * drag physics. It replaced the unmaintained `vaul` (see
 * `reports/SIDEBAR_RAIL_LIBRARY_MIGRATION_REPORT.md`); the enter/exit + swipe
 * animation is driven from `styles.css` (`.bs-backdrop` / `.bs-popup`) via
 * Base UI's `data-starting-style` / `data-ending-style` / `data-swiping` attrs
 * and the `--drawer-swipe-progress` / `--drawer-swipe-movement-y` CSS vars.
 *
 * The portal container is resolved ONCE per open transition and frozen for the
 * sheet's whole open lifecycle — see the session notes in the component body
 * (`reports/SHEET_PORTAL_SELF_TARGETING_REPORT.md`). The explicit
 * `?? document.body` fallback is load-bearing under happy-dom: the default
 * container resolution does not fire there (no layout), so the portal must
 * always be given a concrete node.
 */

/** One open lifecycle of the sheet: the portal container frozen at the open
 *  transition (captured in the layout effect below, never during render). */
interface PortalSession {
  container: HTMLElement;
}

export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  // D2 (v1.2.1): register the sheet's own portal node so nested floating UI
  // (DropdownSelect popups) opened inside the sheet portals HERE — inside the
  // drawer's focus scope and stacking context — instead of document.body
  // (z-400, under the sheet's z-500/501).
  //
  // SHEET_PORTAL_SELF_TARGETING (v1.2.2): D2 made `getModalPortal()` consult
  // the live overlay stack, and the portal container used to be re-evaluated
  // on EVERY render. The first open render resolved `document.body`; after
  // the anchor below registered at commit, any mid-session re-render (e.g. a
  // store update like a model-list fetch resolving) resolved the container to
  // the sheet's OWN anchor — React tore the portal subtree down mid-life,
  // Base UI's inert restore never landed (`#root[data-base-ui-inert]` leaked
  // forever), and `open` stayed true with no live DOM: "opens once, then
  // never again", whole app dead to pointer input until reload. The fix:
  // freeze the container in a session captured in the COMMIT phase only.
  const [portalSession, setPortalSession] = useState<PortalSession | null>(null);

  // Capture the container once per open transition. Render-phase capture
  // (refs mutated during render) is unsafe under React 19 concurrent
  // rendering — a render may be abandoned after mutating. The layout effect
  // runs after commit, and the anchor is gated on the session existing, so at
  // capture time the overlay stack cannot contain this sheet's anchor yet —
  // self-targeting is structurally impossible.
  //
  // Deliberately NO state update on the closing edge: the session (and its
  // container) is kept through the exit transition so the exiting drawer is
  // never re-targeted, and a state update during exit is exactly what stalled
  // the popup unmount in the MAE-53 regression (this component must stay
  // state-free on the close path). A stale session from a previous cycle is
  // simply replaced on the next open transition; the `isConnected` guard at
  // render bounds a stale disconnected container to one frame in
  // `document.body` before the fresh capture lands.
  useLayoutEffect(() => {
    if (!open) return;
    setPortalSession({ container: getModalPortal() ?? document.body });
  }, [open]);

  const sessionActive = portalSession !== null;
  const container =
    portalSession && portalSession.container.isConnected
      ? portalSession.container
      : document.body;

  // Stable callback ref; the returned function is React 19's ref-cleanup
  // (unregister on unmount). `{open && ...}` gating keeps a closed sheet off
  // the overlay stack.
  const portalAnchorRef = useCallback(
    (node: HTMLDivElement | null): (() => void) | undefined =>
      node === null ? undefined : registerOverlayPortal(node),
    [],
  );
  return (
    <Drawer.Root
      open={open && sessionActive}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      modal
      swipeDirection="down"
    >
      {/* Staged until a session exists: the very first open render mounts NO
       *  portal (container not yet captured); the layout effect above runs
       *  synchronously before paint and the next render mounts the portal
       *  into the frozen container — no body-then-swap, no first-frame flash. */}
      {portalSession && (
        <Drawer.Portal container={container}>
          {/* Scrim — `.inset-0` is the chrome selector BottomSheet.test.tsx
           *  resolves; keep it verbatim across any restyling. */}
          <Drawer.Backdrop className="bs-backdrop fixed inset-0 z-[500] bg-black backdrop-blur-sm" />
          <Drawer.Viewport className="fixed inset-0 z-[501]">
            {/* Sheet body — `.glass-blur` + safe-area + shadow are the chrome
           *  selectors BottomSheet.test.tsx resolves; carried verbatim across
           *  the vaul → Base UI swap. */}
            <Drawer.Popup className="bs-popup glass-blur fixed inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t border-border2 bg-glass-bg pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_24px_rgba(0,0,0,0.5)]">
              {/* Drag handle — purely visual; Base UI owns the drag gesture on the
           *  popup, so this is just the grabber bar (h-1 w-10 rounded-full
           *  bg-border) with margin substituting for the old padding wrapper. */}
              <div aria-hidden className="mx-auto mb-1 mt-2 block h-1 w-10 shrink-0 rounded-full bg-border" />
              {/* Title — the dialog requires an accessible name. When the caller
           *  passes a title it is rendered visibly AND serves as the name;
           *  when omitted, a visually-hidden fallback satisfies the
           *  requirement so the dialog validates without a stray label. */}
              {title != null ? (
                <Drawer.Title className="px-5 pb-2 pt-1 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t1">
                  {title}
                </Drawer.Title>
              ) : (
                <Drawer.Title className="sr-only">Sheet</Drawer.Title>
              )}
              <Drawer.Content className="flex flex-col">{children}</Drawer.Content>
            </Drawer.Popup>
            {/* Portal anchor for nested floating UI (DropdownSelect popups).
           *  Mirrors Modal's #modal-portal (same 0×0 fixed node shape): it must
           *  sit inside the Viewport for focus trapping, but OUTSIDE the
           *  animated Popup — transforms break fixed positioning (Modal.tsx
           *  carries the same warning). Placed after the Popup so popup
           *  content paints above the sheet body within the z-501 context.
           *  Rendered only while `open` — see the registration note above. */}
            {open && (
              <div
                ref={portalAnchorRef}
                data-overlay-portal="bottom-sheet"
                style={{ position: "fixed", top: 0, left: 0, width: 0, height: 0, overflow: "visible", pointerEvents: "auto" }}
              />
            )}
          </Drawer.Viewport>
        </Drawer.Portal>
      )}
    </Drawer.Root>
  );
}
