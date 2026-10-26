import type { ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
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
  /** SortableContext registration override (default: the rendered ids).
   *  A list excludes transiently non-sortable rows here (e.g. the row under
   *  inline rename, which renders an input instead of a sortable). */
  sortableIds?: string[];
  /** Extra consumer hook into drag start (runs before the default reorder
   *  start — e.g. a profile list collapsing the dragged profile). */
  onDragStartExtra?: (event: DragStartEvent) => void;
  /** DndContext.onDragOver passthrough (e.g. a standalone-drop slot
   *  tracking the pointer to highlight its target). */
  onDragOver?: (event: DragOverEvent) => void;
  /** Extra consumer hook into drag cancel (runs after the default cancel). */
  onDragCancelExtra?: () => void;
  /** Flow slot rendered first inside the scroll container (inside
   *  DndContext, so it may host a droppable). Receives the active drag
   *  item — e.g. a standalone-drop target visible only while a member
   *  row is dragged. Null/absent renders nothing. */
  renderDragSlot?: (activeItem: T | null) => ReactNode;
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
  /** Drag-preview content — compose with `MasterListDragOverlayRow`.
   *  When absent, no drag preview renders during a drag. */
  renderOverlayRow?: (item: T) => ReactNode;
}

export function MasterList<T>({
  items,
  getId,
  onReorderItems,
  dragDisabled = false,
  sortableIds,
  onDragStartExtra,
  onDragOver,
  onDragCancelExtra,
  renderDragSlot,
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
        onDragStart={(event) => {
          onDragStartExtra?.(event);
          handleDragStart(event);
        }}
        onDragOver={onDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          handleDragCancel();
          onDragCancelExtra?.();
        }}
      >
        <SortableContext items={sortableIds ?? rendered.map((item) => getId(item))} strategy={verticalListSortingStrategy}>
          <div className="flex-1 overflow-y-auto">
            {renderDragSlot ? renderDragSlot(activeDragItem) : null}
            {rendered.length === 0 && emptyState
              ? emptyState
              : rendered.map((item) => <div key={getId(item)}>{renderRow(item)}</div>)}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeDragItem && renderOverlayRow ? renderOverlayRow(activeDragItem) : null}
        </DragOverlay>
      </DndContext>
      {footer}
    </div>
  );
}

export type { ReorderResult };
