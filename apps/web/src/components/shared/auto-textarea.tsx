import { useCallback } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import TextareaAutosize, { type TextareaAutosizeProps } from "react-textarea-autosize";

/** Native HTML textarea attributes that AutoTextarea doesn't consume itself. */
export type AutoTextareaPassthrough = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  | "className" | "style" | "disabled" | "placeholder"
  | "value" | "onChange" | "ref" | "children"
  | "rows" // lib owns row-count via minRows/maxRows
>;

export interface AutoTextareaProps extends AutoTextareaPassthrough {
  className: string;
  /** Inline styles. NOTE: `minHeight` / `maxHeight` / `height` are NOT supported
   *  here — the underlying library owns element height and throws at runtime if
   *  they appear in `style`. Use `minRows` / `maxRows` for size control. */
  style?: React.CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  /** react-hook-form register() result — for uncontrolled fields. Field name
   *  is irrelevant here — only `.ref`/`.onChange`/spread are consumed below. */
  register?: UseFormRegisterReturn<string>;
  /** Controlled value — when set, component works in controlled mode */
  value?: string;
  /** Change handler for controlled mode */
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** Min visible rows (lib-native API). Scales with font-size, unlike a pixel
   *  minHeight — which is correct here because the app's font-size is a
   *  user-adjustable CSS variable. */
  minRows?: number;
  /** Max rows before the textarea stops growing and scrolls internally. Scales
   *  with font-size for the same reason as `minRows`. */
  maxRows?: number;
}

/**
 * Auto-resizing textarea backed by `react-textarea-autosize`.
 *
 * Supports two modes:
 * - **Uncontrolled**: pass `register={register("field")}` — delegates to react-hook-form
 * - **Controlled**: pass `value` + `onChange` — for manually managed state
 *
 * Size control is **row-based** (`minRows` / `maxRows`), not pixel-based. This
 * is deliberate: the app drives its font-size through user-adjustable CSS
 * variables (`--ui-fs` / `--mfs` via TweaksPanel), so a pixel cap would fight
 * the user — a larger font would show *fewer* visible lines and force inner
 * scrolling. Rows scale with the font: the same `maxRows` shows the same amount
 * of content regardless of font size; the box simply grows. This matches how
 * every adjustable-font UI (terminals, editors, chat inputs) bounds its input.
 *
 * The library measures content height via a hidden mirror textarea (so no
 * visible shrink-to-auto flicker) and does NOT accept `style.minHeight` /
 * `style.maxHeight` — it throws at runtime. Those keys are the caller's
 * responsibility to keep out of `style`; use the row props instead.
 */
export function AutoTextarea({
  className,
  style,
  disabled,
  placeholder,
  register,
  value,
  onChange,
  minRows,
  maxRows,
  ...rest
}: AutoTextareaProps) {
  // Merge onChange: react-hook-form's register.onChange + the controlled onChange.
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      register?.onChange?.(e);
      onChange?.(e);
    },
    [register, onChange],
  );

  // Merge refs: react-hook-form's register.ref needs the underlying element.
  // TextareaAutosize is a forwardRef component — we forward directly.
  const registerRef = register?.ref;
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (registerRef) registerRef(el);
    },
    [registerRef],
  );

  // `style` carries full React.CSSProperties (height: string|number), but the
  // lib's Style narrows height to number and forbids minHeight/maxHeight. Cast
  // at the seam — callers must keep those keys out of style (the lib's runtime
  // guard makes a mistake loud, not silent).
  return (
    <TextareaAutosize
      {...rest}
      {...(register ? { name: register.name, onBlur: register.onBlur } : {})}
      ref={setRef}
      className={className}
      style={style as TextareaAutosizeProps["style"]}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      onChange={handleChange}
      maxRows={maxRows}
      minRows={minRows}
    />
  );
}
