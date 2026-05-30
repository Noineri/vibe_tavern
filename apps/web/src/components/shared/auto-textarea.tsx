import { useCallback, useLayoutEffect, useRef } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";

// resizeTextarea lives in textarea-helpers.ts — import from there directly.
// Do NOT re-export here to keep this file Fast Refresh compatible.
import { resizeTextarea } from "./textarea-helpers.js";

/** Native HTML textarea attributes that AutoTextarea doesn't consume itself. */
export type AutoTextareaPassthrough = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  | "className" | "style" | "disabled" | "placeholder"
  | "value" | "onChange" | "ref" | "children"
>;

export interface AutoTextareaProps extends AutoTextareaPassthrough {
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
  /** Max height in pixels — textarea stops growing and scrolls internally. Default: Infinity (no cap). */
  maxHeight?: number;
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
  maxHeight,
  ...rest
}: AutoTextareaProps) {
  const elRef = useRef<HTMLTextAreaElement | null>(null);

  // Resize on every render — handles external value changes (tab switches, resets, imports)
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    resizeTextarea(el, true, maxHeight);
  });

  const handleRegisterChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      resizeTextarea(e.currentTarget, false, maxHeight);
      register?.onChange?.(e);
    },
    [register],
  );

  const handleControlledChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      resizeTextarea(e.currentTarget, false, maxHeight);
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
        {...rest}
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
      {...rest}
      className={className}
      style={style}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      onChange={handleControlledChange}
    />
  );
}
