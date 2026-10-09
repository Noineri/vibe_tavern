import type { ReactNode } from "react";
import { cn } from "../../../../lib/cn.js";

/**
 * The copilot shell's leaf tab/toolbar buttons — an SS-7B2 extraction-only
 * move out of ExperienceCopilotShell.tsx (SCRIPT_SAFETY_PLAN): code, comments,
 * and behavior preserved verbatim so the shell's later guard wiring has honest
 * ratchet headroom without touching the button markup.
 */

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  /** E6: pending-attention dot (co-author Doc-tab primitive, CA-14). */
  badge?: boolean;
  /** E6: one-shot pulse on the clean→dirty edge (`coauthor-tab-pulse`). */
  pulse?: boolean;
}

export function TabButton({ label, active, onClick, badge = false, pulse = false }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 items-center justify-center gap-1.5 py-2.5 font-ui text-[0.9rem] font-medium transition-colors",
        active ? "border-b-2 border-accent text-t1" : "border-b-2 border-transparent text-t3",
        pulse && "coauthor-tab-pulse",
      )}
    >
      {label}
      {badge && <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
    </button>
  );
}

interface ToolbarButtonProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
}

export function ToolbarButton({ label, icon, onClick, testId }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 py-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
