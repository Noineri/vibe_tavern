/**
 * Small token counter badge — "123 tokens"
 * Typically placed in bottom-right corner under a textarea.
 */

import { useTokenCount } from "../../hooks/use-token-count.js";
import { useT } from "../../i18n/context.js";

interface TokenCounterProps {
  text: string;
  label?: string;
  className?: string;
}

export function TokenCounter({ text, label, className }: TokenCounterProps) {
  const { t } = useT();
  const count = useTokenCount(text);
  return (
    <span
      className={className ?? "flex justify-end font-ui text-[11px] tabular-nums text-t3"}
    >
      {count.toLocaleString()} {label || t("tokens_label")}
    </span>
  );
}
