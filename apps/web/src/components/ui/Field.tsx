import React from 'react';
import { cn } from '../../lib/cn.js';

/** Descendant input/textarea/select base styles for field child elements */
const fieldChildStyles = [
  '[&_input]:w-full [&_input]:bg-s2 [&_input]:border [&_input]:border-border [&_input]:rounded-[6px]',
  '[&_input]:py-[9px] [&_input]:px-[13px] [&_input]:font-ui [&_input]:text-[calc(var(--ui-fs)-1px)]',
  '[&_input]:text-t1 [&_input]:outline-none [&_input]:transition-[border-color] [&_input]:duration-150',
  '[&_input:focus]:border-accent',
  '[&_[type=password]]:font-mono [&_[type=password]]:tracking-[0.05em]',
  '[&_textarea]:w-full [&_textarea]:bg-s2 [&_textarea]:border [&_textarea]:border-border [&_textarea]:rounded-[6px]',
  '[&_textarea]:py-[9px] [&_textarea]:px-[13px] [&_textarea]:font-ui [&_textarea]:text-[calc(var(--ui-fs)-1px)]',
  '[&_textarea]:text-t1 [&_textarea]:outline-none [&_textarea]:transition-[border-color] [&_textarea]:duration-150',
  '[&_textarea:focus]:border-accent',
  '[&_select]:w-full [&_select]:h-[38px] [&_select]:bg-s2 [&_select]:border [&_select]:border-border [&_select]:rounded-[6px]',
  '[&_select]:pl-[13px] [&_select]:pr-[34px] [&_select]:font-ui [&_select]:text-[calc(var(--ui-fs)-1px)]',
  '[&_select]:text-t1 [&_select]:outline-none [&_select]:transition-[border-color] [&_select]:duration-150',
  '[&_select:focus]:border-accent',
].join(' ');

interface FieldProps {
  label: string;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}

export function Field({ label, children, hint, className = '' }: FieldProps) {
  return (
    <div className={cn('mb-4', fieldChildStyles, className)}>
      <label className="block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3 mb-[7px]">{label}</label>
      {children}
      {hint && <div className="text-[calc(var(--ui-fs)-3px)] text-t3 mt-1.5 leading-[1.5] [&_a]:text-accent-t [&_a]:no-underline [&_a:hover]:underline">{hint}</div>}
    </div>
  );
}
