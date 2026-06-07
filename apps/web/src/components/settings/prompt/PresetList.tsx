import React, { useEffect, useRef, useState } from "react";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { EmptyState } from "../../shared/empty-state.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";

interface PresetListProps {
  presets: Array<{ id: string; name: string }>;
  activePresetId: string | null;
  onSelect: (id: string) => void;
  onDrillDown?: (id: string) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, newName: string) => void;
  onImportPreset?: () => void;
}

const PresetRow = React.memo(({ p, isActive, onSelect, isMobile, onDrillDown, startEditing }: {
  p: { id: string; name: string };
  isActive: boolean;
  onSelect: (id: string) => void;
  isMobile: boolean;
  onDrillDown?: (id: string) => void;
  startEditing: (preset: { id: string; name: string }, e: React.MouseEvent) => void;
}) => {
  return (
    <div
      onPointerDown={() => onSelect(p.id)}
      className={cn(
        "group flex cursor-pointer items-center gap-2 border-l-2 min-h-[56px] px-4 sm:transition-colors touch-manipulation",
        isActive ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2"
      )}
    >
      <div className={cn("h-[6px] w-[6px] shrink-0 rounded-full sm:transition-colors", isActive ? "bg-accent" : "bg-transparent")} />
      {isMobile ? (
        <span className={cn("truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isActive ? "text-accent-t" : "text-t2")}>{p.name}</span>
      ) : (
        <CustomTooltip content={p.name}>
          <span className={cn("truncate font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isActive ? "text-accent-t" : "text-t2")}>{p.name}</span>
        </CustomTooltip>
      )}
      {isMobile && (
        <button type="button"
          onClick={(e) => startEditing(p, e)}
          className={cn("ml-1 shrink-0 transition-colors", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Edit /></button>
      )}
      <div className="ml-auto flex items-center gap-1">
        {!isMobile && (
        <button type="button"
          onClick={(e) => startEditing(p, e)}
          className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100", isActive ? "text-accent" : "text-t4 hover:text-t1")}
        ><Icons.Edit /></button>
        )}
        {onDrillDown && (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onDrillDown(p.id); }}
          className="shrink-0 px-2 py-1 text-t3 transition-colors hover:text-t1"
        ><Icons.Caret direction="r" /></button>
        )}
      </div>
    </div>
  );
}, (prev, next) => prev.isActive === next.isActive && prev.p.id === next.p.id);

export function PresetList({ presets, activePresetId, onSelect, onDrillDown, onAdd, onRename, onImportPreset }: PresetListProps) {
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

  const filtered = search.trim()
    ? presets.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : presets;

  const startEditing = (preset: { id: string; name: string }, e: React.MouseEvent) => {
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
            <PresetRow
              key={p.id}
              p={p}
              isActive={isActive}
              onSelect={onSelect}
              isMobile={isMobile}
              onDrillDown={onDrillDown}
              startEditing={startEditing}
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
