import { Slider } from "../shared/slider.js";

/**
 * Two-thumb message-range control for the Summary tab.
 *
 * Incoming controlled values are normalized before they reach the shared
 * primitive: non-finite values fall back to min, values stay in bounds, and
 * reversed endpoints render in ascending order.
 */
export function DualRangeSlider({ min, max, from, to, disabled, label, formatValue, onChange }: {
  min: number; max: number; from: number; to: number;
  disabled?: boolean;
  label?: string;
  formatValue?: (from: number, to: number) => string;
  onChange: (from: number, to: number) => void;
}) {
  const clampValue = (value: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const safeFrom = Math.min(clampValue(from), clampValue(to));
  const safeTo = Math.max(clampValue(from), clampValue(to));

  return (
    <Slider
      appearance="field"
      label={label}
      formatValue={formatValue ? ([start, end]) => formatValue(start, end) : undefined}
      value={[safeFrom, safeTo]}
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      inputTestId={["range-start-input", "range-end-input"]}
      onValueChange={([nextFrom, nextTo]) => {
        const normalizedFrom = Math.min(clampValue(nextFrom), clampValue(nextTo));
        const normalizedTo = Math.max(clampValue(nextFrom), clampValue(nextTo));
        if (normalizedFrom !== safeFrom || normalizedTo !== safeTo) onChange(normalizedFrom, normalizedTo);
      }}
    />
  );
}
