/**
 * DragHandle + DragHandleContext — the dnd-kit drag activator used by every
 * `CanvasCard` row and provided by `SortableCanvasItem`
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
import { Ic } from "../../shared/icons.js";

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
        "flex h-8 w-7 shrink-0 select-none items-center justify-center rounded transition-colors sm:h-auto sm:w-5 [&_svg]:h-[18px] [&_svg]:w-[18px] sm:[&_svg]:h-[13px] sm:[&_svg]:w-[13px]",
        disabled
          ? "opacity-30 cursor-not-allowed text-t4"
          : "cursor-grab touch-none text-t4 hover:bg-s2 hover:text-t2 active:cursor-grabbing"
      )}
      aria-label={t("drag_prompt_item_aria")}
      {...(disabled ? {} : ctx.attributes)}
      {...(disabled ? {} : ctx.listeners)}
    >
      {Ic.grip()}
    </button>
  );
}
