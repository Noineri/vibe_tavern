import type { ReactNode } from "react";
import { cn } from "../../../lib/cn.js";
import { rowTitleCls } from "../../../lib/field-tokens.js";

// forks: 0 — master-list primitive source: the drag-preview row. Same status
// cluster + wrapping title as the row, none of its interactivity.

export interface MasterListDragOverlayRowProps {
  status?: ReactNode;
  active?: boolean;
  title: ReactNode;
}

export function MasterListDragOverlayRow({ status, active = false, title }: MasterListDragOverlayRowProps) {
  return (
    <div className="flex min-h-[56px] items-center gap-2 border-l-[3px] border-l-transparent bg-s2 pr-2 pl-4">
      <span aria-hidden="true" className="text-[calc(var(--ui-fs)+2px)] leading-6 leading-none text-t4">
        ≡
      </span>
      {status || active ? (
        <span className="flex shrink-0 items-center gap-1.5">
          {status}
          {active ? <span aria-hidden="true">★</span> : null}
        </span>
      ) : null}
      <span className={cn(rowTitleCls, "min-w-0 break-words text-t1")}>{title}</span>
    </div>
  );
}
