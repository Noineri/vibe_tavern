import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/cn.js';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * Toggle switch.
 *
 * - Track fill is an interruptible CSS color transition.
 * - The thumb translates + scales via a motion spring keyed to `checked`
 *   (bounce 0 — per the icon-animation spec; springs only because the project
 *   already depends on framer-motion). Translating with `x` keeps the thumb
 *   on the GPU compositor, so toggling back mid-animation reverses smoothly.
 * - `initial={false}` skips the mount animation — the thumb doesn't fly in on
 *   first render, only on real state changes.
 */
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
      <span className="absolute inset-0 rounded-full bg-s3 transition-colors duration-[180ms] ease-out peer-checked:bg-accent" />
      <motion.span
        initial={false}
        animate={{ x: checked ? 16 : 0 }}
        transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
        className="absolute top-[3px] left-[3px] h-[14px] w-[14px] rounded-full bg-t3 peer-checked:bg-white"
      />
    </label>
  );
}
