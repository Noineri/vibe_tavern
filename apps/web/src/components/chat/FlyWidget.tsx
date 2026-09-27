import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import {
  selectFlyDisplayState,
  selectFlyGateProgress,
  type FlyDisplayState,
  useFlyTribunalStore,
} from "../../stores/fly-tribunal-store.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { FlyVerdictPanel } from "./FlyVerdictPanel.js";

/** Animation windows are deliberately shorter than a user action; transient
 * state is only visual feedback and never represents persistent verdict data. */
const TRANSIENT_DURATION_MS: Partial<Record<FlyDisplayState, number>> = {
  "notes-a-precedent": 600,
  alert: 800,
  verdict: 900,
  escapes: 600,
  sleeps: 1200,
};

/** CSS-only emoji states — custom fly motion is the feature; panel/button
 * chrome remains shared Popover/BottomSheet canon. */
const FLY_STATE_CLASS: Record<FlyDisplayState, string> = {
  silent: "opacity-65 saturate-50",
  active: "text-t2 motion-safe:hover:-translate-y-px",
  "notes-a-precedent": "animate-bounce [animation-duration:600ms] [animation-iteration-count:1] text-accent-t",
  alert: "animate-pulse [animation-duration:800ms] [animation-iteration-count:1] text-warning-text",
  verdict: "animate-pulse [animation-duration:900ms] [animation-iteration-count:1] text-accent-t",
  escapes: "animate-[spin_600ms_ease-in_1] text-warning-text",
  sleeps: "translate-y-1 animate-pulse [animation-duration:1200ms] [animation-iteration-count:1] opacity-45 grayscale",
};

export interface FlyWidgetProps {
  /** Compact controls fit beside the mobile composer/send control. */
  compact?: boolean;
}

/**
 * Fly Tribunal launcher (FT-10): emoji + precedent counter beside the chat
 * composer. Its shared panel body is a desktop Popover and a mobile
 * BottomSheet — the DicePanel/ImageGenFineTuningChip responsive-overlay canon.
 */
export function FlyWidget({ compact = false }: FlyWidgetProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const courtState = useFlyTribunalStore((state) => state.courtState);
  const transientState = useFlyTribunalStore((state) => state.transientState);
  const precedentCount = useFlyTribunalStore((state) => state.precedentCount);
  const lastPrecedentAt = useFlyTribunalStore((state) => state.lastPrecedentAt);
  const clearTransientState = useFlyTribunalStore((state) => state.clearTransientState);
  const displayState = selectFlyDisplayState({ courtState, transientState });
  const gate = selectFlyGateProgress({ precedentCount });

  useEffect(() => {
    const duration = TRANSIENT_DURATION_MS[displayState];
    if (duration === undefined) return undefined;
    const timeout = window.setTimeout(clearTransientState, duration);
    return () => window.clearTimeout(timeout);
  }, [clearTransientState, displayState, lastPrecedentAt]);

  const counter = gate.unlocked ? String(gate.current) : `${gate.current}/${gate.gate}`;
  const panel = <FlyVerdictPanel />;
  const clearAfterAnimation = (): void => {
    if (TRANSIENT_DURATION_MS[displayState] !== undefined) clearTransientState();
  };
  const trigger = (
    <button
      type="button"
      aria-label={t("fly_tribunal_widget_label")}
      aria-expanded={open}
      data-testid="fly-tribunal-widget"
      data-fly-state={displayState}
      onAnimationEnd={clearAfterAnimation}
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-full border border-border2 bg-s3 font-ui shadow-sm transition-[transform,opacity,filter,color,background-color] duration-300 hover:bg-s2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        compact ? "h-8 w-8" : "h-9 w-9",
        FLY_STATE_CLASS[displayState],
      )}
    >
      <span aria-hidden className={cn("leading-none", compact ? "text-[18px]" : "text-[20px]")}>🪰</span>
      <span
        aria-hidden
        data-testid="fly-tribunal-counter"
        className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full border border-surface bg-accent px-1 text-center font-ui text-[calc(var(--ui-fs)-4px)] leading-4 text-on-accent"
      >
        {counter}
      </span>
    </button>
  );

  return (
    <div className="flex shrink-0 items-center" data-testid="fly-tribunal-widget-row">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        {!isMobile && (
          <Popover.Portal container={getModalPortal() ?? document.body}>
            <Popover.Content
              side="top"
              align="center"
              sideOffset={6}
              className="glass-blur z-[220] w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              {panel}
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
      {open && isMobile && (
        <BottomSheet open={true} onClose={() => setOpen(false)} title={t("fly_tribunal_title")}>
          {panel}
        </BottomSheet>
      )}
    </div>
  );
}
