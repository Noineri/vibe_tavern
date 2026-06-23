import { forwardRef } from "react";
import { cn } from "../../lib/cn.js";

interface CheckboxProps extends Omit<React.HTMLAttributes<HTMLElement>, "onChange" | "checked"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  label?: React.ReactNode;
}

/**
 * Mini-chip checkbox — tiny rounded pill indicator consistent with ToggleChips.
 * Unchecked: subtle s3 pill. Checked: accent border + bg with checkmark.
 *
 * `forwardRef` + spreading `...rest` onto the root element are BOTH required so
 * that a wrapping `<CustomTooltip>` (Radix `Tooltip.Trigger asChild`, which
 * uses Radix `Slot`) can attach its ref AND its hover/focus event handlers
 * (`onPointerEnter`, `onPointerMove`, `onFocus`, …) plus `data-state`. Without
 * spreading `rest`, Radix clones the child with those props but they are
 * silently dropped at the typed-prop boundary, so the hover trigger never
 * fires and the tooltip never shows. `onClick` is merged so both Radix's
 * trigger handler and our toggle handler run.
 */
export const Checkbox = forwardRef<HTMLButtonElement | HTMLDivElement, CheckboxProps>(
  function Checkbox({ checked, onChange, disabled, id, className, label, onClick, ...rest }, ref) {
    const handleClick: React.MouseEventHandler<HTMLElement> = (e) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      if (!disabled) onChange(!checked);
    };

    const chip = (
      <span
        className={cn(
          "relative flex h-[18px] min-w-[18px] items-center justify-center rounded-full border transition-[border-color,background-color] duration-150 ease-out",
          checked
            ? "border-accent bg-accent/15"
            : "border-border bg-s3",
          disabled && "pointer-events-none opacity-40",
        )}
      >
        {/* Checkmark cross-fade: opacity + scale + blur per the contextual
            icon-animation spec (scale 0.25→1, opacity 0→1, blur 4px→0).
            cubic-bezier(0.2,0,0,1) approximates a spring without bounce. */}
        <svg
          viewBox="0 0 12 12"
          fill="none"
          className={cn(
            "h-2.5 w-2.5 transition-[opacity,transform,filter] duration-300 ease-out",
            checked
              ? "text-accent scale-100 opacity-100 blur-0"
              : "text-transparent scale-[0.25] opacity-0 blur-[4px]",
          )}
          style={{ transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)' }}
        >
          <path
            d="M2.5 6L5 8.5L9.5 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );

    if (!label) {
      // Label-less variant: extend the 18px chip to a 40×40 hit area so the
      // tiny checkbox stays easy to tap (min hit area rule). The pseudo-element
      // is invisible and sits behind the chip so it never overlaps siblings.
      return (
        <button type="button"
          ref={ref as React.Ref<HTMLButtonElement>}
          role="checkbox"
          aria-checked={checked}
          id={id}
          disabled={disabled}
          onClick={handleClick}
          {...rest}
          className={cn(
            "relative cursor-pointer flex h-[18px] w-[18px] items-center justify-center",
            "after:absolute after:inset-0 after:-z-10",
            "after:scale-[2.6] after:content-['']",
            className,
          )}
        >
          {chip}
        </button>
      );
    }

    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={e => { if (!disabled && (e.key === " " || e.key === "Enter")) { e.preventDefault(); onChange(!checked); } }}
        onClick={handleClick}
        {...rest}
        className={cn(
          "flex cursor-pointer items-center gap-2 select-none transition-colors",
          disabled ? "opacity-40 pointer-events-none" : "text-t2 hover:text-t1",
          className,
        )}
      >
        {chip}
        {typeof label === "string" ? (
          <span className="text-[13px]">{label}</span>
        ) : (
          label
        )}
      </div>
    );
  },
);
