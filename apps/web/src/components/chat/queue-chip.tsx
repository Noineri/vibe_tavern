import { forwardRef, type ComponentPropsWithoutRef } from "react";
import type { GenerationBatchSummary } from "../../stores/generation-queue-store.js";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { QueueProgressRing } from "./queue-progress-ring.js";

function clampSegment(value: number, limit: number): number {
  return Math.min(Math.max(value, 0), limit);
}

export const QueueChip = forwardRef<HTMLButtonElement, {
  summary: GenerationBatchSummary;
  mobile: boolean;
} & ComponentPropsWithoutRef<"button">>(function QueueChip({ summary, mobile, ...buttonProps }, ref) {
  const { t } = useT();
  const total = Math.max(summary.total, 0);
  const done = clampSegment(summary.done, total);
  const failed = clampSegment(summary.failed, total - done);
  const settled = summary.running === 0 && summary.pending === 0;
  const showsCheck = total > 0 && settled && summary.failed === 0;
  const failureText = t("queue_chip_failures", { count: summary.failed });
  const ariaLabel = `${t("queue_chip_aria", { done: summary.done, total: summary.total })}${summary.failed > 0 ? ` ${failureText}` : ""}`;

  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      className={cn(
        "glass-blur flex items-center rounded-full border border-border2 bg-glass-bg font-ui font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1",
        mobile
          ? "h-9 gap-2 px-3.5 text-[calc(var(--ui-fs))]"
          : "h-[26px] gap-1.5 px-2.5 text-[calc(var(--ui-fs)-2px)]",
      )}
      aria-label={ariaLabel}
    >
      <QueueProgressRing done={done} failed={failed} total={total} className={mobile ? "h-5 w-5" : "h-4 w-4"} running={summary.running > 0} testIdPrefix="queue-chip">
        {showsCheck && (
          <path
            data-testid="queue-chip-check"
            className="stroke-accent"
            d="M5.8 9.2l2.2 2.2 4-4.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        )}
      </QueueProgressRing>
      <span className="whitespace-nowrap">{t("queue_chip_progress", { done: summary.done, total: summary.total })}</span>
      {settled && summary.failed > 0 && <span data-testid="queue-chip-failures" className="whitespace-nowrap text-danger-text">{failureText}</span>}
    </button>
  );
});
