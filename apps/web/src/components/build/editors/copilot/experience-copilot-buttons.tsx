import type { ReactNode } from "react";

/**
 * The experience host's leaf toolbar button — an SS-7B2 extraction-only move
 * out of ExperienceCopilotShell.tsx (SCRIPT_SAFETY_PLAN): code, comments,
 * and behavior preserved verbatim so the host's later guard wiring has honest
 * ratchet headroom without touching the button markup. AS-6b2: the mobile
 * tab-row `TabButton` moved out to shared/agent-shell/AgentShellTabButton.tsx
 * (shell chrome); this file keeps the host-owned toolbar button.
 */

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
      className="flex items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
