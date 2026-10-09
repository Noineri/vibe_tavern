import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

const DEFAULT_CTA_CLASS = "empty-cta";
const PROMINENT_CTA_CLASS = "empty-cta min-h-11 px-4";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  sub?: string;
  cta?: ReactNode;
  onCta?: () => void;
  /** Uses a 44px minimum target for touch-first empty-state actions. */
  ctaProminent?: boolean;
  secondaryCta?: ReactNode;
  onSecondaryCta?: () => void;
}

export function EmptyState(input: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{input.icon}</div>
      <div className="empty-title">{input.title}</div>
      {input.sub && <div className="empty-sub">{input.sub}</div>}
      {input.cta && (
        <button
          type="button"
          className={cn(input.ctaProminent ? PROMINENT_CTA_CLASS : DEFAULT_CTA_CLASS)}
          onClick={input.onCta}
        >
          {input.cta}
        </button>
      )}
      {input.secondaryCta && (
        <button
          type="button"
          className="empty-cta text-t2 hover:text-t1 bg-transparent border-transparent shadow-none"
          onClick={input.onSecondaryCta}
        >
          {input.secondaryCta}
        </button>
      )}
    </div>
  );
}
