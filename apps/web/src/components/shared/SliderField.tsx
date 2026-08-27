import { cn } from "../../lib/cn.js";
import { NumberInput } from "./NumberInput.js";
import { lblCls } from "../build/fields/field-styles.js";

export interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
  rangeTestId?: string;
  numberTestId?: string;
}

export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
  ariaLabel,
  rangeTestId,
  numberTestId,
}: SliderFieldProps) {
  const val = value ?? min;

  function handleRangeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseFloat(e.target.value);
    if (!Number.isNaN(v)) onChange(v);
  }

  return (
    <div>
      <label className={lblCls}>{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={handleRangeChange}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          data-testid={rangeTestId}
          className={cn("!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent p-0", disabled && "opacity-40")}
        />
        <div data-testid={numberTestId} className="contents">
          <NumberInput
            className="h-[30px] w-[60px] shrink-0"
            min={min}
            max={max}
            step={step}
            value={val}
            onChange={onChange}
            disabled={disabled}
            hideControls
          />
        </div>
      </div>
    </div>
  );
}
