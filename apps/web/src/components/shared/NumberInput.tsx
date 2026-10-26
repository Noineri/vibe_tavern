import { useRef, useState, useEffect } from "react";
import { cn } from "../../lib/cn.js";

const MinusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
    <line x1="2" y1="8" x2="14" y2="8" />
  </svg>
);

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
    <line x1="8" y1="2" x2="8" y2="14" />
    <line x1="2" y1="8" x2="14" y2="8" />
  </svg>
);

export interface NumberInputProps {
  value: number;
  onChange: (val: number) => void;
  /** Fires after the blur commit; the event tells callers where focus is going (`relatedTarget`). */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  hideControls?: boolean;
  /** Focuses the input and selects its text on mount (inline editors). */
  autoFocus?: boolean;
  /** Fires on Escape; the caller decides what cancelling means (the input itself keeps its text). */
  onEscape?: () => void;
  /** Test id placed on the real `<input>`, not on the wrapper. */
  inputTestId?: string;
}

export function NumberInput({
  value,
  onChange,
  onBlur,
  min = -Infinity,
  max = Infinity,
  step = 1,
  disabled = false,
  className,
  inputClassName,
  hideControls = false,
  autoFocus = false,
  onEscape,
  inputTestId,
}: NumberInputProps) {
  const [internalVal, setInternalVal] = useState<string>(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setInternalVal(String(value));
    }
  }, [value]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [autoFocus]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (document.activeElement === el) {
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const clampAndSnap = (val: number) => {
    return Math.max(min, Math.min(max, val));
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    let parsed = parseFloat(internalVal);
    if (isNaN(parsed)) {
      setInternalVal(String(value));
    } else {
      parsed = clampAndSnap(parsed);
      setInternalVal(String(parsed));
      if (parsed !== value) {
        onChange(parsed);
      }
    }
    onBlur?.(e);
  };

  const adjustValue = (delta: number) => {
    if (disabled) return;
    let current = parseFloat(internalVal);
    if (isNaN(current)) current = value;
    
    // Fix floating point math issues (e.g. 0.1 + 0.2 = 0.30000000000000004)
    const factor = 10000;
    const next = clampAndSnap(Math.round((current + delta) * factor) / factor);
    
    setInternalVal(String(next));
    onChange(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      adjustValue(step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      adjustValue(-step);
    } else if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      onEscape?.();
    }
  };

  return (
    <div
      className={cn(
        "flex h-8 items-center overflow-hidden rounded-md border border-border bg-s2 transition-colors focus-within:border-accent",
        disabled && "opacity-50 pointer-events-none",
        className
      )}
    >
      {!hideControls && (
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || value <= min}
          onClick={() => adjustValue(-step)}
          className="flex h-full w-8 shrink-0 items-center justify-center text-t3 transition-[background-color,color,transform] duration-150 ease-out hover:bg-s3 hover:text-t1 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-30"
        >
          <MinusIcon />
        </button>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className={cn(
          // tabular-nums: digits are equal-width so the value doesn't shift the
          // input width (and surrounding layout) as it changes via +/- buttons.
          "h-full w-full min-w-0 bg-transparent px-1 font-ui text-[calc(var(--ui-fs)-1px)] tabular-nums text-t1 outline-none",
          hideControls ? "px-3 text-left" : "text-center",
          inputClassName
        )}
        value={internalVal}
        disabled={disabled}
        data-testid={inputTestId}
        onChange={(e) => setInternalVal(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
      {!hideControls && (
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || value >= max}
          onClick={() => adjustValue(step)}
          className="flex h-full w-8 shrink-0 items-center justify-center text-t3 transition-[background-color,color,transform] duration-150 ease-out hover:bg-s3 hover:text-t1 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-30"
        >
          <PlusIcon />
        </button>
      )}
    </div>
  );
}
