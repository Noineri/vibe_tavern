import { Fragment, type ReactNode } from 'react';
import * as RadioGroup from "@radix-ui/react-radio-group";
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "./Tooltip.js";

interface SegmentedOption {
  value: string;
  label: ReactNode;
  /** Disable only this option while leaving the rest of the group interactive. */
  disabled?: boolean;
  /** Optional tooltip shown on hover/focus over this segment. */
  tooltip?: ReactNode;
  /** Optional trailing action node rendered after the segment (e.g. inline
   *  rename/delete icons on a version pill). When present, the segment and its
   *  trailing node are wrapped in a `group/seg` hover scope so the caller can
   *  reveal the trailing content on hover via `group-hover/seg:opacity-100`.
   *  Opt-in — no effect on existing call sites. The trailing node sits outside
   *  the radio <button> (nested buttons are invalid HTML), so click events on
   *  it do not toggle the segment. */
  trailing?: ReactNode;
}

interface SegmentedControlProps {
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  /** Render as a more compact variant for tight spaces */
  compact?: boolean;
  /** Even shorter on mobile than `compact` (28px vs 36px touch height), with
   *  identical desktop sizing. Narrowly scoped: intended only for in-card
   *  controls like the canvas role selector, where `compact` is too tall on a
   *  phone. Does not affect other callers (opt-in, defaults off). */
  dense?: boolean;
  /** Stretch full width with equal segment sizing */
  fill?: boolean;
  /** Stretch full width only on mobile; desktop keeps natural inline sizing */
  mobileFill?: boolean;
  /** Allow segments to wrap to multiple rows when they exceed the container width.
   *  Off by default (single inline row) to preserve the existing look of the
   *  11 current call sites; opt in for option sets that grow (e.g. version
   *  switcher). Wrapped segments still share one bordered container. */
  wrap?: boolean;
}

/**
 * Segmented radio control — replaces native <select> for small option sets (2-5 items).
 * All options visible, one click to select.
 *
 * Built on `@radix-ui/react-radio-group`: Radix provides the full radio-group
 * WAI-ARIA pattern — `role="radiogroup"`/`role="radio"`, `aria-checked`,
 * roving tabindex, and arrow-key movement between segments (the previous
 * hand-rolled implementation declared the right roles but never wired the
 * keyboard model those roles imply — Tab visited every segment, arrows were
 * dead). The radio invariant (a value is always selected, clicking the active
 * segment does not clear it) matches RadioGroup exactly.
 *
 * `tooltip` wraps the segment in `CustomTooltip`; `trailing` renders as a
 * SIBLING of the radio button (not inside it — nested buttons are invalid
 * HTML), inside a `group/seg` hover scope so callers can reveal the trailing
 * content via `group-hover/seg`. Both survive the `RadioGroup.Item` swap
 * unchanged. See toggle-segmented-radix-migration.md.
 */
export function SegmentedControl({
  value,
  options,
  onChange,
  className,
  disabled,
  compact,
  dense,
  fill,
  mobileFill,
  wrap,
}: SegmentedControlProps) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      asChild
    >
      <div
        className={cn(
          "rounded-md border border-border bg-s3 p-0.5",
          fill ? "flex w-full" : mobileFill ? "flex w-full sm:inline-flex sm:w-auto" : "inline-flex",
          wrap && "flex-wrap",
          (dense || compact) ? "gap-0" : "gap-0.5",
          disabled && "pointer-events-none opacity-40",
          className,
        )}
      >
        {options.map((opt) => {
          // The fill/mobileFill flex classes belong on the element that is the
          // flex child of the row. With a tooltip the trigger span is that
          // child; without it the radio item is. (Only matters for fill/
          // mobileFill; the compact logic control — the only tooltip call site
          // today — is unaffected.)
          const flexCls = (fill || mobileFill)
            ? "flex min-w-0 flex-1 items-center justify-center truncate sm:flex-none"
            : "";
          const item = (
            <RadioGroup.Item
              value={opt.value}
              disabled={disabled || opt.disabled}
              className={cn(
                // Only the properties that actually change — `transition-all` watches
                // every property and causes unexpected color/padding transitions.
                "cursor-pointer rounded-[5px] font-ui transition-[background-color,color,box-shadow,transform] duration-150 ease-out select-none active:scale-[0.96]",
                opt.tooltip ? "w-full" : flexCls,
                dense ? "min-h-7 px-2.5 py-1 text-[11px] sm:min-h-0" : compact ? "min-h-9 px-2.5 py-1 text-[11px] sm:min-h-0" : "min-h-10 px-3 py-1.5 text-[13px] sm:min-h-0",
                "text-t2 hover:text-t1",
                "data-[state=checked]:bg-s2 data-[state=checked]:text-accent data-[state=checked]:shadow-sm data-[state=checked]:font-medium",
                opt.disabled && "cursor-not-allowed opacity-40",
              )}
            >
              <span className="min-w-0 truncate sm:overflow-visible sm:whitespace-normal sm:text-clip">{opt.label}</span>
            </RadioGroup.Item>
          );
          // CustomTooltip's Trigger (asChild) injects its own `data-state` onto
          // its child. If that child were the RadioGroup.Item it would CLOBBER
          // the radio's `data-state=checked` (the visual-selection hook) with the
          // tooltip's open/closed state — the selected segment would lose its
          // highlight. Wrap the item in a span so each Radix primitive owns its
          // own DOM node (span = tooltip trigger; button = radio).
          const segment = opt.tooltip ? (
            <CustomTooltip content={opt.tooltip} align="start">
              <span className={cn("inline-flex", flexCls)}>{item}</span>
            </CustomTooltip>
          ) : item;
          // Wrap in a hover scope when trailing actions are present so the caller
          // can reveal them via group-hover/seg. Otherwise render bare (preserves
          // the existing look of all current call sites).
          if (opt.trailing) {
            return (
              <div key={opt.value} className="group/seg flex items-center">
                {segment}
                {opt.trailing}
              </div>
            );
          }
          return <Fragment key={opt.value}>{segment}</Fragment>;
        })}
      </div>
    </RadioGroup.Root>
  );
}
