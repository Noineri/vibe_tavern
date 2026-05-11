import React, { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { EmptyState } from "../shared/empty-state.js";
import { useT } from "../../i18n/context.js";

interface PresetListProps {
  presets: Array<{ id: string; name: string }>;
  activePresetId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, newName: string) => void;
}

export function PresetList({ presets, activePresetId, onSelect, onAdd, onRename }: PresetListProps) {
  const { t } = useT();
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
    <div className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface" style={{ padding: "10px 0" }}>
      <div className="shrink-0" style={{ padding: "0 13px" }}>
        <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3" style={{ padding: "4px 0 5px" }}>
          {t("presets")}
        </div>
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-s2" style={{ padding: "6px 9px" }} title={t("search_presets")}>
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
          <div className="flex h-full items-center justify-center" style={{ padding: "0 8px" }}>
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
              <div key={p.id} className="border-l-2 border-transparent" style={{ padding: "8px 12px" }}>
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
                  <button
                    onMouseDown={(e) => { e.preventDefault(); saveEdit(); }}
                    className="absolute right-2 text-success transition-colors hover:text-green-400"
                    type="button"
                  >
                    <Icons.Check />
                  </button>
                </div>
              </div>
            );
          }

          return (
            <div
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={cn(
                "group flex cursor-pointer items-center justify-between border-l-2 transition-colors",
                isActive ? "border-l-accent bg-accent-dim" : "border-l-transparent hover:bg-s2"
              )}
              style={{ padding: "10px 16px" }}
            >
              <span className={cn("truncate pr-2 font-ui text-[calc(var(--ui-fs)-2px)] font-medium", isActive ? "text-accent-t" : "text-t2")} title={p.name}>
                {p.name}
              </span>
              <button
                onClick={(e) => startEditing(p, e)}
                className={cn("shrink-0 opacity-0 transition-opacity group-hover:opacity-100", isActive ? "text-accent" : "text-t4 hover:text-t1")}
                type="button"
                title={t("rename")}
              >
                <Icons.Edit />
              </button>
            </div>
          );
        })}

        {isCreating && (
          <div className="border-l-2 border-transparent" style={{ padding: "8px 12px" }}>
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
              <button
                onMouseDown={(e) => { e.preventDefault(); saveNew(); }}
                className="absolute right-2 text-success transition-colors hover:text-green-400"
                type="button"
              >
                <Icons.Check />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border" style={{ padding: "12px 12px 0" }}>
        <button
          onClick={() => setIsCreating(true)}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1"
          type="button"
        >
          <Icons.Plus /> {t("new_preset_btn")}
        </button>
      </div>
    </div>
  );
}
