import React from 'react';
import { cn } from '../../lib/cn.js';

type NoticeKind = 'info' | 'success' | 'warning' | 'danger';

interface NoticeProps {
  kind: NoticeKind;
  children: React.ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<NoticeKind, string> = {
  danger: 'p-4 bg-danger-dim border border-danger rounded-lg text-danger-text text-[13px] leading-[1.5] font-ui',
  success: 'p-4 bg-success-dim border border-success rounded-lg text-success-text text-[13px] leading-[1.5] font-ui',
  warning: 'p-4 bg-warning-dim border border-warning rounded-lg text-warning-text text-[13px] leading-[1.5] font-ui',
  info: 'p-4 bg-info-dim border border-info rounded-lg text-t2 text-[13px] leading-[1.5] font-ui',
};

export function Notice({ kind, children, className = '' }: NoticeProps) {
  return (
    <div className={cn(VARIANT_CLASSES[kind], className)}>
      {children}
    </div>
  );
}
