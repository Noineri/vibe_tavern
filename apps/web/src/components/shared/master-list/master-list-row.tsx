import type { CSSProperties, ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../../../lib/cn.js";
import { rowSecondCls, rowTitleCls } from "../../../lib/field-tokens.js";

// forks: 0 — master-list primitive source: the row every master-detail list
// renders (handle, status slot, wrapping title, second line, rename slot,
// trailing slot, selection look). Consumers supply data + slots, never classes.

/** Drag-handle wiring for one row: the ONLY element that starts a reorder.
 *  Built by `SortableMasterListRow` from `useSortable`; a row without a
 *  handle (pinned or drag-disabled) never starts a drag — tapping selects. */
export interface MasterListRowHandle {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  setActivatorNodeRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
}

export interface MasterListRowProps {
  /** Row title. WRAPS onto a second line when long — never ellipsized
   *  (authored names are UI copy; UI copy is never truncated). Optional:
   *  the inline-rename editor slot replaces title + second line while active. */
  title?: ReactNode;
  /** Selected row (open in the detail pane): accent left border + tint. */
  selected?: boolean;
  /** «In use» marker (the active profile / preset): a ★ in the status
   *  cluster, never a whole-row color. */
  active?: boolean;
  /** Status-marker slot (connection dot, built-in/user badge, …). */
  status?: ReactNode;
  /** Optional second line under the title (provider label, backend, …). */
  secondLine?: ReactNode;
  /** Inline-rename editor slot: when present it replaces title + second line. */
  rename?: ReactNode;
  /** Trailing slot (context actions, drill-down caret, …). */
  trailing?: ReactNode;
  /** Tap / pointer-down selects the row. Drag starts from the handle only. */
  onSelect?: () => void;
  /** Drag handle wiring, or null/undefined for a handle-less (pinned) row. */
  handle?: MasterListRowHandle | null;
  /** Sortable node ref + drag transform, set by `SortableMasterListRow`. */
  rowRef?: ReturnType<typeof useSortable>["setNodeRef"];
  style?: CSSProperties;
  rowTestId?: string;
  /** Rendered as `data-*` attributes (e.g. `{ "profile-id": id }`). */
  dataAttributes?: Record<string, string>;
}

export function MasterListRow({
  selected = false,
  active = false,
  status,
  title,
  secondLine,
  rename,
  trailing,
  onSelect,
  handle,
  rowRef,
  style,
  rowTestId,
  dataAttributes,
}: MasterListRowProps) {
  const dataAttrs = Object.fromEntries(
    Object.entries(dataAttributes ?? {}).map(([key, value]) => [`data-${key}`, value]),
  );
  return (
    <div
      ref={rowRef}
      style={style}
      data-testid={rowTestId}
      {...dataAttrs}
      className={cn(
        // `group` enables consumer trailing actions that reveal on row hover
        // (e.g. a preset list's desktop rename button) — inert otherwise.
        "group flex min-h-[56px] cursor-pointer touch-manipulation items-center border-l-[3px] pr-2 pl-4 transition-colors active:bg-s2",
        selected
          ? "border-l-accent bg-accent-dim text-accent-t"
          : "border-l-transparent text-t2 hover:bg-s2",
      )}
      onPointerDown={onSelect ? () => onSelect() : undefined}
    >
      {handle ? (
        <button
          type="button"
          ref={handle.setActivatorNodeRef}
          {...handle.attributes}
          {...handle.listeners}
          aria-label="drag"
          onClick={(e) => e.stopPropagation()}
          className="mr-1 flex h-8 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-t4 transition-colors select-none hover:bg-s2 hover:text-t1 active:cursor-grabbing sm:h-auto sm:w-5"
        >
          <span className="text-[calc(var(--ui-fs)+2px)] leading-6 leading-none">≡</span>
        </button>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {status || active ? (
          <span className="flex shrink-0 items-center gap-1.5">
            {status}
            {active ? <span aria-hidden="true">★</span> : null}
          </span>
        ) : null}
        <div className="min-w-0 flex-1 py-2">
          {rename ?? (
            <>
              <div className={cn(rowTitleCls, "min-w-0 break-words")}>{title}</div>
              {secondLine ? (
                <div className={cn(rowSecondCls, "mt-0.5", selected ? "text-accent-t" : "text-t4")}>
                  {secondLine}
                </div>
              ) : null}
            </>
          )}
        </div>
        {trailing}
      </div>
    </div>
  );
}

export interface SortableMasterListRowProps extends MasterListRowProps {
  sortableId: string;
  dragDisabled?: boolean;
}

/** Sortable row: the ≡ handle is the ONLY drag activator — tapping the row
 *  selects. `dragDisabled` (or a plain `MasterListRow` with no handle, i.e.
 *  a pinned row) renders no handle at all. */
export function SortableMasterListRow({
  sortableId,
  dragDisabled = false,
  handle: _ignored,
  rowRef: _ignoredRef,
  style: _ignoredStyle,
  ...rowProps
}: SortableMasterListRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId, disabled: dragDisabled });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0 } : {}),
  };
  return (
    <MasterListRow
      {...rowProps}
      rowRef={setNodeRef}
      style={style}
      handle={dragDisabled ? null : { attributes, listeners, setActivatorNodeRef }}
    />
  );
}
