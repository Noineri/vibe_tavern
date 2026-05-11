import { useCallback, useLayoutEffect, useRef } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";

/**
 * Find the nearest scrollable ancestor of an element.
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return null;
}

/**
 * Resize a textarea to fit its content.
 * When allowShrink is true, shrinks first then grows (for value changes).
 * When false, only grows (while typing).
 * Preserves scroll position of the nearest scrollable ancestor.
 */
export function resizeTextarea(el: HTMLTextAreaElement, allowShrink: boolean): void {
  const scrollParent = findScrollParent(el);
  const scrollTop = scrollParent?.scrollTop ?? 0;

  if (allowShrink) el.style.height = "auto";
  const min = parseFloat(getComputedStyle(el).minHeight) || 0;
  const next = Math.max(el.scrollHeight, min);
  if (allowShrink || next > el.getBoundingClientRect().height) {
    el.style.height = `${next}px`;
  }

  // Prevent scroll anchoring from jumping when textarea shrinks/grows
  if (scrollParent) scrollParent.scrollTop = scrollTop;
}

export interface AutoTextareaProps {
  className: string;
  style: React.CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  /** react-hook-form register() result — for uncontrolled fields */
  register?: UseFormRegisterReturn<any>;
  /** Controlled value — when set, component works in controlled mode */
  value?: string;
  /** Change handler for controlled mode */
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

/**
 * Auto-resizing textarea.
 *
 * Supports two modes:
 * - **Uncontrolled**: pass `register={register("field")}` — delegates to react-hook-form
 * - **Controlled**: pass `value` + `onChange` — for manually managed state
 *
 * Resizes on every render (shrinks to fit) and on every keystroke (grows only).
 */
export function AutoTextarea({
  className,
  style,
  disabled,
  placeholder,
  register,
  value,
  onChange,
}: AutoTextareaProps) {
  const elRef = useRef<HTMLTextAreaElement | null>(null);

  // Resize on every render — handles external value changes (tab switches, resets, imports)
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    resizeTextarea(el, true);
  });

  const handleRegisterChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      resizeTextarea(e.currentTarget, false);
      register?.onChange?.(e);
    },
    [register],
  );

  const handleControlledChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      resizeTextarea(e.currentTarget, false);
      onChange?.(e);
    },
    [onChange],
  );

  // Merge refs: both the internal elRef and the register ref (if any)
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      elRef.current = el;
      if (register) register.ref(el);
    },
    [register],
  );

  if (register) {
    // Uncontrolled mode (react-hook-form)
    return (
      <textarea
        {...register}
        ref={setRef}
        onChange={handleRegisterChange}
        className={className}
        style={style}
        disabled={disabled}
        placeholder={placeholder}
      />
    );
  }

  // Controlled mode (value + onChange)
  return (
    <textarea
      ref={setRef}
      className={className}
      style={style}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      onChange={handleControlledChange}
    />
  );
}
