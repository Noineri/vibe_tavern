import { cn } from "../../lib/cn.js";

interface ChipOption {
  value: string;
  label: string;
}

interface ToggleChipsProps {
  selected: string[];
  options: ChipOption[];
  onChange: (selected: string[]) => void;
  className?: string;
  disabled?: boolean;
}

/**
 * Multi-select chip group — replaces rows of checkboxes for trigger/source lists.
 * Clicking a chip toggles it. Selected chips use accent styling.
 */
export function ToggleChips({
  selected,
  options,
  onChange,
  className,
  disabled,
}: ToggleChipsProps) {
  const toggle = (value: string) => {
    if (disabled) return;
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next);
  };

  return (
    <div className={cn("flex flex-wrap gap-1.5", disabled && "opacity-40", className)}>
      {options.map((opt) => {
        const active = selected.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => toggle(opt.value)}
            className={cn(
              "cursor-pointer rounded-full border font-ui transition-all duration-150 select-none",
              "px-3 py-1 text-[12px]",
              active
                ? "border-accent bg-accent/15 text-accent-t font-medium"
                : "border-border bg-s3 text-t2 hover:border-t3 hover:text-t1",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
