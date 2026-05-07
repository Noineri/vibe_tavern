import React from 'react';
import { cn } from '../../lib/cn.js';

interface TextAreaFieldProps {
  label?: string;
  hint?: string;
  className?: string;
  children?: React.ReactNode;
  [key: string]: any;
}

const taBase = 'w-full bg-s2 border border-border rounded-[6px] py-[9px] px-[13px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent';

export function TextAreaField({ label, hint, className = '', ...rest }: TextAreaFieldProps) {
  return (
    <div className="mb-4">
      {label && <label className="block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3 mb-[7px]">{label}</label>}
      <textarea className={cn(taBase, className)} {...rest} />
      {hint && <div className="text-[calc(var(--ui-fs)-3px)] text-t3 mt-1.5 leading-[1.5] [&_a]:text-accent-t [&_a]:no-underline [&_a:hover]:underline">{hint}</div>}
    </div>
  );
}
