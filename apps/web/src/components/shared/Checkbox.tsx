import { cn } from "../../lib/cn.js";

interface CheckboxProps {
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
 */
export function Checkbox({ checked, onChange, disabled, id, className, label }: CheckboxProps) {
  const chip = (
    <span
      className={cn(
        "relative flex h-[18px] min-w-[18px] items-center justify-center rounded-full border transition-all duration-150",
        checked
          ? "border-accent bg-accent/15"
          : "border-border bg-s3",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <svg
        viewBox="0 0 12 12"
        fill="none"
        className={cn(
          "h-2.5 w-2.5 transition-all duration-150",
          checked ? "text-accent scale-100" : "text-transparent scale-75",
        )}
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
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        id={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("cursor-pointer", className)}
      >
        {chip}
      </button>
    );
  }

  return (
    <div
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onKeyDown={e => { if (!disabled && (e.key === " " || e.key === "Enter")) { e.preventDefault(); onChange(!checked); } }}
      className={cn(
        "flex cursor-pointer items-center gap-2 select-none transition-colors",
        disabled ? "opacity-40 pointer-events-none" : "text-t2 hover:text-t1",
        className,
      )}
      onClick={() => { if (!disabled) onChange(!checked); }}
    >
      {chip}
      {typeof label === "string" ? (
        <span className="text-[13px]">{label}</span>
      ) : (
        label
      )}
    </div>
  );
}
