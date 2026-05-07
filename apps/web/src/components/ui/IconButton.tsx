import React from 'react';
import { cn } from '../../lib/cn.js';

interface IconButtonProps {
  className?: string;
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  [key: string]: any;
}

export function IconButton({ className = '', children, ...rest }: IconButtonProps) {
  return (
    <button
      className={cn(
        'w-8 h-8 flex items-center justify-center rounded-[5px] cursor-pointer text-t3 transition-colors shrink-0 hover:bg-s2 hover:text-t1',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
