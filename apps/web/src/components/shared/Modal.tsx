import { createPortal } from "react-dom";
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
 * Shared Modal wrapper using Radix Dialog primitives.
 *
 * Provides: focus trap, scroll lock, Escape-to-close, overlay click dismiss.
 * Visual: same `bg-black/55 backdrop-blur-[2px]` overlay, centered content.
 *
 * Renders a hidden portal container so nested Radix components (Select, Popover)
 * can portal their content inside the Dialog's focus scope.
 */

// Global ref to the current modal portal container.
// Radix Select/Popover can portal into this to stay inside the focus trap.
let modalPortalEl: HTMLDivElement | null = null;

export function getModalPortal(): HTMLDivElement | null {
  return modalPortalEl;
}

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
            {/* Portal container for nested Radix components (Select, Popover).
                Rendered inside Dialog so focus trap includes portaled content. */}
            <div
              ref={(el) => { modalPortalEl = el; }}
              data-modal-portal
              style={{ display: "contents" }}
            />
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
