import { Icons } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

/**
 * The sidechat's closed-state handle (SIDECHAT_PLAN, Wave 4 / SC-14 desktop,
 * SC-15 mobile) — the single home of the toggle affordance, so the desktop
 * panel and the mobile tab surface never fork it.
 *
 * - `desktop`: SC-14's verbatim closed tab — 24 px wide, 44 px tall, riding
 *   the chat column's right edge inside a zero-width flex sibling (reserving
 *   no layout space). Rendered by `SidechatPanel` while closed.
 * - `touch`: SC-15's mobile handle — the same chevron + tooltip affordance at
 *   a 44 × 44 px touch target, absolutely overlaid on the chat's right edge
 *   (the mobile surface has no side column to dock a flex sibling to).
 *   Rendered by the `PlayMode` mobile branch while closed; tapping it opens
 *   the sidechat AND switches the mobile tab to «Sidechat».
 *
 * Both variants share the chevron direction (points at the closed panel),
 * the tooltip/aria label, and the `sidechat-closed` / `sidechat-toggle`
 * testids — the open state lives under the same persisted key on both.
 */
export function SidechatHandle({
  label,
  onOpen,
  variant,
}: {
  /** Tooltip + accessible name (the shared `sidechat_toggle_label`). */
  label: string;
  /** Opens the sidechat (the caller also switches the mobile tab). */
  onOpen: () => void;
  /** `desktop` (SC-14 flex sibling) or `touch` (SC-15 absolute overlay). */
  variant: "desktop" | "touch";
}) {
  if (variant === "touch") {
    return (
      <div className="absolute top-1/2 right-0 z-20 -translate-y-1/2" data-testid="sidechat-closed">
        <CustomTooltip content={label} side="left">
          <button
            type="button"
            aria-label={label}
            data-testid="sidechat-toggle"
            onClick={onOpen}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-l-md border border-r-0 border-border bg-surface text-t3 shadow-[-4px_0_12px_rgba(0,0,0,.25)] transition-colors hover:bg-s2 hover:text-t1"
          >
            <Icons.Caret direction="l" />
          </button>
        </CustomTooltip>
      </div>
    );
  }
  return (
    <div className="relative w-0 shrink-0" data-testid="sidechat-closed">
      <CustomTooltip content={label} side="left">
        <button
          type="button"
          aria-label={label}
          data-testid="sidechat-toggle"
          onClick={onOpen}
          className="absolute top-1/2 right-0 flex h-11 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-l-md border border-r-0 border-border bg-surface text-t3 shadow-[-4px_0_12px_rgba(0,0,0,.25)] transition-colors hover:bg-s2 hover:text-t1"
        >
          <Icons.Caret direction="l" />
        </button>
      </CustomTooltip>
    </div>
  );
}
