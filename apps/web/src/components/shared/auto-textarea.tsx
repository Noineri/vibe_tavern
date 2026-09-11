import { createPortal } from "react-dom";
import { useCallback, useMemo, useRef, useState } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import TextareaAutosize, { type TextareaAutosizeProps } from "react-textarea-autosize";
import { getMacroCatalog, type MacroCatalogEntry } from "@vibe-tavern/prompt-pipeline";
import { MacroAutocomplete } from "./MacroAutocomplete.js";
import {
  filterMacros,
  orderMacrosForDisplay,
  readMacroQuery,
  useMacroAutocompleteStore,
} from "./macro-autocomplete-store.js";

/** The canonical auto-grow field class (see `lib/field-tokens.ts`).
 *  `className` is an EXTENSION — the base always composes (FS-8b flip,
 *  2026-09-10): a passed className adds to the base instead of replacing
 *  it, killing the silent-unstyled-field bug class permanently. The one
 *  escape hatch is the explicit `bare` mode below. */
import { cn, } from "../../lib/cn.js";
import { monoMod, textareaCls } from "../../lib/field-tokens.js";

/** Native HTML textarea attributes that AutoTextarea doesn't consume itself. */
export type AutoTextareaPassthrough = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  | "className" | "style" | "disabled" | "placeholder"
  | "value" | "onChange" | "ref" | "children"
  | "rows" // lib owns row-count via minRows/maxRows
>;

export interface AutoTextareaProps extends AutoTextareaPassthrough {
  /** Optional — a bare AutoTextarea IS the canonical field (textareaCls,
   *  lib/field-tokens.ts). Since the FS-8b flip a passed className EXTENDS
   *  the base (base always composes) — the silent-replace window is closed. */
  className?: string;
  /** Explicit no-base mode — the composer-family escape hatch (FS-8b).
   *  When set, the primitive applies NO base at all: the caller's className
   *  carries everything (borderless composer chrome, bubble/strip shells).
   *  This is the one visible, greppable opt-out — composing a field base
   *  under a composer chrome would fight it (border-inside-border, UI font
   *  under prose font), so the composer family opts out DELIBERATELY.
   *  Regular fields never set this. */
  bare?: boolean;
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
  /** Disable the `{{` macro autocomplete for this surface. Default: enabled.
   *  Macros resolve harmlessly at chat time, so the picker is on everywhere;
   *  surfaces where `{{` is literal (rare) can opt out. */
  macroAutocomplete?: boolean;
  /** Mono variant for opaque technical content (regex patterns, DSL,
   *  template sequences) — composes the canon base with `monoMod`. The mono
   *  style NEVER carries its own size (the `text-xs` mono of the retired
   *  build tokens is dead — see lib/field-tokens.ts). */
  mono?: boolean;
}

/** The native `value` setter on HTMLTextAreaElement, used to programmatically
 *  update a React-controlled textarea and then dispatch the `input` event so
 *  React's onChange (and react-hook-form's register.onChange) fire.
 *  Guarded for DOM-less module graphs (bun:test loads DOM-averse suites
 *  without a window; insertMacro no-ops on undefined). */
const textareaValueSetter = typeof window === "undefined"
	? undefined
	: (Object.getOwnPropertyDescriptor(
		window.HTMLTextAreaElement.prototype,
		"value",
	)?.set as ((this: HTMLTextAreaElement, value: string) => void) | undefined);

/**
 * Auto-resizing textarea backed by `react-textarea-autosize`, with a built-in
 * `{{`-trigger macro autocomplete (propagates to every consumer surface).
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
 *
 * Macro autocomplete: typing `{{` opens a floating picker of pipeline macros
 * (catalog from `@vibe-tavern/prompt-pipeline`), ordered last-used-first. The
 * textarea keeps DOM focus (typing continues); arrows/Enter/Escape drive the
 * popup. On select the typed `{{query` is replaced by `{{name}}` at the caret,
 * via the native-value-setter + `input` dispatch so both react-hook-form and
 * controlled-mode handlers see the change. Unresolved macros are harmless
 * (resolved at chat time), so the picker is on by default everywhere.
 */
export function AutoTextarea({
  className,
  bare,
  mono,
  style,
  disabled,
  placeholder,
  register,
  value,
  onChange,
  minRows,
  maxRows,
  macroAutocomplete = true,
  onSelect,
  onKeyDown,
  onBlur,
  onClick,
  ...rest
}: AutoTextareaProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [acOpen, setAcOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const catalog = useMemo<MacroCatalogEntry[]>(() => getMacroCatalog(), []);
  const recency = useMacroAutocompleteStore((s) => s.recency);
  const pickMacro = useMacroAutocompleteStore((s) => s.pick);
  const ordered = useMemo(() => orderMacrosForDisplay(catalog, recency), [catalog, recency]);
  const filtered = useMemo(() => filterMacros(ordered, query), [ordered, query]);

  // Recompute the autocomplete session from the live textarea (value + caret).
  // Called on change/select/click — reads the DOM directly (not React props) so
  // it works identically in controlled and uncontrolled modes. Bails out when
  // nothing changed to avoid redundant renders from the frequent `select` event.
  const recompute = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const q = readMacroQuery(el.value, el.selectionStart ?? el.value.length);
    setAcOpen((prev) => {
      const next = q !== null;
      return prev === next ? prev : next;
    });
    if (q === null) {
      setQuery("");
    } else {
      setQuery(q);
      setActiveIndex(0);
    }
  }, []);

  const closeAc = useCallback(() => {
    setAcOpen(false);
    setQuery("");
  }, []);

  // Insert `{{name}}`, replacing the typed `{{query` at the caret. Uses the
  // native value setter + a dispatched `input` event so React's onChange fires
  // for BOTH register (react-hook-form) and controlled-mode handlers.
  const insertMacro = useCallback(
    (name: string) => {
      const el = taRef.current;
      if (!el || !textareaValueSetter) return;
      const { value: v, selectionStart } = el;
      const caret = selectionStart ?? v.length;
      const before = v.slice(0, caret);
      const braceIdx = before.lastIndexOf("{{");
      if (braceIdx === -1) {
        closeAc();
        return;
      }
      const token = `{{${name}}}`;
      const newValue = v.slice(0, braceIdx) + token + v.slice(caret);
      const newCaret = braceIdx + token.length;
      textareaValueSetter.call(el, newValue);
      el.setSelectionRange(newCaret, newCaret);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      pickMacro(name);
      closeAc();
      el.focus();
    },
    [pickMacro, closeAc],
  );

  // Merge onChange: react-hook-form's register.onChange + the controlled
  // onChange + recompute the autocomplete session.
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      register?.onChange?.(e);
      onChange?.(e);
      recompute();
    },
    [register, onChange, recompute],
  );

  // Native `select` event = caret moved (arrows / click) without typing —
  // recompute so the popup closes when the caret leaves the `{{` session.
  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      onSelect?.(e);
      recompute();
    },
    [onSelect, recompute],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      onClick?.(e);
      recompute();
    },
    [onClick, recompute],
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      register?.onBlur?.(e);
      onBlur?.(e);
      closeAc();
    },
    [register, onBlur, closeAc],
  );

  // Keyboard navigation while the popup is open. The textarea keeps focus; we
  // intercept arrows / Enter / Tab / Escape and drive the popup directly, so
  // cmdk's own focus model (which would steal focus from the field) isn't used.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!acOpen || !macroAutocomplete) {
        onKeyDown?.(e);
        return;
      }
      const count = filtered.length;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (count ? (i + 1) % count : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (count ? (i - 1 + count) % count : 0));
          break;
        case "Enter":
        case "Tab": {
          const entry = filtered[activeIndex];
          if (entry) {
            e.preventDefault();
            insertMacro(entry.name);
          } else {
            closeAc();
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          closeAc();
          break;
        default:
          onKeyDown?.(e);
      }
    },
    [acOpen, macroAutocomplete, filtered, activeIndex, insertMacro, closeAc, onKeyDown],
  );

  // Merge refs: react-hook-form's register.ref needs the underlying element;
  // taRef drives the autocomplete. TextareaAutosize is a forwardRef component.
  const registerRef = register?.ref;
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el;
      if (registerRef) registerRef(el);
    },
    [registerRef],
  );

  const safeIndex = filtered.length === 0 ? -1 : ((activeIndex % filtered.length) + filtered.length) % filtered.length;

  // `style` carries full React.CSSProperties (height: string|number), but the
  // lib's Style narrows height to number and forbids minHeight/maxHeight. Cast
  // at the seam — callers must keep those keys out of style (the lib's runtime
  // guard makes a mistake loud, not silent).
  return (
    <>
      <TextareaAutosize
        {...rest}
        {...(register ? { name: register.name } : {})}
        ref={setRef}
        className={
          bare
            ? className
            : cn(mono ? cn(textareaCls, monoMod) : textareaCls, className)
        }
        style={style as TextareaAutosizeProps["style"]}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onSelect={handleSelect}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        maxRows={maxRows}
        minRows={minRows}
      />
      {macroAutocomplete && acOpen
        ? createPortal(
            <MacroAutocomplete
              items={filtered}
              activeIndex={safeIndex}
              onSelect={insertMacro}
              onHover={setActiveIndex}
              anchorEl={taRef.current}
              query={query}
            />,
            document.body,
          )
        : null}
    </>
  );
}
