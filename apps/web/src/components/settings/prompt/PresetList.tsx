import React, { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { cn } from "../../../lib/cn.js";
import { listHeaderCls } from "../../../lib/field-tokens.js";
import { Icons } from "../../shared/icons.js";
import { SearchInput } from "../../shared/SearchInput.js";
import { InlineRenameInput } from "../../shared/InlineRenameInput.js";
import { EmptyState } from "../../shared/empty-state.js";
import { useT } from "../../../i18n/context.js";
import { MasterDetailMobileDrillDown } from "../../shared/MasterDetailModal.js";
import { MasterList } from "../../shared/master-list/master-list.js";
import { MasterListRow } from "../../shared/master-list/master-list-row.js";
import { SortableMasterListPhoneRow } from "../../shared/master-list/master-list-phone-row.js";
import { MasterListDragOverlayRow } from "../../shared/master-list/master-list-overlay-row.js";
import { arrayMove } from "@dnd-kit/sortable";

type PresetRef = { id: string; name: string };

interface PresetListProps {
  presets: PresetRef[];
  activePresetId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, newName: string) => void;
  /** Persist a manual reorder: each entry sets the listed id to the listed
   *  sort order. Driven by the primitive's reorder hook (optimistic + rollback). */
  onReorder: (updates: Array<{ id: string; sortOrder: number }>) => void | Promise<unknown>;
  onImportPreset?: (file?: File) => void;
}

// Row anatomy lives in `shared/master-list` (handle, status slot, wrapping
// title, rename slot, overlay, phone drill-down row). This list supplies data
// + slots: the rename editor (ML-2 proves the primitive's `rename` slot — it
// replaces title + second line while active), the in-place create input, the
// desktop hover / mobile edit buttons in trailing, and the ★ for the active
// preset in the status slot (row rules: «in use» is a marker, never a
// whole-row color — the accent background is the primitive's selected look).
export function PresetList({ presets, activePresetId, onSelect, onAdd, onRename, onReorder, onImportPreset }: PresetListProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editingId) editInputRef.current?.focus(); }, [editingId]);
  useEffect(() => { if (isCreating) newInputRef.current?.focus(); }, [isCreating]);

  // Suppress DnD while a search filter is active — reordering a filtered subset
  // is ambiguous (indices no longer map to the full-list sort order).
  const dndDisabled = search.trim().length > 0;

  // Derive the filtered view from the committed prop (the primitive's hook
  // owns the optimistic order internally; while searching, handles are off
  // and no reorder can be in flight — same contract as ProviderProfileList).
  const filtered = search.trim()
    ? presets.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : presets;
  // Exclude the row being renamed from the sortable id set — its rendered form
  // is a plain input, not a sortable, so registering its id would leave a
  // dangling sortable reference.
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

  const handleImportPreset = () => {
    if (isMobile) importFileRef.current?.click();
    else onImportPreset?.();
  };

  const renderRenameEditor = (
    value: string,
    onChange: (value: string) => void,
    onKeyDown: (e: React.KeyboardEvent) => void,
    onCommit: () => void,
    inputRef: React.RefObject<HTMLInputElement | null>,
    placeholder?: string,
  ) => (
    <div className="relative flex items-center">
      <InlineRenameInput
        ref={inputRef}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onCommit}
      />
      <button type="button"
        onMouseDown={(e) => { e.preventDefault(); onCommit(); }}
        className="absolute right-2 text-success transition-colors hover:text-green-400"
      >
        <Icons.Check />
      </button>
    </div>
  );

  return (
    <MasterList<PresetRef>
      items={presets}
      getId={(p) => p.id}
      dragDisabled={dndDisabled}
      sortableIds={sortableIds}
      visibleItems={dndDisabled ? filtered : undefined}
      onReorderItems={(activeId, overId, currentItems) => {
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
      }}
      header={
        <div className="shrink-0 px-[13px]">
          <div className={cn(listHeaderCls, "pt-1 pb-[5px]")}>
            {t("presets")}
          </div>
        </div>
      }
      search={
        <div className="shrink-0 px-[13px]">
          <SearchInput
            className="mb-2"
            placeholder={t("search_presets")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      }
      emptyState={
        filtered.length === 0 && !isCreating ? (
          <div className="flex h-full items-center justify-center px-2">
            <EmptyState
              icon={<Icons.Terminal />}
              title={presets.length === 0 ? t("no_presets") : t("no_preset_matches")}
              sub={presets.length === 0 ? t("no_presets_sub") : t("no_preset_matches_sub")}
            />
          </div>
        ) : undefined
      }
      renderRow={(p) => {
        const isActive = activePresetId === p.id;
        if (editingId === p.id) {
          return (
            <MasterListRow
              rename={renderRenameEditor(editName, setEditName, handleEditKeyDown, saveEdit, editInputRef)}
            />
          );
        }
        return (
          <SortableMasterListPhoneRow
            sortableId={p.id}
            dragDisabled={dndDisabled}
            selected={isActive}
            active={isActive}
            title={p.name}
            onSelect={() => onSelect(p.id)}
            trailing={
              <>
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
              </>
            }
          />
        );
      }}
      renderOverlayRow={(preset) => (
        <MasterListDragOverlayRow active={preset.id === activePresetId} title={preset.name} />
      )}
      footer={
        <div className="shrink-0 border-t border-border px-3 pt-3">
          {isCreating ? (
            renderRenameEditor(
              newName,
              setNewName,
              handleNewKeyDown,
              () => { if (!newName.trim()) setIsCreating(false); else saveNew(); },
              newInputRef,
              t("new_preset_name_placeholder"),
            )
          ) : (
            <button type="button"
              onClick={() => setIsCreating(true)}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
            >
              <Icons.Plus /> {t("new_preset_btn")}
            </button>
          )}
          {onImportPreset && (
            <>
              <input
                ref={importFileRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) onImportPreset(file);
                }}
              />
              <button
                onClick={handleImportPreset}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
                type="button"
              >
                <Icons.Import /> {t("import_preset_btn")}
              </button>
            </>
          )}
        </div>
      }
    />
  );
}
