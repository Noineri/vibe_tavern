import type { ReactNode } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  useReorderableList,
  type ReorderResult,
} from "../../../hooks/use-reorderable-list.js";

// forks: 0 — master-list primitive source: the sortable master column
// (header slot, search slot, sortable container, empty-state slot, footer
// slot). Drag mechanics stay in `useReorderableList`; this component only
// owns the shell. Row chrome lives in `master-list-row.js`.

export interface MasterListProps<T> {
  /** Full (unfiltered) list — the reorder hook's source of truth. */
  items: T[];
  getId: (item: T) => string;
  /** What `onReorderItems` returns: the optimistic array plus the commit.
   *  Rejection rolls back to the committed order (owned by the hook). */
  onReorderItems: (activeId: string, overId: string, displayItems: T[]) => ReorderResult<T>;
  /** Disables every handle (e.g. while searching); rows stay selectable. */
  dragDisabled?: boolean;
  /** Rendered subset while filtering (e.g. search results); defaults to the
   *  hook's display items (which reflect optimistic reorder). */
  visibleItems?: T[];
  /** List header slot (section label). */
  header?: ReactNode;
  /** Search-field slot. */
  search?: ReactNode;
  /** Shown when the rendered list is empty. */
  emptyState?: ReactNode;
  /** Bottom-docked slot ("+ New", import, …). */
  footer?: ReactNode;
  /** One row per item — `SortableMasterListRow`, a pinned `MasterListRow`,
   *  or the phone variants. The list keys rows by `getId`. */
  renderRow: (item: T) => ReactNode;
  /** Drag-preview content — compose with `MasterListDragOverlayRow`. */
  renderOverlayRow?: (item: T) => ReactNode;
}

export function MasterList<T>({
  items,
  getId,
  onReorderItems,
  dragDisabled = false,
  visibleItems,
  header,
  search,
  emptyState,
  footer,
  renderRow,
  renderOverlayRow,
}: MasterListProps<T>) {
  const {
    displayItems,
    sensors,
    activeDragItem,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useReorderableList<T>({
    items,
    getId,
    onReorder: onReorderItems,
  });

  const rendered = visibleItems ?? displayItems;

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-5 pb-2.5">
      {header}
      {search}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={rendered.map((item) => getId(item))} strategy={verticalListSortingStrategy}>
          <div className="flex-1 overflow-y-auto">
            {rendered.length === 0 && emptyState
              ? emptyState
              : rendered.map((item) => <div key={getId(item)}>{renderRow(item)}</div>)}
          </div>
        </SortableContext>
      </DndContext>
      {footer}
    </div>
  );
}

export type { ReorderResult };
