import { useState } from "react";
import { NumberInput } from "../../shared/NumberInput.js";

/** Compact numeric field used by the sampler panel's basic settings. */
export function InlineNumField({
  value,
  placeholder,
  onBlur,
}: {
  value: number;
  placeholder?: string;
  onBlur: (v: number) => void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const displayValue = raw !== null ? raw : (value || "");
  return (
    <NumberInput
      className="h-[38px] w-full"
      hideControls
      value={value}
      onChange={(v) => onBlur(v)}
    />
  );
}
