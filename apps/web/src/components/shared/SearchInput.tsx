import React from "react";
import { cn } from "../../lib/cn.js";
import { Ic } from "./icons.js";

export type SearchInputProps = Omit<React.ComponentProps<"input">, "className" | "type"> & {
  /** Extension appended AFTER the container canon (base first, extension
   *  last — same composition contract as TextInput). */
  className?: string;
  /** Leading icon inside the shell. Defaults to the search glass — every
   *  search field in the app shows it (uniform family look); pass `null`
   *  explicitly to render an iconless shell. */
  icon?: React.ReactNode | null;
  /** Trailing slot INSIDE the shell (clear-✕ buttons, inline badges).
   *  Sits after the input, inside the border — chrome that used to live in
   *  hand shells belongs here, not as a floating sibling outside. */
  trailing?: React.ReactNode;
};

/**
 * The canonical list/toolbar search field (FIELD_SYSTEM_UNIFICATION_REPORT
 * FS-8c).
 *
 * The app had ~12 search shapes in two dialects: a bordered shell with a glass
 * icon around a borderless input (preset/regex lists, flyouts, sheets), and
 * bare compact bordered inputs (ListSearchPanel, coauthor rail). FS-8c (owner
 * 2026-09-10) unified them into one primitive using the composer philosophy:
 * THE SHELL CARRIES THE CHROME — the container owns border/background/focus
 * (focus-within → accent), the input inside is borderless and inherits
 * nothing. This is a designed compact family, not the full-height field canon:
 * search rows live inside dense toolbar/list headers where the standard
 * 38–44px field height would balloon the layout.
 *
 * Inputs stay single-line `type="text"`; value/onChange/ref and the rest of
 * the input props are forwarded as-is (testids land on the input element).
 */
export function SearchInput({
  className,
  icon,
  trailing,
  placeholder,
  onKeyDown,
  ...rest
}: SearchInputProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border bg-s2 px-2 py-[5px] transition-colors focus-within:border-accent",
        className,
      )}
    >
      <span className="shrink-0 text-t3">
        {icon === null ? null : (icon ?? <Ic.search />)}
      </span>
      <input
        {...rest}
        type="text"
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t3/60"
      />
      {trailing != null && <span className="flex shrink-0 items-center">{trailing}</span>}
    </div>
  );
}
