import React from 'react';
import { cn } from '../../lib/cn.js';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Toggle({ checked, onChange, disabled = false, id, className }: ToggleProps) {
  return (
    <label className={cn("relative w-[36px] h-[20px] cursor-pointer shrink-0 inline-flex rounded-full", className)} htmlFor={id}>
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        id={id}
      />
      <span className="absolute inset-0 bg-s3 rounded-full transition-colors duration-[180ms] peer-checked:bg-accent" />
      <span className="absolute w-[14px] h-[14px] left-[3px] top-[3px] bg-t3 rounded-full transition-all duration-[180ms] peer-checked:translate-x-[16px] peer-checked:bg-white" />
    </label>
  );
}
