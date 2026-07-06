import * as Switch from "@radix-ui/react-switch";
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
 * Toggle switch — a wrapped Radix Switch.
 *
 * Radix provides the a11y layer (`role="switch"`, `aria-checked`, focus-visible
 * ring, Space/Enter toggle, keyboard activation). The visual layer — the track
 * color transition and the thumb spring — is kept on the project's own terms:
 *
 * - Track fill is an interruptible CSS color transition. Driven by Radix's
 *   `data-state` on the Root via Tailwind's `group-data-[state=checked]:`
 *   variant (Radix Switch is a `<button>`, not an `input`+`label`, so the old
 *   `peer-checked:` sibling selector no longer applies — `group`/`group-data`
 *   is the parent-child equivalent).
 * - The thumb translates via a motion spring keyed to `checked` (bounce 0 —
 *   per the icon-animation spec; springs only because the project already
 *   depends on framer-motion). Translating with `x` keeps the thumb on the GPU
 *   compositor, so toggling back mid-animation reverses smoothly.
 * - `initial={false}` skips the mount animation — the thumb doesn't fly in on
 *   first render, only on real state changes.
 *
 * Why not `Switch.Thumb`: Radix's Thumb renders its own `<span>` and we'd have
 * to fight it to keep the spring; rendering the motion.span ourselves as a
 * child of the Root keeps the existing animation verbatim and is exactly the
 * "wrapped" strategy called for in toggle-segmented-radix-migration.md.
 */
export function Toggle({ checked, onChange, disabled = false, id, className }: ToggleProps) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      id={id}
      className={cn(
        "group relative w-[36px] h-[20px] cursor-pointer shrink-0 inline-flex rounded-full",
        className,
      )}
    >
      <span className="absolute inset-0 rounded-full bg-s3 transition-colors duration-[180ms] ease-out group-data-[state=checked]:bg-accent" />
      <motion.span
        initial={false}
        animate={{ x: checked ? 16 : 0 }}
        transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
        className="absolute top-[3px] left-[3px] h-[14px] w-[14px] rounded-full bg-t3 group-data-[state=checked]:bg-white"
      />
    </Switch.Root>
  );
}
