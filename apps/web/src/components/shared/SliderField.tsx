import { useRef } from "react";
import { NumberInput } from "./NumberInput.js";
import { lblCls } from "../../lib/field-tokens.js";
import { Slider } from "./slider.js";

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
  /** Commit-on-release for persist-per-call surfaces: the range fires
   *  onChange per drag tick (fast visual state), then onCommit ONCE when the
   *  drag/keypress ends — persist here, not in onChange. The NumberInput half
   * is already commit-shaped (it commits on blur); its blur fires onCommit
   * too. Mirrors NumberInput's commit-on-blur boundary (exemplars:
   *  ImageGenPane/TtsProfileEditor write fast state and persist at a coarse
   *  boundary). */
  onCommit?: (value: number) => void;
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
  onCommit,
}: SliderFieldProps) {
  const val = value ?? min;
  const latestValue = useRef(val);
  latestValue.current = val;

  function handleValueChange(nextValue: number) {
    if (disabled) return;
    latestValue.current = nextValue;
    onChange(nextValue);
  }

  function handleNumberCommit() {
    if (!disabled) onCommit?.(latestValue.current);
  }

  function handleValueCommitted(committedValue: number) {
    if (disabled) return;
    latestValue.current = committedValue;
    onCommit?.(committedValue);
  }

  return (
    <div>
      <label className={lblCls}>{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <Slider
          className="flex-1"
          value={val}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          inputTestId={rangeTestId}
          onValueChange={handleValueChange}
          onValueCommitted={onCommit ? handleValueCommitted : undefined}
        />
        <div data-testid={numberTestId} className="contents">
          <NumberInput
            className="h-[30px] w-[60px] shrink-0"
            min={min}
            max={max}
            step={step}
            value={val}
            onChange={handleValueChange}
            onBlur={onCommit ? handleNumberCommit : undefined}
            disabled={disabled}
            hideControls
          />
        </div>
      </div>
    </div>
  );
}
