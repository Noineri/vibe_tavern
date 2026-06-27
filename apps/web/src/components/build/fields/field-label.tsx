import type { ReactNode } from "react";
import { cn } from "../../../lib/cn.js";

const FIELD_LABEL_CLASS =
  "mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3";

interface FieldLabelProps {
  children: ReactNode;
  /**
   * Adds `cursor-help` — use when the label is wrapped in a `<CustomTooltip>`
   * so the whole label surfaces a hint on hover.
   */
  help?: boolean;
}

/**
 * The fixed-size uppercase label above a form field in the lore/script editors.
 *
 * NOTE: this is intentionally distinct from `lblCls` in `field-styles.ts`, which
 * is the *fluid*-size (`text-[calc(var(--ui-fs)-3px)]`) label used by the
 * CharacterForm field components (TextAreaField, TagsField, …). The two share
 * `uppercase tracking-[0.05em] text-t3` but differ in font-size, spacing, and
 * line-height — they are separate designs and are NOT unified here, because
 * folding them together would silently change the visuals of one or both.
 *
 * Extracted from the 17 identical inline labels in `LoreEntryEditor`
 * (frontend-reuse-and-extraction.md §2.3).
 */
export function FieldLabel({ children, help }: FieldLabelProps) {
  return (
    <label className={cn(FIELD_LABEL_CLASS, help && "cursor-help")}>
      {children}
    </label>
  );
}
