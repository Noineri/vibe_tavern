import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { CustomTooltip } from "../../shared/Tooltip.js";

/**
 * The single home of the side panes' toggle affordance (SIDECHAT_PLAN, Wave 4
 * / SC-14 desktop; SC-16c extends it to the script/mini-app assistant panes),
 * so the markup is shared through this component, never copied. SC-16f
 * removed the mobile `touch` variant — the compact top bar's sidechat button
 * is the mobile entry now (the edge handle covered message text edge to edge).
 *
 * Two looks (owner ruling 2026-10-23: the old 24 x 44 tab read square and sat
 * on top of message text):
 * - CLOSED pane → a capsule (14 x 48, fully rounded) at half opacity, full on
 *   hover or keyboard focus. It is the only way to open the pane on desktop,
 *   so it stays visible at rest.
 * - OPEN pane → a thin line (4 x 36) hugging the pane edge that grows into
 *   the same capsule, chevron included, while the pointer is anywhere over
 *   the pane (the pane carries `group/edge-pane`) or the button has keyboard
 *   focus. The open pane's content clip frame would cut anything outside its
 *   edge, so both looks stay inside it.
 * Every button keeps a 24 x 48 hit area around the narrower visual.
 *
 * Variants:
 * - `desktop`: the closed sidechat — capsule riding the chat column's right
 *   edge inside a zero-width flex sibling (reserving no layout space).
 *   Rendered by `SidechatPanel` as the pane's `closedView`.
 * - `panel-close`: the open sidechat — line on the panel's left edge, chevron
 *   `r` (towards the closing direction). Rendered by `SidechatPanel`.
 * - `pane-collapse` (SC-16c): the open assistant pane — line on the pane's
 *   right edge, chevron `l`. Rendered by the desktop two-pane layout above
 *   the drag line.
 * - `editor-tab` (SC-16c): the collapsed assistant pane — capsule on the
 *   editor's left edge, chevron `r`; absolutely overlays the editor (never
 *   shifts it).
 *
 * Test ids: `sidechat-closed` + `sidechat-toggle` (desktop), `sidechat-toggle`
 * (panel-close), `assistant-collapse` / `assistant-closed` + `assistant-toggle`
 * (SC-16c). Only one handle per pane is ever rendered (line while open,
 * capsule while closed), so a shared toggle test id never collides in one tree.
 */
type SidechatHandleProps =
  | {
      /** Tooltip + accessible name (the shared `sidechat_toggle_label`). */
      label: string;
      /** Opens the sidechat. */
      onOpen: () => void;
      /** `desktop` (SC-14 flex sibling, closed sidechat). */
      variant: "desktop";
    }
  | {
      /** Tooltip + accessible name. */
      label: string;
      /** Closes the sidechat (`panel-close`), collapses the open assistant
       *  pane (`pane-collapse`) or expands it (`editor-tab`). */
      onToggle: () => void;
      variant: "panel-close" | "pane-collapse" | "editor-tab";
    };

/** Parent pane hook: the open-pane line reveals while the pointer is over it. */
export const EDGE_PANE_GROUP = "group/edge-pane";

const CAPSULE_BUTTON =
  "group/handle flex h-12 w-6 cursor-pointer items-center opacity-50 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100";
const CAPSULE =
  "flex h-12 w-3.5 items-center justify-center rounded-full border border-border bg-surface text-t3 transition-colors group-hover/handle:bg-s2 group-hover/handle:text-t1";
const LINE_BUTTON = "group/handle flex h-12 w-6 cursor-pointer items-center";
const LINE =
  "flex h-9 w-1 items-center justify-center overflow-hidden rounded-full bg-border2 text-t3 transition-all duration-150 group-hover/handle:text-t1 group-hover/edge-pane:h-12 group-hover/edge-pane:w-3.5 group-hover/edge-pane:border group-hover/edge-pane:border-border group-hover/edge-pane:bg-surface group-focus-visible/handle:h-12 group-focus-visible/handle:w-3.5 group-focus-visible/handle:border group-focus-visible/handle:border-border group-focus-visible/handle:bg-surface";
const LINE_CARET =
  "flex opacity-0 transition-opacity duration-150 group-hover/edge-pane:opacity-100 group-focus-visible/handle:opacity-100";

function EdgeButton({
  label,
  onPress,
  look,
  side,
  caret,
  testId,
  tooltipSide,
}: {
  label: string;
  onPress: () => void;
  look: "capsule" | "line";
  /** Which pane edge the visual hugs. */
  side: "left" | "right";
  caret: "l" | "r";
  testId: string;
  tooltipSide: "left" | "right";
}) {
  const align = side === "left" ? "justify-start pl-0.5" : "justify-end pr-0.5";
  return (
    <CustomTooltip content={label} side={tooltipSide}>
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        onClick={onPress}
        className={cn(look === "capsule" ? CAPSULE_BUTTON : LINE_BUTTON, align)}
      >
        {look === "capsule" ? (
          <span className={CAPSULE}>
            <Icons.Caret direction={caret} />
          </span>
        ) : (
          <span className={LINE}>
            <span className={LINE_CARET}>
              <Icons.Caret direction={caret} />
            </span>
          </span>
        )}
      </button>
    </CustomTooltip>
  );
}

export function SidechatHandle(props: SidechatHandleProps) {
  const { label, variant } = props;
  const onPress = "onOpen" in props ? props.onOpen : props.onToggle;
  if (variant === "panel-close") {
    return (
      <div className="absolute top-1/2 left-0 z-10 -translate-y-1/2">
        <EdgeButton label={label} onPress={onPress} look="line" side="left" caret="r" testId="sidechat-toggle" tooltipSide="left" />
      </div>
    );
  }
  if (variant === "pane-collapse") {
    return (
      <div className="absolute top-1/2 right-0 z-10 -translate-y-1/2" data-testid="assistant-collapse">
        <EdgeButton label={label} onPress={onPress} look="line" side="right" caret="l" testId="assistant-toggle" tooltipSide="right" />
      </div>
    );
  }
  if (variant === "editor-tab") {
    return (
      <div className="absolute top-1/2 left-0 z-20 -translate-y-1/2" data-testid="assistant-closed">
        <EdgeButton label={label} onPress={onPress} look="capsule" side="left" caret="r" testId="assistant-toggle" tooltipSide="right" />
      </div>
    );
  }
  return (
    <div className="relative w-0 shrink-0" data-testid="sidechat-closed">
      <div className="absolute top-1/2 right-0 -translate-y-1/2">
        <EdgeButton label={label} onPress={onPress} look="capsule" side="right" caret="l" testId="sidechat-toggle" tooltipSide="left" />
      </div>
    </div>
  );
}
