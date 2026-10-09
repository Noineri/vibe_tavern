import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

const ADD_BUTTON_CLASS =
  "flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent";

interface AddButtonProps {
  onClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
  /** Extra classes appended after the canonical ones (e.g. "justify-center"). */
  className?: string;
}

/**
 * Dashed "+ Add"-style action button used across the build editors
 * (LorebookEditor, ScriptEditor, LorebookAccordion). Collapses the 8 identical
 * className strings that had drifted into near-miss variants elsewhere
 * (CharacterForm/CreateCharacterModal/SetupWizard use bg-s2 + text-accent-t and
 * are intentionally NOT migrated — different visual).
 *
 * Children carry the icon + label, e.g. `<AddButton onClick={handleAdd}><Ic.plus /> {t("new")}</AddButton>`.
 */
export function AddButton({ onClick, children, className }: AddButtonProps) {
  return (
    <button type="button" className={cn(ADD_BUTTON_CLASS, className)} onClick={onClick}>
      {children}
    </button>
  );
}
