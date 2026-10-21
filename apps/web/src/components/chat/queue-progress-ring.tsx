import { type ReactNode } from "react";
import { cn } from "../../lib/cn.js";

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function clampSegment(value: number, limit: number): number {
  return Math.min(Math.max(value, 0), limit);
}

type QueueProgressRingProps = {
  children?: ReactNode;
  done?: number;
  failed?: number;
  total?: number;
  className: string;
  running?: boolean;
  indeterminateArc?: boolean;
  testIdPrefix: "queue-chip" | "queue-timeline-running";
};

/** Shared queue indicator geometry; the chip and desktop running node stay in the same SVG family. */
export function QueueProgressRing({ children, done, failed, total, className, running = false, indeterminateArc = false, testIdPrefix }: QueueProgressRingProps): ReactNode {
  const isRunning = running;
  const safeTotal = Math.max(total ?? 0, 0);
  const safeDone = clampSegment(done ?? 0, safeTotal);
  const safeFailed = clampSegment(failed ?? 0, safeTotal - safeDone);
  const doneLength = safeTotal > 0 ? (safeDone / safeTotal) * RING_CIRCUMFERENCE : 0;
  const failedLength = safeTotal > 0 ? (safeFailed / safeTotal) * RING_CIRCUMFERENCE : 0;

  return (
    <svg aria-hidden="true" data-testid={`${testIdPrefix}-ring`} className={cn(className, isRunning && "animate-spin-slow")} viewBox="0 0 18 18">
      <circle className="stroke-border" cx="9" cy="9" fill="none" r={RING_RADIUS} strokeWidth="2.4" />
      <circle
        data-testid={`${testIdPrefix}-done-arc`}
        className="stroke-accent"
        cx="9"
        cy="9"
        fill="none"
        r={RING_RADIUS}
        strokeDasharray={indeterminateArc ? `14 ${RING_CIRCUMFERENCE}` : `${doneLength} ${RING_CIRCUMFERENCE}`}
        strokeLinecap="round"
        strokeWidth="2.4"
        transform="rotate(-90 9 9)"
      />
      <circle
        data-testid={`${testIdPrefix}-failed-arc`}
        className="stroke-danger-text"
        cx="9"
        cy="9"
        fill="none"
        r={RING_RADIUS}
        strokeDasharray={`${failedLength} ${RING_CIRCUMFERENCE}`}
        strokeDashoffset={-doneLength}
        strokeLinecap="round"
        strokeWidth="2.4"
        transform="rotate(-90 9 9)"
      />
      {children}
    </svg>
  );
}
