/**
 * DragHandle + DragHandleContext — the dnd-kit drag activator used by every
 * canvas row card (PromptOrderMarker, EditablePromptCard, EditableAuthorNoteCard,
 * CharacterFieldCard, InjectionRowView) and provided by `SortableCanvasItem`
 * (still in `InjectionTable.tsx`).
 *
 * Extracted to its own module so the row components (under `rows/`) can import
 * `DragHandle` as a value without creating a circular value-dependency back into
 * `InjectionTable.tsx` (which imports the row components to render them).
 * `InjectionTable.tsx` imports `DragHandleContext` from here for the
 * `SortableCanvasItem` provider.
 */
import { createContext, useContext } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";

export const DragHandleContext = createContext<{
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
} | null>(null);

export function DragHandle({ disabled }: { disabled?: boolean }) {
  const ctx = useContext(DragHandleContext);
  const { t } = useT();
  if (!ctx) return null;
  return (
    <button
      ref={disabled ? undefined : ctx.setActivatorNodeRef}
      type="button"
      className={cn(
        "flex h-5 w-5 shrink-0 select-none items-center justify-center rounded font-mono text-[13px] transition-colors sm:h-auto sm:w-5",
        disabled
          ? "opacity-30 cursor-not-allowed text-t4"
          : "cursor-grab touch-none text-t4 hover:bg-s2 hover:text-t2 active:cursor-grabbing"
      )}
      aria-label={t("drag_prompt_item_aria")}
      {...(disabled ? {} : ctx.attributes)}
      {...(disabled ? {} : ctx.listeners)}
    >
      ⋮⋮
    </button>
  );
}
