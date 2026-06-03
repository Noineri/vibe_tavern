import { type ReactNode } from 'react';
import { cn } from "../../lib/cn.js";

interface SegmentedOption {
  value: string;
  label: ReactNode;
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
}: SegmentedControlProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-s3 p-0.5",
        fill ? "flex w-full" : "inline-flex",
        compact ? "gap-0" : "gap-0.5",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
      role="radiogroup"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "cursor-pointer rounded-[5px] font-ui transition-all duration-150 select-none",
              fill && "flex min-w-0 flex-1 items-center justify-center",
              compact ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-[13px]",
              active
                ? "bg-s2 text-accent shadow-sm font-medium"
                : "text-t2 hover:text-t1",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
