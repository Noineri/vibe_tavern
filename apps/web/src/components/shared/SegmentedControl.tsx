import { type ReactNode } from 'react';
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "./Tooltip.js";

interface SegmentedOption {
  value: string;
  label: ReactNode;
  /** Optional tooltip shown on hover/focus over this segment. */
  tooltip?: ReactNode;
}

interface SegmentedControlProps {
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  /** Render as a more compact variant for tight spaces */
  compact?: boolean;
  /** Stretch full width with equal segment sizing */
  fill?: boolean;
  /** Stretch full width only on mobile; desktop keeps natural inline sizing */
  mobileFill?: boolean;
}

/**
 * Segmented radio control — replaces native <select> for small option sets (2-5 items).
 * All options visible, one click to select.
 */
export function SegmentedControl({
  value,
  options,
  onChange,
  className,
  disabled,
  compact,
  fill,
  mobileFill,
}: SegmentedControlProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-s3 p-0.5",
        fill ? "flex w-full" : mobileFill ? "flex w-full sm:inline-flex sm:w-auto" : "inline-flex",
        compact ? "gap-0" : "gap-0.5",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
      role="radiogroup"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const button = (
          <button key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              // Only the properties that actually change — `transition-all` watches
              // every property and causes unexpected color/padding transitions.
              "cursor-pointer rounded-[5px] font-ui transition-[background-color,color,box-shadow,transform] duration-150 ease-out select-none active:scale-[0.96]",
              (fill || mobileFill) && "flex min-w-0 flex-1 items-center justify-center truncate sm:flex-none",
              compact ? "min-h-9 px-2.5 py-1 text-[11px] sm:min-h-0" : "min-h-10 px-3 py-1.5 text-[13px] sm:min-h-0",
              active
                ? "bg-s2 text-accent shadow-sm font-medium"
                : "text-t2 hover:text-t1",
            )}
          >
            <span className="min-w-0 truncate sm:overflow-visible sm:whitespace-normal sm:text-clip">{opt.label}</span>
          </button>
        );
        return opt.tooltip ? (
          <CustomTooltip key={opt.value} content={opt.tooltip} align="start">
            {button}
          </CustomTooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
