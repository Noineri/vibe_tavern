import React, { useEffect, useState } from "react";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useChatNotifications } from "../../../stores/index.js";

interface MemBadgeProps {
  label: string;
  onClick: () => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Memory badge — pill in the top bar (play + coauthor surfaces).
// W7: pulses when an auto-summary `summary.generated` notification lands. The
// pulse is driven by the chat-notifications store's monotonic `seq` (so two
// pulses in a row each re-trigger the animation) and clears on click or after
// a timeout. Click still opens the ContextMemory modal (caller's onClick).
// ────────────────────────────────────────────────────────────────────────────

const PULSE_MS = 2400;

export function MemBadge({ label, onClick }: MemBadgeProps) {
  const pulseSeq = useChatNotifications((s) => s.pulse?.seq ?? 0);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (pulseSeq === 0) return; // initial store value — nothing to animate
    setPulsing(true);
    const timer = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(timer);
  }, [pulseSeq]);

  const handleClick = () => {
    setPulsing(false);
    onClick();
  };

  const pulseLabel = pulsing ? `${label} — new` : label;

  return (
    <CustomTooltip content={label}>
      <div
        className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[calc(var(--ui-fs)-3px)] transition-colors duration-150 ${
          pulsing
            ? "mem-badge-pulse border-accent bg-accent-s text-accent-t"
            : "border-border bg-s2 text-t2 hover:border-accent hover:text-accent-t"
        }`}
        onClick={handleClick}
        role="status"
        aria-live="polite"
        aria-label={pulseLabel}
      >
        <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${pulsing ? "bg-accent" : "bg-success"}`} />
        <span>{label}</span>
      </div>
    </CustomTooltip>
  );
}
