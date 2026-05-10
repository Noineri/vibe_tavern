/**
 * Small token counter badge — "123 tokens"
 * Typically placed in bottom-right corner under a textarea.
 */

import { useTokenCount } from "../../hooks/use-token-count.js";

interface TokenCounterProps {
  text: string;
  label?: string;
  className?: string;
}

export function TokenCounter({ text, label = "tokens", className }: TokenCounterProps) {
  const count = useTokenCount(text);
  return (
    <span
      className={className ?? "flex justify-end font-ui text-[11px] tabular-nums text-t3"}
    >
      {count.toLocaleString()} {label}
    </span>
  );
}
