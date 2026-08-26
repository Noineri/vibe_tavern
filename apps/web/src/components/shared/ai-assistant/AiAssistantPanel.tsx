import type { ReactNode, MouseEvent } from "react";
import { cn } from "../../../lib/cn.js";

export interface AiAssistantPanelProps {
  /** Per-modal layout classes: width/height/radius (e.g. "max-h-[85vh]
   *  w-[600px] max-w-[90vw] rounded-xl"). The shared base (flex column,
   *  overflow hidden, border, glass fill) lives here so every AI-assistant
   *  modal gets it without remembering. */
  className?: string;
  /** Optional click handler for the panel (e.g. stopPropagation parity with
   *  legacy containers). */
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

/**
 * Outer panel container shared by the AI-assistant modals (all
 * AiAssistantShell consumers). Carries the TRANSPARENT-THEME solution:
 * `glass-blur-under` fills the panel with `--glass-bg` + frosts UNDER the
 * content via a z:-1 ::before — on glass/lava themes (where `--surface` is
 * translucent) this keeps the panel readable over the animated background;
 * on opaque themes it is a byte-identical no-op (`--glass-bg == --surface`,
 * blur 0). The underlayer variant (not `glass-blur` on the panel itself)
 * follows the R-8 lesson: a backdrop-filter on the panel element makes it a
 * containing block for position:fixed descendants. Widths, radii, and the
 * mobile bottom-sheet path stay per-modal via `className` — only the surface
 * treatment is owned here.
 */
export function AiAssistantPanel({ className, onClick, children }: AiAssistantPanelProps) {
  return (
    <div className={cn("glass-blur-under flex flex-col overflow-hidden border border-border", className)} onClick={onClick}>
      {children}
    </div>
  );
}
