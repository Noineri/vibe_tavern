import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
// getModalPortal lives in modal-helpers.ts — import from there directly.
// Do NOT re-export here to keep this file Fast Refresh compatible.
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

export interface ModalProps {
  /** Controls open state */
  open: boolean;
  /** Called when user requests close (Escape, overlay click) */
  onClose: () => void;
  /** Modal content — the caller provides the styled inner panel */
  children: ReactNode;
  /** Optional extra class on overlay div */
  overlayClassName?: string;
  /** When true, modal stays centered on mobile (for confirm/delete dialogs). Default: fullscreen on mobile. */
  compact?: boolean;
  /** When true, overlay is not rendered (caller provides its own or it's nested). */
  hideOverlay?: boolean;
  /** Accessible title for Radix Dialog. Hidden visually by default. */
  title?: string;
  /** Accessible description for Radix Dialog. Hidden visually by default. */
  description?: string;
}

export function Modal({
  open,
  onClose,
  children,
  overlayClassName,
  compact,
  hideOverlay,
  title = "Dialog",
  description = "Application dialog",
}: ModalProps) {
  const isMobile = useIsMobile();
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        {!hideOverlay && (
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-[500] bg-black/55 backdrop-blur-[2px]",
            overlayClassName,
          )}
        />
        )}
        <Dialog.Content
          className={cn(
            "fixed inset-0 z-[501] flex items-center justify-center pointer-events-none",
            !compact && isMobile && "w-full h-full rounded-none",
            compact && "p-4",
          )}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          {/* For hideOverlay callers (the confirm-style modals stacked on top of
              other modals), render the backdrop blur INSIDE Dialog.Content's
              z-[501] stacking context instead of as a separate z-[500] overlay.
              A separate z-500 overlay would be hidden behind a parent modal's
              z-501 content; this in-content layer paints above the parent AND
              (being the first positioned child) stays behind the panel below. */}
          {hideOverlay && (
            <div aria-hidden className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
          )}
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          <div className={cn(
            "relative pointer-events-auto",
            compact && "max-w-sm",
            // On mobile fullscreen (non-compact), stretch the wrapper to fill
            // Dialog.Content so children using `h-full` resolve against the
            // viewport instead of collapsing to content height (which broke
            // inner `overflow-y-auto` scrolling). Centering is preserved so
            // small fixed-size panels (e.g. MobileAccessModal) still center.
            !compact && isMobile && "flex h-full w-full items-center justify-center",
          )}>{children}</div>
            {/* Portal anchor for nested Radix components (Select, Popover).
                It must be inside Dialog.Content for Radix focus trapping, but Dialog.Content
                must not use CSS transforms or fixed dropdown coordinates become wrong. */}
            <div
              id="modal-portal"
              style={{ position: "fixed", top: 0, left: 0, width: 0, height: 0, overflow: "visible", pointerEvents: "auto" }}
            />
          </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
