import React from 'react';
import { cn } from '../../lib/cn.js';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  sub?: string;
  cta?: string;
  onCta?: () => void;
  className?: string;
}

export function EmptyState({ icon, title, sub, cta, onCta, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-[60px] px-6 text-center min-h-[220px] select-none', className)}>
      {icon && <div className="w-12 h-12 rounded-xl bg-s2 border border-border flex items-center justify-center text-t3 shrink-0">{icon}</div>}
      <div className="text-sm font-medium text-t2">{title}</div>
      {sub && <div className="text-xs text-t3 leading-[1.55] max-w-[280px]">{sub}</div>}
      {cta && <div className="mt-1 text-xs text-accent-t bg-accent-dim rounded-md px-4 py-1.5 cursor-pointer transition-colors hover:bg-accent-hover" onClick={onCta}>{cta}</div>}
    </div>
  );
}
