import React, { useEffect, useRef, useState, type CSSProperties } from "react";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { EmptyState } from "../../shared/empty-state.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { MasterDetailMobileDrillDown } from "../../shared/MasterDetailModal.js";
import { useReorderableList } from "../../../hooks/use-reorderable-list.js";
import { DndContext, DragOverlay, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RegexPresetRecord } from "../../../api/types.js";

type RegexPresetRef = {
  id: string;
  name: string;
  disabled: boolean;
  /** R-7 single-badge model: why this preset currently applies in NO chat
   *  (tooltip carries the reason). null = in effect somewhere. Computed by
   *  the parent (needs link counts for the unbound case). */
  notApplied: "disabled" | "unbound" | null;
};

interface RegexPresetListProps {
  presets: RegexPresetRef[];
  activePresetId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, newName: string) => void;
  /** Duplicate a preset in place (R-12): parent clones + seeds the copy
   *  disabled (import-parity security gate). */
  onCopy: (id: string) => void;
  /** Export a preset to a standalone ST JSON download (R-12). */
  onExport: (id: string) => void;
  /** Persist a manual reorder: each entry sets the listed id to the listed
   *  sort order. Driven by `useReorderableList` (optimistic + rollback). */
  onReorder: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  /** RX-16 UI surface: import standalone ST regex JSON. */
  onImportRegex?: () => void;
}

// A single regex-preset row, sortable via `useSortable`. Mirrors
// PresetList's SortablePresetRow (≡ grip, active dot, hover edit, mobile
// drill-down) and adds disabled-dim styling so a disabled preset reads at a
// glance.
const SortableRegexPresetRow = React.memo(({ p, isActive, onSelect, isMobile, startEditing, onCopy, onExport, dndDisabled }: {
  p: RegexPresetRef;
  isActive: boolean;
  onSelect: (id: string) => void;
  isMobile: boolean;
  startEditing: (preset: RegexPresetRef, e: React.MouseEvent) => void;
  onCopy: (id: string) => void;
  onExport: (id: string) => void;
  dndDisabled: boolean;
}) => {
  const { t } = useT();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: p.id,
    disabled: dndDisabled,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0 } : {}),
  };
  // R-7 owner follow-up: status dot instead of a text badge (the badge
  // overlapped names). green = applies, red = enabled but unbound, gray =
  // disabled; the reason rides in the tooltip.
  const statusKey = p.notApplied === "disabled"
    ? "promptManager.regex.badgeDisabledReason"
    : p.notApplied === "unbound" ? "promptManager.regex.badgeUnboundReason"
    : "promptManager.regex.badgeWorking";
  const statusDotCls = p.notApplied === "disabled" ? "bg-t4"
    : p.notApplied === "unbound" ? "bg-danger"
    : "bg-success";
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
          className="shrink-0 cursor-grab touch-none text-t4 transition-colors hover:text-t1 active:cursor-grabbing"
        >
          <span className="text-base leading-none">≡</span>
        </button>
      )}
      <div className={cn("h-[6px] w-[6px] shrink-0 rounded-full sm:transition-colors", isActive ? "bg-accent" : "bg-transparent")} />
      <CustomTooltip content={p.name}>
        <span className={cn(
          "truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium",
          isActive ? "text-accent-t" : "text-t2",
          p.disabled && "opacity-50",
        )}>{p.name}</span>
      </CustomTooltip>
      <button type="button"
        onClick={(e) => startEditing(p, e)}
        className={cn("ml-1 shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
      ><Icons.Edit /></button>
      <CustomTooltip content={t("promptManager.regex.copy")}>
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onCopy(p.id); }}
          aria-label={t("promptManager.regex.copy")}
          className={cn("shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Copy /></button>
      </CustomTooltip>
      <CustomTooltip content={t("promptManager.regex.export")}>
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onExport(p.id); }}
          aria-label={t("promptManager.regex.export")}
          className={cn("shrink-0 transition-colors md:hidden", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Download /></button>
      </CustomTooltip>
      <div className="ml-auto flex items-center gap-1">
        <CustomTooltip content={t(statusKey)}>
          <span role="img" aria-label={t(statusKey)} className="flex shrink-0 p-1">
            <span className={cn("h-[6px] w-[6px] rounded-full", statusDotCls)} />
          </span>
        </CustomTooltip>
        <button type="button"
          onClick={(e) => startEditing(p, e)}
          className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Edit /></button>
        <CustomTooltip content={t("promptManager.regex.copy")}>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onCopy(p.id); }}
            aria-label={t("promptManager.regex.copy")}
            className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
          ><Icons.Copy /></button>
        </CustomTooltip>
        <CustomTooltip content={t("promptManager.regex.export")}>
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onExport(p.id); }}
            aria-label={t("promptManager.regex.export")}
            className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hidden md:flex", isActive ? "text-accent" : "text-t4 hover:text-t1")}
          ><Icons.Download /></button>
        </CustomTooltip>
        <MasterDetailMobileDrillDown onSelect={() => onSelect(p.id)} className="py-1" />
      </div>
    </div>
  );
}, (prev, next) =>
  prev.isActive === next.isActive &&
  prev.p.id === next.p.id &&
  prev.p.name === next.p.name &&
  prev.p.disabled === next.p.disabled &&
  prev.p.notApplied === next.p.notApplied &&
  prev.dndDisabled === next.dndDisabled);

/**
 * Master list of regex presets — mirrors PresetList's structure (section
 * label, search, dnd-kit sortable rows, inline rename, EmptyState, bottom-
 * docked dashed "+ New") with the regex-specific disabled dimming.
 */
export function RegexPresetList({ presets, activePresetId, onSelect, onAdd, onRename, onReorder, onCopy, onExport, onImportRegex }: RegexPresetListProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editingId) editInputRef.current?.focus(); }, [editingId]);
  useEffect(() => { if (isCreating) newInputRef.current?.focus(); }, [isCreating]);

  // Suppress DnD while a search filter is active — reordering a filtered
  // subset is ambiguous (same rule as PresetList).
  const dndDisabled = search.trim().length > 0;

  const {
    displayItems,
    sensors,
    activeDragItem: activeDragPreset,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useReorderableList<RegexPresetRef>({
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

  const filtered = search.trim()
    ? displayItems.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : displayItems;
  // Exclude the row being renamed from the sortable id set — its rendered form
  // is a plain input, not a useSortable consumer.
  const sortableIds = filtered.filter((p) => p.id !== editingId).map((p) => p.id);

  const startEditing = (preset: RegexPresetRef, e: React.MouseEvent) => {
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
          {t("promptManager.regex.tabLabel")}
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
                  title={presets.length === 0 ? t("promptManager.regex.emptyTitle") : t("no_preset_matches")}
                  sub={presets.length === 0 ? t("promptManager.regex.emptySub") : t("no_preset_matches_sub")}
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
                <SortableRegexPresetRow
                  key={p.id}
                  p={p}
                  isActive={isActive}
                  onSelect={onSelect}
                  isMobile={isMobile}
                  startEditing={startEditing}
                  onCopy={onCopy}
                  onExport={onExport}
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
                    placeholder={t("promptManager.regex.newNamePlaceholder")}
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
          <Icons.Plus />
          {t("promptManager.regex.newPreset")}
        </button>
        {onImportRegex && (
          <button type="button"
            onClick={onImportRegex}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
          >
            <Icons.Import />
            {t("promptManager.regex.importButton")}
          </button>
        )}
      </div>
    </div>
  );
}
