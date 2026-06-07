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
  onBlur?: () => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  hideControls?: boolean;
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
}: NumberInputProps) {
  const [internalVal, setInternalVal] = useState<string>(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setInternalVal(String(value));
    }
  }, [value]);

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

  const handleBlur = () => {
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
    onBlur?.();
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
          className="flex h-full w-8 shrink-0 items-center justify-center text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:pointer-events-none disabled:opacity-30"
        >
          <MinusIcon />
        </button>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className={cn(
          "h-full w-full min-w-0 bg-transparent px-1 font-ui text-[13px] text-t1 outline-none",
          hideControls ? "px-3 text-left" : "text-center",
          inputClassName
        )}
        value={internalVal}
        disabled={disabled}
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
          className="flex h-full w-8 shrink-0 items-center justify-center text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:pointer-events-none disabled:opacity-30"
        >
          <PlusIcon />
        </button>
      )}
    </div>
  );
}
