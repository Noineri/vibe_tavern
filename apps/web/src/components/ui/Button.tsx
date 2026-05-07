import React from 'react';
import { cn } from '../../lib/cn.js';

interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  className?: string;
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  [key: string]: any;
}

const VARIANT_CLASSES: Record<string, string> = {
  primary: 'h-[37px] px-[21px] bg-accent text-on-accent rounded-md font-ui cursor-pointer transition-filter hover:brightness-110',
  secondary: 'h-[37px] px-4 bg-transparent text-t3 rounded-md font-ui cursor-pointer transition-colors hover:text-t1',
  danger: 'bg-danger-dim text-danger-text border border-danger rounded-[5px] px-3 py-[5px] font-ui cursor-pointer transition-colors hover:bg-danger-dim',
  ghost: 'flex items-center gap-1 px-[7px] py-[3px] rounded font-ui text-t3 cursor-pointer transition-colors hover:bg-s2 hover:text-t2',
};

export function Button({ variant = 'primary', size, className = '', children, ...rest }: ButtonProps) {
  const sizeClass = size === 'sm'
    ? 'h-7 px-[14px] bg-surface text-danger-text border border-danger rounded-[5px] font-medium font-ui cursor-pointer transition-colors hover:bg-danger-dim'
    : '';
  const base = variant === 'danger' || variant === 'ghost' ? 'text-[calc(var(--ui-fs)-3px)]' : 'text-[calc(var(--ui-fs)-2px)] font-medium';
  return (
    <button
      className={cn(VARIANT_CLASSES[variant], base, sizeClass, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
