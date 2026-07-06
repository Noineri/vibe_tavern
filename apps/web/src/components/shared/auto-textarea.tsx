import { useCallback, useState } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import TextareaAutosize from "react-textarea-autosize";

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
  /** react-hook-form register() result — for uncontrolled fields. Field name
   *  is irrelevant here — only `.ref`/`.onChange`/spread are consumed below. */
  register?: UseFormRegisterReturn<string>;
  /** Controlled value — when set, component works in controlled mode */
  value?: string;
  /** Change handler for controlled mode */
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** Max height in pixels — textarea stops growing and scrolls internally. Default: Infinity (no cap). */
  maxHeight?: number;
}

/**
 * Auto-resizing textarea backed by `react-textarea-autosize`.
 *
 * Supports two modes:
 * - **Uncontrolled**: pass `register={register("field")}` — delegates to react-hook-form
 * - **Controlled**: pass `value` + `onChange` — for manually managed state
 *
 * The underlying library measures content height via a hidden mirror textarea
 * (so no visible shrink-to-auto flicker) and exposes `onHeightChange(height,
 * { rowHeight })`. We keep the call-site contract pixel-based (`maxHeight` in
 * px, `style.minHeight` in px) — the same API the previous hand-rolled
 * `resizeTextarea` exposed — and translate px → rows here using the measured
 * `rowHeight`. `react-textarea-autosize` does NOT accept `style.minHeight`/
 * `style.maxHeight` (it throws), so those keys are stripped from `style` and
 * routed through `minRows`/`maxRows` instead.
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
  // Pull minHeight/maxHeight OUT of style — the library throws at runtime if
  // either key is present in `style`. They're routed through row-based props.
  // `height` is also stripped: the lib owns it (sets it via `!important` on
  // every measure), so a caller-supplied height would be dead anyway.
  const { minHeight: styleMinHeight, maxHeight: _styleMaxHeight, height: _styleHeight, ...cleanStyle } = style;
  void _styleMaxHeight; // maxHeight arrives as a dedicated prop; style.maxHeight is not supported.
  void _styleHeight; // the lib owns height; caller value is ignored.

  const minHeightPx =
    typeof styleMinHeight === "number"
      ? styleMinHeight
      : typeof styleMinHeight === "string"
        ? parseFloat(styleMinHeight)
        : undefined;

  // Measure the content row height via the library's own callback, then derive
  // maxRows/minRows from our pixel API. The first measurement happens in the
  // lib's useLayoutEffect on mount (before paint), so the cap applies within
  // the initial frame — no visible uncapped-grow flash.
  const [rowHeight, setRowHeight] = useState<number | undefined>(undefined);
  const handleHeightChange = useCallback((_height: number, meta: { rowHeight: number }) => {
    if (meta.rowHeight > 0) setRowHeight(meta.rowHeight);
  }, []);

  const maxRows = maxHeight && rowHeight ? Math.max(1, Math.floor(maxHeight / rowHeight)) : undefined;
  const minRows = minHeightPx && rowHeight ? Math.max(1, Math.floor(minHeightPx / rowHeight)) : undefined;

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

  return (
    <TextareaAutosize
      {...rest}
      {...(register ? { name: register.name, onBlur: register.onBlur } : {})}
      ref={setRef}
      className={className}
      style={cleanStyle}
      disabled={disabled}
      placeholder={placeholder}
      value={value}
      onChange={handleChange}
      onHeightChange={handleHeightChange}
      maxRows={maxRows}
      minRows={minRows}
    />
  );
}
