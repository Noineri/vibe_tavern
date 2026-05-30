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
}

export function Modal({ open, onClose, children, overlayClassName, compact, hideOverlay }: ModalProps) {
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
            "fixed z-[501]",
            !compact && isMobile
              ? "inset-0 w-full h-full rounded-none flex items-center justify-center"
              : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
            compact && "max-w-sm left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
          )}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          {children}
            {/* Portal anchor for nested Radix components (Select, Popover).
                Positioned as a zero-size fixed element inside Dialog.Content.
                Select.Portal uses this as container to stay within focus trap. */}
            <div
              id="modal-portal"
              style={{ position: "fixed", top: 0, left: 0, width: 0, height: 0 }}
            />
          </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
