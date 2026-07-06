import * as ToggleGroup from "@radix-ui/react-toggle-group";
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
 *
 * Built on `@radix-ui/react-toggle-group` (`type="multiple"`): Radix provides
 * `aria-pressed` on each chip, roving tabindex (one Tab stop for the whole
 * group instead of one per chip), and arrow-key navigation. The chip styling
 * is driven by Radix's `data-[state=on]:` variant.
 *
 * Sole consumer: LoreEntryEditor character-filter picker.
 */
export function ToggleChips({
  selected,
  options,
  onChange,
  className,
  disabled,
}: ToggleChipsProps) {
  return (
    <ToggleGroup.Root
      type="multiple"
      value={selected}
      onValueChange={(next) => onChange(next)}
      disabled={disabled}
      className={cn("flex flex-wrap gap-1.5 data-[disabled]:opacity-40", className)}
      rovingFocus
    >
      {options.map((opt) => (
        <ToggleGroup.Item
          key={opt.value}
          value={opt.value}
          className={cn(
            "cursor-pointer rounded-full border font-ui transition-all duration-150 select-none",
            "px-3 py-1 text-[12px]",
            "border-border bg-s3 text-t2 hover:border-t3 hover:text-t1",
            "data-[state=on]:border-accent data-[state=on]:bg-accent/15 data-[state=on]:text-accent-t data-[state=on]:font-medium",
          )}
        >
          {opt.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
