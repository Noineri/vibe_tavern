import { cn } from "../../../lib/cn.js";
import { Icons } from "../icons.js";
import { CustomTooltip } from "../Tooltip.js";

/**
 * AgentShellTabButton (AS-6b2, moved verbatim from the copilot shell's
 * experience-copilot-buttons.tsx) — one button of the
 * agent shell's mobile chat/edit tab row. Shell chrome, so it lives with
 * the shell; the host-owned toolbar button (`ToolbarButton`) stayed behind in
 * the copilot buttons file.
 *
 * fork #1 of the mobile tab-button family (source: CoauthorMode.tsx's
 * file-private `TabButton`, the CA-14 Doc-tab primitive) — correspondence:
 * identical markup/classes/role; deviations: SC-15 `onClose` + `closeLabel`
 * (the sidechat mobile tab's ×: a sibling button in a wrapper, never nested
 * — a `<button>` cannot hold another; ≥ 44 px hit area, tooltip through
 * `CustomTooltip`). Without `onClose` the rendered markup is byte-identical
 * to the pre-SC-15 output. The co-author original is its own fork #0; if a
 * third consumer appears, surface to the owner and propose unification.
 */
interface AgentShellTabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  /** E6: pending-attention dot (co-author Doc-tab primitive, CA-14). */
  badge?: boolean;
  /** E6: one-shot pulse on the clean→dirty edge (`coauthor-tab-pulse`). */
  pulse?: boolean;
  /**
   * SC-15: optional close affordance. When set, the tab renders inside a
   * wrapper with the × as a SIBLING button (a11y: `closeLabel` is its
   * aria-label + tooltip). Absent: the bare tab, byte-identical to before.
   */
  onClose?: () => void;
  /** Accessible name + tooltip of the × (required with `onClose`). */
  closeLabel?: string;
}

export function AgentShellTabButton({
  label,
  active,
  onClick,
  badge = false,
  pulse = false,
  onClose,
  closeLabel,
}: AgentShellTabButtonProps) {
  const tab = (
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
  if (onClose === undefined) return tab;
  return (
    <div className="flex min-w-0 flex-1">
      {tab}
      <CustomTooltip content={closeLabel ?? ""} side="top">
        <button
          type="button"
          aria-label={closeLabel}
          data-testid="agent-shell-tab-close"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center text-t3 transition-colors hover:text-t1"
        >
          <Icons.close />
        </button>
      </CustomTooltip>
    </div>
  );
}
