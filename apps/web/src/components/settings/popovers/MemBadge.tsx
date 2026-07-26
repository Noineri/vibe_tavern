import { useEffect } from "react";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Icons } from "../../shared/icons.js";
import { useChatNotifications } from "../../../stores/index.js";

interface MemBadgeProps {
  label: string;
  onClick: () => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Memory badge — pill in the top bar (play + coauthor surfaces).
// W7: mirrors the auto-summary lifecycle as a three-state indicator next to the
// label — green dot (idle) → spinner (generating) → checkmark (ready, auto-
// reverts to idle after 2 s). A failure skips the checkmark and returns to idle
// straight away (the toast carries the error message). Click still opens the
// ContextMemory modal (caller's onClick) and dismisses the ready state.
// ────────────────────────────────────────────────────────────────────────────

const READY_MS = 2000;

export function MemBadge({ label, onClick }: MemBadgeProps) {
  const status = useChatNotifications((s) => s.status);
  const readySeq = useChatNotifications((s) => s.ready?.seq ?? 0);
  const setIdle = useChatNotifications((s) => s.setIdle);

  // Auto-revert the checkmark back to the idle dot after a short beat. Keyed on
  // `readySeq` so two summaries in quick succession each get their own window.
  useEffect(() => {
    if (readySeq === 0) return;
    const timer = setTimeout(() => setIdle(), READY_MS);
    return () => clearTimeout(timer);
  }, [readySeq, setIdle]);

  const handleClick = () => {
    setIdle();
    onClick();
  };

  return (
    <CustomTooltip content={label}>
      <div
        className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-s2 px-3 py-1 text-[calc(var(--ui-fs)-3px)] text-t2 transition-colors duration-150 hover:border-accent hover:text-accent-t"
        onClick={handleClick}
        role="status"
        aria-live="polite"
        aria-label={label}
      >
        {status === "generating" && (
          <span
            className="block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-t3 border-t-transparent"
            aria-hidden="true"
          />
        )}
        {status === "ready" && (
          <span className="flex shrink-0 items-center text-success" aria-hidden="true">
            <Icons.checkCircle />
          </span>
        )}
        {status === "idle" && <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />}
        <span>{label}</span>
      </div>
    </CustomTooltip>
  );
}
