import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { BottomSheet } from "../shared/BottomSheet.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useGenerationBatchSummary } from "../../stores/generation-queue-store.js";
import { QueueChip } from "./queue-chip.js";
import { QueueTimeline } from "./queue-timeline.js";

/**
 * Pinned queue manager (CHAT_GENERATION_QUEUE_PLAN Q4b).
 *
 * Sits as a sibling above the composer in PlayMode. A batch begins at the first
 * Generate more click; it remains visible after work drains until Send/Resend
 * resets it, provided its target stays in the visible branch.
 *
 * Layout:
 *  - Desktop: a left-aligned pill; expanding opens an UPWARD popover anchored to
 *    the pill (`absolute bottom-full left-0`). The composer never moves.
 *  - Mobile: a left-aligned pill; tapping opens a full-width bottom sheet
 *    (reuses the Rail.tsx z-[501] pattern), so it never fights the keyboard.
 *
 * The ring spins only while a batch record is running; pending work remains
 * still so waiting-only batches do not imply active generation.
 */
export function QueueManager(): ReactNode {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const { visible, summary } = useGenerationBatchSummary(activeChatId);
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);

  // A plain regenerate never creates a batch, while a drained/cleared/cancelled
  // batch stays visible until the next real Send or Resend.
  if (!visible) return null;

  return (
    <div className="absolute bottom-full left-1.5 z-20 mb-1 flex items-center gap-1.5">
      <Popover.Root open={expanded} onOpenChange={setExpanded}>
        <Popover.Trigger asChild>
          <QueueChip summary={summary} mobile={isMobile} />
        </Popover.Trigger>
        {!isMobile && (
          <Popover.Portal container={getModalPortal() ?? undefined}>
            <DesktopPopoverContent onClose={() => setExpanded(false)} />
          </Popover.Portal>
        )}
      </Popover.Root>

      {expanded && isMobile && (
        <MobileSheet onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}

// ── Desktop: upward popover (Radix Popover) ─────────────────────────────

function DesktopPopoverContent({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Popover.Content
      side="top"
      align="start"
      sideOffset={4}
      className="glass-blur z-[220] max-w-[calc(100vw-2rem)] w-80 overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
    >
      <QueueTimeline onClose={onClose} />
    </Popover.Content>
  );
}

// ── Mobile: bottom sheet (reuses Rail.tsx z-[501] pattern) ───────────────

function MobileSheet({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <BottomSheet open={true} onClose={onClose}>
      <QueueTimeline mobile onClose={onClose} />
    </BottomSheet>
  );
}
