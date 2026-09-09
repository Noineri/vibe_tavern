import React, { useEffect, useRef, useState, type CSSProperties } from "react";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { EmptyState } from "../../shared/empty-state.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { useMasterDetail, MasterDetailMobileDrillDown } from "../../shared/MasterDetailModal.js";
import { useReorderableList } from "../../../hooks/use-reorderable-list.js";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type PresetRef = { id: string; name: string };

interface PresetListProps {
  presets: PresetRef[];
  activePresetId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, newName: string) => void;
  /** Persist a manual reorder: each entry sets the listed id to the listed
   *  sort order. Driven by `useReorderableList` (optimistic + rollback). */
  onReorder: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  onImportPreset?: () => void;
}

// A single preset row, sortable via `useSortable`. The drag affordance is a
// dedicated `≡` grip handle on the left (mirrors LoreEntryList's mobile handle,
// applied uniformly here because the row already carries edit + drill-down
// buttons that would conflict with a whole-row activator). The rest of the row
// keeps click-to-select; DnD is suppressed while a search filter is active
// (reordering a filtered subset is ambiguous), via `dndDisabled`.
const SortablePresetRow = React.memo(({ p, isActive, onSelect, isMobile, startEditing, dndDisabled }: {
  p: PresetRef;
  isActive: boolean;
  onSelect: (id: string) => void;
  isMobile: boolean;
  startEditing: (preset: PresetRef, e: React.MouseEvent) => void;
  dndDisabled: boolean;
}) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: p.id,
    disabled: dndDisabled,
  });
  // The DragOverlay carries the visible preview; the source becomes an
  // invisible in-place placeholder while dragging (same trick as LoreEntryList).
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0 } : {}),
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      onPointerDown={() => onSelect(p.id)}
      className={cn(
        "group flex cursor-pointer items-center gap-2 border-l-2 min-h-[56px] px-4 sm:transition-colors touch-manipulation",
        isActive ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2"
      )}
    >
      {!dndDisabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="drag"
          onClick={(e) => e.stopPropagation()}
          className="flex h-8 w-7 shrink-0 select-none items-center justify-center rounded cursor-grab touch-none text-t4 transition-colors hover:bg-s2 hover:text-t1 active:cursor-grabbing sm:h-auto sm:w-5"
        >
          <span className="text-base leading-none">≡</span>
        </button>
      )}
      <div className={cn("h-[6px] w-[6px] shrink-0 rounded-full sm:transition-colors", isActive ? "bg-accent" : "bg-transparent")} />
      <CustomTooltip content={p.name}>
        <span className={cn("truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isActive ? "text-accent-t" : "text-t2")}>{p.name}</span>
      </CustomTooltip>
      <button type="button"
        onClick={(e) => startEditing(p, e)}
        className={cn("ml-1 shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
      ><Icons.Edit /></button>
      <div className="ml-auto flex items-center gap-1">
        <button type="button"
          onClick={(e) => startEditing(p, e)}
          className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Edit /></button>
        <MasterDetailMobileDrillDown onSelect={() => onSelect(p.id)} className="py-1" />
      </div>
    </div>
  );
}, (prev, next) =>
  prev.isActive === next.isActive &&
  prev.p.id === next.p.id &&
  prev.p.name === next.p.name &&
  prev.dndDisabled === next.dndDisabled);

export function PresetList({ presets, activePresetId, onSelect, onAdd, onRename, onReorder, onImportPreset }: PresetListProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const { openDetail } = useMasterDetail();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editingId) editInputRef.current?.focus(); }, [editingId]);
  useEffect(() => { if (isCreating) newInputRef.current?.focus(); }, [isCreating]);

  // Suppress DnD while a search filter is active — reordering a filtered subset
  // is ambiguous (indices no longer map to the full-list sort order).
  const dndDisabled = search.trim().length > 0;

  const {
    displayItems,
    sensors,
    activeDragItem: activeDragPreset,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useReorderableList<PresetRef>({
    items: presets,
    getId: (p) => p.id,
    onReorder: (activeId, overId, currentItems) => {
      const fromIdx = currentItems.findIndex((p) => p.id === activeId);
      const toIdx = currentItems.findIndex((p) => p.id === overId);
      if (fromIdx === -1 || toIdx === -1) {
        return { optimisticItems: currentItems, persist: () => {} };
      }
      const reordered = arrayMove(currentItems, fromIdx, toIdx);
      return {
        optimisticItems: reordered,
        persist: () => onReorder(reordered.map((p, i) => ({ id: p.id, sortOrder: i }))),
      };
    },
  });

  // Derive the filtered view from the hook's displayItems (not the raw prop) so
  // an in-flight optimistic reorder is reflected immediately. When no search is
  // active, displayItems is the full ordered list.
  const filtered = search.trim()
    ? displayItems.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : displayItems;
  // Exclude the row being renamed from the sortable id set — its rendered form
  // is a plain input, not a useSortable consumer, so registering its id would
  // leave a dangling sortable reference.
  const sortableIds = filtered.filter((p) => p.id !== editingId).map((p) => p.id);

  const startEditing = (preset: PresetRef, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(preset.id);
    setEditName(preset.name);
  };

  const saveEdit = () => {
    if (editingId && editName.trim()) onRename(editingId, editName.trim());
    setEditingId(null);
    setEditName("");
  };

  const saveNew = () => {
    if (newName.trim()) onAdd(newName.trim());
    setIsCreating(false);
    setNewName("");
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveEdit();
    if (e.key === "Escape") { setEditingId(null); setEditName(""); }
  };

  const handleNewKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveNew();
    if (e.key === "Escape") { setIsCreating(false); setNewName(""); }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 py-2.5">
      <div className="shrink-0 px-[13px]">
        <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3 pt-1 pb-[5px]">
          {t("presets")}
        </div>
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-s2 px-[9px] py-1.5">
          <Icons.Search />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4"
            placeholder={t("search_presets")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 && !isCreating ? (
              <div className="flex h-full items-center justify-center px-2">
                <EmptyState
                  icon={<Icons.Terminal />}
                  title={presets.length === 0 ? t("no_presets") : t("no_preset_matches")}
                  sub={presets.length === 0 ? t("no_presets_sub") : t("no_preset_matches_sub")}
                />
              </div>
            ) : filtered.map((p) => {
              const isActive = activePresetId === p.id;
              const isEditing = editingId === p.id;

              if (isEditing) {
                return (
                  <div key={p.id} className="border-l-2 border-transparent px-3 py-2">
                    <div className="relative flex items-center">
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={saveEdit}
                        className="w-full rounded border border-accent bg-surface px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none"
                      />
                      <button type="button"
                        onMouseDown={(e) => { e.preventDefault(); saveEdit(); }}
                        className="absolute right-2 text-success transition-colors hover:text-green-400"
                      >
                        <Icons.Check />
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <SortablePresetRow
                  key={p.id}
                  p={p}
                  isActive={isActive}
                  onSelect={onSelect}
                  isMobile={isMobile}
                  startEditing={startEditing}
                  dndDisabled={dndDisabled}
                />
              );
            })}

            {isCreating && (
              <div className="border-l-2 border-transparent px-3 py-2">
                <div className="relative flex items-center">
                  <input
                    ref={newInputRef}
                    type="text"
                    placeholder={t("new_preset_name_placeholder")}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={handleNewKeyDown}
                    onBlur={() => { if (!newName.trim()) setIsCreating(false); else saveNew(); }}
                    className="w-full rounded border border-border bg-s2 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none focus:border-border2"
                  />
                  <button type="button"
                    onMouseDown={(e) => { e.preventDefault(); saveNew(); }}
                    className="absolute right-2 text-success transition-colors hover:text-green-400"
                  >
                    <Icons.Check />
                  </button>
                </div>
              </div>
            )}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeDragPreset ? (
            <div
              className={cn(
                "flex items-center gap-2 border-l-2 min-h-[56px] px-4",
                activeDragPreset.id === activePresetId ? "border-l-accent bg-accent-dim" : "border-l-transparent bg-s2"
              )}
            >
              <span className="text-base leading-none text-t4">≡</span>
              <span className="truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t1">{activeDragPreset.name}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="shrink-0 border-t border-border px-3 pt-3">
        <button type="button"
          onClick={() => setIsCreating(true)}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
        >
          <Icons.Plus /> {t("new_preset_btn")}
        </button>
        {onImportPreset && (
          <button
            onClick={onImportPreset}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
            type="button"
          >
            <Icons.Import /> {t("import_preset_btn")}
          </button>
        )}
      </div>
    </div>
  );
}
