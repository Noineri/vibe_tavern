import React from 'react';
import { cn } from '../../lib/cn.js';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'accent' | 'success' | 'danger' | 'warning' | 'info';
  className?: string;
}

const VARIANT_CLASSES: Record<string, string> = {
  default: cn(
    'text-[calc(var(--ui-fs)-3px)] text-t2 bg-s2 border border-border rounded-[4px] px-[6px] py-[2px] cursor-pointer whitespace-nowrap max-w-[100px] overflow-ellipsis overflow-hidden inline-block align-middle',
  ),
  accent: cn(
    'text-[calc(var(--ui-fs)-3px)] text-accent-t bg-accent-dim border border-accent rounded-[4px] px-[6px] py-[2px] cursor-pointer whitespace-nowrap max-w-[100px] overflow-ellipsis overflow-hidden inline-block align-middle',
  ),
  success: cn(
    'whitespace-nowrap flex items-center gap-1 text-[calc(var(--ui-fs)-3px)] text-success-text bg-success-dim px-2 py-[3px] rounded-[20px] font-medium',
  ),
  danger: cn(
    'bg-danger-dim text-danger-text border border-danger rounded-[5px] px-3 py-[5px] font-ui cursor-pointer transition-colors',
  ),
  warning: cn(
    'text-[calc(var(--ui-fs)-3px)] text-warning-text tabular-nums whitespace-nowrap cursor-pointer transition-colors',
  ),
  info: cn(
    'text-[calc(var(--ui-fs)-3px)] text-t3 tabular-nums whitespace-nowrap cursor-pointer transition-colors',
  ),
};

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  const cls = VARIANT_CLASSES[variant] || VARIANT_CLASSES.default;
  return <span className={cn(cls, className)}>{children}</span>;
}
