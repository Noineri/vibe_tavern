/**
 * Shared Tailwind class tokens for provider form fields.
 *
 * `ProviderForm` (setup wizard) and `ProviderEditHeader` (settings modal) render
 * the same connection field shapes. These class strings were duplicated verbatim
 * across both files — centralizing them removes the only real drift surface
 * (the two copies had already diverged in formatting even where content matched).
 * Import and compose with `cn()` at call sites; do not inline-copy.
 */

export const labelCls = 'block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3';
export const inputCls = 'w-full h-11 sm:h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent px-[13px]';
export const pwCls = 'font-mono tracking-[0.05em]';
