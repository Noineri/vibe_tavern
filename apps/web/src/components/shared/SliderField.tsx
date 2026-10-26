import type { ReactNode } from "react";
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
  /** Test id of the real Base UI range input (the keyboard / `change` seam). */
  rangeTestId?: string;
  /** Test id of the inline number editor's real `<input>`; the editor only
   *  exists while the field is being typed into (double-click or Enter). */
  numberTestId?: string;
  /** Clickable help node (the «?» tooltip) rendered inside the field next to
   *  the label; pressing it never scrubs the value. */
  help?: ReactNode;
  /** Commit-on-release for persist-per-call surfaces: the field fires
   *  onChange per drag tick (fast visual state), then onCommit ONCE when the
   *  drag/keypress ends, and once more when the inline number editor commits
   *  (Enter or blur; Escape commits nothing) — persist here, not in onChange.
   *  Mirrors NumberInput's commit-on-blur boundary (exemplars:
   *  ImageGenPane/TtsProfileEditor write fast state and persist at a coarse
   *  boundary). */
  onCommit?: (value: number) => void;
}

/** A parameter on a continuous scale: the `field` appearance of the shared
 *  Slider — label and value live INSIDE the scrubber, typing a number goes
 *  through its inline editor. */
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
  help,
  onCommit,
}: SliderFieldProps) {
  return (
    <Slider
      appearance="field"
      label={label}
      help={help}
      value={value ?? min}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      inputTestId={rangeTestId}
      numberTestId={numberTestId}
      onValueChange={onChange}
      onValueCommitted={onCommit}
    />
  );
}
