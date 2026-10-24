import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";

// forks: 0 — master-list primitive source: the droppable flow slot. A list
// that accepts drops outside its rows (e.g. a regex standalone-drop target
// for detaching a member) renders this inside `renderDragSlot`, gated on the
// active drag item. Visibility is the consumer's call (return null from the
// slot); registration/unregistration follows the mount. The content render
// receives dnd-kit's isOver so the consumer can highlight its own look.

export interface MasterListDropSlotProps {
  droppableId: string;
  testId?: string;
  children: (isOver: boolean) => ReactNode;
}

export function MasterListDropSlot({ droppableId, testId, children }: MasterListDropSlotProps) {
  const { isOver, setNodeRef } = useDroppable({ id: droppableId });
  return (
    <div ref={setNodeRef} data-testid={testId}>
      {children(isOver)}
    </div>
  );
}
