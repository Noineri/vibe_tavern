import { Icons } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

/**
 * The sidechat's closed-state handle (SIDECHAT_PLAN, Wave 4 / SC-14 desktop,
 * SC-15 mobile) — the single home of the toggle affordance, so the desktop
 * panel and the mobile tab surface never fork it. SC-16c extends the same
 * home to the script/mini-app assistant panes (the chevron + tab below),
 * so the markup is cloned through this component, never copied.
 *
 * - `desktop`: SC-14's verbatim closed tab — 24 px wide, 44 px tall, riding
 *   the chat column's right edge inside a zero-width flex sibling (reserving
 *   no layout space). Rendered by `SidechatPanel` while closed.
 * - `touch`: SC-15's mobile handle — the same chevron + tooltip affordance at
 *   a 44 × 44 px touch target, absolutely overlaid on the chat's right edge
 *   (the mobile surface has no side column to dock a flex sibling to).
 *   Rendered by the `PlayMode` mobile branch while closed; tapping it opens
 *   the sidechat AND switches the mobile tab to «Sidechat».
 * - `pane-collapse` (SC-16c): the OPEN assistant pane's collapse chevron —
 *   the mirror of `SidechatPanel`'s close button (right edge instead of
 *   left: `right-0`, `rounded-l-md`, `border-r-0`, the `-4px` shadow),
 *   `Icons.Caret direction="l"` (into the pane). Rendered by the
 *   desktop two-pane layout on the pane's right edge, above the drag line.
 * - `editor-tab` (SC-16c): the COLLAPSED assistant pane's expand tab — the
 *   mirror of the `desktop` closed tab (editor's left edge instead of the
 *   chat's right edge: `left-0`, `rounded-r-md`, `border-l-0`, the `+4px`
 *   shadow), `Icons.Caret direction="r"`. Absolutely overlays the
 *   editor's left edge (never shifts it), 44 px tall like every handle here.
 *
 * The `desktop`/`touch` variants share the chevron direction (points at the
 * closed panel), the tooltip/aria label, and the `sidechat-closed` /
 * `sidechat-toggle` testids — the open state lives under the same persisted
 * key on both. The SC-16c variants share their own tooltip/aria label (the
 * `agent_assistant_toggle_label`, «Помощник» both ways) and their own
 * `assistant-collapse` / `assistant-closed` + `assistant-toggle` testids —
 * only one is ever rendered per pane (chevron while open, tab while
 * collapsed), so the shared toggle testid never collides in one tree.
 */
type SidechatHandleProps =
  | {
      /** Tooltip + accessible name (the shared `sidechat_toggle_label`). */
      label: string;
      /** Opens the sidechat (the caller also switches the mobile tab). */
      onOpen: () => void;
      /** `desktop` (SC-14 flex sibling) or `touch` (SC-15 absolute overlay). */
      variant: "desktop" | "touch";
    }
  | {
      /** Tooltip + accessible name (the shared `agent_assistant_toggle_label`). */
      label: string;
      /** Collapses the open pane (`pane-collapse`) or expands it (`editor-tab`). */
      onToggle: () => void;
      /** `pane-collapse` (open-pane chevron) or `editor-tab` (collapsed tab). */
      variant: "pane-collapse" | "editor-tab";
    };

export function SidechatHandle(props: SidechatHandleProps) {
  const { label, variant } = props;
  const onPress = "onOpen" in props ? props.onOpen : props.onToggle;
  if (variant === "pane-collapse") {
    return (
      <div className="absolute top-1/2 right-0 z-10 -translate-y-1/2" data-testid="assistant-collapse">
        <CustomTooltip content={label} side="right">
          <button
            type="button"
            aria-label={label}
            data-testid="assistant-toggle"
            onClick={onPress}
            className="flex h-11 w-6 cursor-pointer items-center justify-center rounded-l-md border border-r-0 border-border bg-surface text-t3 shadow-[-4px_0_12px_rgba(0,0,0,.25)] transition-colors hover:bg-s2 hover:text-t1"
          >
            <Icons.Caret direction="l" />
          </button>
        </CustomTooltip>
      </div>
    );
  }
  if (variant === "editor-tab") {
    return (
      <div className="absolute top-1/2 left-0 z-20 -translate-y-1/2" data-testid="assistant-closed">
        <CustomTooltip content={label} side="right">
          <button
            type="button"
            aria-label={label}
            data-testid="assistant-toggle"
            onClick={onPress}
            className="flex h-11 w-6 cursor-pointer items-center justify-center rounded-r-md border border-l-0 border-border bg-surface text-t3 shadow-[4px_0_12px_rgba(0,0,0,.25)] transition-colors hover:bg-s2 hover:text-t1"
          >
            <Icons.Caret direction="r" />
          </button>
        </CustomTooltip>
      </div>
    );
  }
  if (variant === "touch") {
    return (
      <div className="absolute top-1/2 right-0 z-20 -translate-y-1/2" data-testid="sidechat-closed">
        <CustomTooltip content={label} side="left">
          <button
            type="button"
            aria-label={label}
            data-testid="sidechat-toggle"
            onClick={onPress}
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
          onClick={onPress}
          className="absolute top-1/2 right-0 flex h-11 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-l-md border border-r-0 border-border bg-surface text-t3 shadow-[-4px_0_12px_rgba(0,0,0,.25)] transition-colors hover:bg-s2 hover:text-t1"
        >
          <Icons.Caret direction="l" />
        </button>
      </CustomTooltip>
    </div>
  );
}
