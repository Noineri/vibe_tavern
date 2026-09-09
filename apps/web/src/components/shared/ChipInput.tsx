/**
 * ChipInput — editable tag/chip list for discrete string values.
 *
 * Used for stop sequences, tags, etc.
 * - Enter / Tab / comma commits a chip
 * - Backspace on empty input removes last chip
 * - Each chip shows a remove button on hover
 * - Pasting an ST-style JSON array of strings commits it as many deduped chips
 * - Special character rendering: \n → ⏎, \t → ⇥, trailing space → ␣
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useT } from "../../i18n/context.js";

// ── Special character rendering ────────────────────────────────────

function renderChipContent(value: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let key = 0;
  let buffer = "";

  const flush = () => {
    if (buffer) {
      parts.push(<span key={key++}>{buffer}</span>);
      buffer = "";
    }
  };

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\n") {
      flush();
      parts.push(
        <span key={key++} className="inline-flex items-center justify-center rounded bg-s3 px-1 text-[9px] font-mono text-accent-t leading-none">
          ⏎
        </span>
      );
    } else if (ch === "\t") {
      flush();
      parts.push(
        <span key={key++} className="inline-flex items-center justify-center rounded bg-s3 px-1 text-[9px] font-mono text-accent-t leading-none">
          ⇥
        </span>
      );
    } else if (ch === " " && (i === 0 || i === value.length - 1)) {
      flush();
      parts.push(
        <span key={key++} className="inline-flex items-center justify-center rounded bg-s3 px-1 text-[9px] font-mono text-accent-t leading-none">
          ␣
        </span>
      );
    } else {
      buffer += ch;
    }
  }
  flush();
  return parts;
}

/**
 * Parse escape sequences in user input: \n → newline, \t → tab, \\ → backslash.
 */
function parseEscapeSequences(input: string): string {
  return input
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

/**
 * ST-style JSON array paste detection (LOCAL_SAMPLERS_ADDITION_REPORT B3):
 * a clipboard payload that is a JSON array of strings (e.g. `[" finger", " moan"]`)
 * is committed as MANY chips instead of one literal chip — ST migrants paste
 * their existing antislop/stop lists verbatim instead of re-typing them.
 * Values are taken verbatim from the parsed JSON (JSON unescaping already
 * applied); leading/trailing spaces stay significant. Returns null for
 * anything that is not an array of strings (plain text → normal paste).
 */
function parseJsonStringArray(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items = parsed as unknown[];
  if (!items.every((item): item is string => typeof item === "string")) return null;
  return items;
}

// ── Preset buttons ─────────────────────────────────────────────────

interface SpecialCharPreset {
  label: string;
  value: string;
  tooltip: string;
}

const SPECIAL_CHAR_PRESETS: SpecialCharPreset[] = [
  { label: "⏎ NL", value: "\\n", tooltip: "Newline (\\n)" },
  { label: "⇥ Tab", value: "\\t", tooltip: "Tab (\\t)" },
  { label: "␣ Space", value: " ", tooltip: "Space" },
];

// ── Component ──────────────────────────────────────────────────────

interface ChipInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Show the special character shortcut buttons */
  showPresets?: boolean;
  /** Tooltip content for the info icon */
  tooltip?: string;
  /** Label for the presets tooltip trigger (defaults to "?") */
  presetsLabel?: string;
  className?: string;
}

export function ChipInput({
  values,
  onChange,
  placeholder = "Type and press Enter…",
  disabled = false,
  showPresets = false,
  tooltip,
  presetsLabel,
  className,
}: ChipInputProps) {
  const { t } = useT();
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus input when clicking the container
  const handleContainerClick = useCallback(() => {
    if (!disabled) inputRef.current?.focus();
  }, [disabled]);

  const addChip = useCallback(
    (raw: string) => {
      if (raw.length === 0) return;
      const parsed = parseEscapeSequences(raw);
      if (parsed.length === 0) return;
      if (!values.includes(parsed)) {
        onChange([...values, parsed]);
      }
      setInputValue("");
    },
    [values, onChange],
  );

  const removeChip = useCallback(
    (index: number) => {
      const next = [...values];
      next.splice(index, 1);
      onChange(next);
    },
    [values, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && e.shiftKey) {
        // Shift+Enter commits the chip
        e.preventDefault();
        addChip(inputValue);
        return;
      }
      if (e.key === "Enter") {
        // Enter inserts \n literal (parsed to newline on commit)
        e.preventDefault();
        const input = inputRef.current;
        const start = input?.selectionStart ?? inputValue.length;
        const end = input?.selectionEnd ?? inputValue.length;
        const next = `${inputValue.slice(0, start)}\n${inputValue.slice(end)}`;
        const caret = start + 2;
        setInputValue(next);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(caret, caret);
        });
        return;
      }
      if (e.key === "Tab") {
        // Tab inserts \t literal (parsed to tab on commit)
        e.preventDefault();
        const input = inputRef.current;
        const start = input?.selectionStart ?? inputValue.length;
        const end = input?.selectionEnd ?? inputValue.length;
        const next = `${inputValue.slice(0, start)}\t${inputValue.slice(end)}`;
        const caret = start + 2;
        setInputValue(next);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(caret, caret);
        });
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        addChip(inputValue);
      } else if (e.key === "Backspace" && inputValue === "" && values.length > 0) {
        removeChip(values.length - 1);
      }
    },
    [inputValue, values.length, addChip, removeChip],
  );

  // Auto-resize: blur commits
  const handleBlur = useCallback(() => {
    if (inputValue.length > 0) addChip(inputValue);
  }, [inputValue, addChip]);

  // Paste interceptor: an ST-style JSON array (e.g. `[" finger", " moan"]`)
  // is committed as many deduped chips; anything else falls through to the
  // normal paste path (single chip via the usual Enter/blur commit).
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      const chips = parseJsonStringArray(text);
      if (!chips) return;
      e.preventDefault();
      const seen = new Set(values);
      const fresh: string[] = [];
      for (const chip of chips) {
        if (chip.length === 0 || seen.has(chip)) continue;
        seen.add(chip);
        fresh.push(chip);
      }
      if (fresh.length > 0) onChange([...values, ...fresh]);
    },
    [values, onChange],
  );

  const insertPreset = useCallback(
    (preset: SpecialCharPreset) => {
      const input = inputRef.current;
      const start = input?.selectionStart ?? inputValue.length;
      const end = input?.selectionEnd ?? inputValue.length;
      const next = `${inputValue.slice(0, start)}${preset.value}${inputValue.slice(end)}`;
      const caret = start + preset.value.length;
      setInputValue(next);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(caret, caret);
      });
    },
    [inputValue],
  );

  return (
    <div className={className}>
      <div
        ref={containerRef}
        onClick={handleContainerClick}
        className={cn(
          "flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border bg-s2 px-2.5 py-1.5 transition-colors",
          disabled
            ? "cursor-not-allowed border-border opacity-40"
            : "border-border cursor-text focus-within:border-accent",
        )}
      >
        {values.map((val, i) => (
          <span
            key={`${i}:${val}`}
            className={cn(
              "group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors select-none",
              disabled
                ? "border-border bg-s3 text-t3"
                : "border-accent/30 bg-accent/10 text-accent-t hover:border-danger/50 hover:bg-danger/10 hover:text-danger",
            )}
          >
            {renderChipContent(val)}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeChip(i); }}
                className="ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-inherit"
                aria-label={t("remove_aria")}
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
                  <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
                </svg>
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
          disabled={disabled}
          placeholder={values.length === 0 ? placeholder : ""}
          className={cn(
            "min-w-[80px] flex-1 bg-transparent font-mono text-[12px] text-t1 outline-none placeholder:text-t3/50",
            disabled && "pointer-events-none",
          )}
        />
        {!disabled && inputValue.length > 0 && (
          <button
            type="button"
            onClick={() => addChip(inputValue)}
            className="flex-shrink-0 rounded border border-accent/40 px-1.5 py-0.5 font-ui text-[10px] text-accent-t transition-colors hover:border-accent hover:bg-accent/10"
            title={showPresets ? "Shift+Enter" : undefined}
          >
            ✓
          </button>
        )}
      </div>

      {/* Preset buttons row */}
      {showPresets && !disabled && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {tooltip && (
            <CustomTooltip content={tooltip}>
              <span className="cursor-help font-ui text-[10px] uppercase tracking-wider text-t3/60 transition-colors hover:text-t3">
                {presetsLabel || "?"}
              </span>
            </CustomTooltip>
          )}
          {SPECIAL_CHAR_PRESETS.map((preset) => (
            <CustomTooltip key={preset.value} content={preset.tooltip}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertPreset(preset)}
                className="rounded border border-border2 bg-s3 px-2 py-0.5 font-ui text-[10px] text-t3 transition-colors hover:border-accent hover:text-accent-t"
              >
                {preset.label}
              </button>
            </CustomTooltip>
          ))}
        </div>
      )}
    </div>
  );
}
