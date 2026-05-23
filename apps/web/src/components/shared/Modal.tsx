import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../lib/cn.js";

export interface ModalProps {
  /** Controls open state */
  open: boolean;
  /** Called when user requests close (Escape, overlay click) */
  onClose: () => void;
  /** Modal content — the caller provides the styled inner panel */
  children: ReactNode;
  /** Optional extra class on overlay div */
  overlayClassName?: string;
}

/**
 * Returns the nearest modal portal container element.
 * DropdownSelect calls this to portal its content inside the Dialog's focus scope,
 * so keyboard navigation (arrow keys) works inside modals.
 */
export function getModalPortal(): HTMLElement | null {
  return document.getElementById("modal-portal");
}

/**
 * Shared Modal wrapper using Radix Dialog primitives.
 *
 * Provides: focus trap, scroll lock, Escape-to-close, overlay click dismiss.
 * Visual: same `bg-black/55 backdrop-blur-[2px]` overlay, centered content.
 */
export function Modal({ open, onClose, children, overlayClassName }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]",
            overlayClassName,
          )}
        >
          <Dialog.Content
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
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
