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
 * Custom checkbox that blends into dark UI.
 * Unchecked: subtle s3 square. Checked: accent-filled with CSS checkmark.
 */
export function Checkbox({ checked, onChange, disabled, id, className, label }: CheckboxProps) {
  const box = (
    <span
      className={cn(
        "relative flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-all duration-150",
        checked
          ? "border-accent bg-accent"
          : "border-border bg-s3",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {/* CSS checkmark */}
      <svg
        viewBox="0 0 12 12"
        fill="none"
        className={cn(
          "absolute h-2.5 w-2.5 transition-opacity duration-150",
          checked ? "opacity-100" : "opacity-0",
        )}
      >
        <path
          d="M2.5 6L5 8.5L9.5 3.5"
          stroke="white"
          strokeWidth="1.8"
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
        {box}
      </button>
    );
  }

  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-2 select-none transition-colors",
        disabled ? "opacity-40 pointer-events-none" : "text-t2 hover:text-t1",
        className,
      )}
    >
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="sr-only"
      />
      {box}
      {typeof label === "string" ? (
        <span className="text-[13px]">{label}</span>
      ) : (
        label
      )}
    </label>
  );
}
