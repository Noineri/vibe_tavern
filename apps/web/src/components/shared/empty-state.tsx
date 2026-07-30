import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  sub?: string;
  cta?: ReactNode;
  onCta?: () => void;
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
        <div className="empty-cta" onClick={input.onCta}>
          {input.cta}
        </div>
      )}
      {input.secondaryCta && (
        <div 
          className="empty-cta text-t2 hover:text-t1 bg-transparent border-transparent shadow-none" 
          onClick={input.onSecondaryCta}
        >
          {input.secondaryCta}
        </div>
      )}
    </div>
  );
}
