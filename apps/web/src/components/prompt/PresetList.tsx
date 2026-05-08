import { useState } from "react";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { EmptyState } from "../shared/empty-state.js";

interface PresetListProps {
  presets: Array<{ id: string; name: string; bindModel: string }>;
  activePresetId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

export function PresetList({ presets, activePresetId, onSelect, onAdd }: PresetListProps) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? presets.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : presets;

  return (
    <div className="flex flex-col border-r border-border bg-surface" style={{ width: 180, padding: "10px 0" }}>
      <div
        className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3"
        style={{ padding: "4px 13px 5px" }}
      >
        Presets
      </div>
      <div
        className="flex items-center gap-1.5 rounded-md border border-border bg-s2"
        style={{ padding: "6px 9px", margin: "0 10px 6px" }}
      >
        <Icons.Search />
        <input
          className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4"
          placeholder="Search presets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px" }}>
          <EmptyState
            icon={<Icons.Terminal />}
            title={presets.length === 0 ? "No presets" : "No matches"}
            sub={presets.length === 0 ? "Create a preset to start configuring prompts." : "Try a different search."}
          />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.map((p) => (
            <div
              key={p.id}
              className={cn(
                "cursor-pointer overflow-hidden whitespace-nowrap border-l-[3px] text-ellipsis transition-colors hover:bg-s2",
                activePresetId === p.id
                  ? "border-l-accent bg-accent-dim text-accent-t"
                  : "border-l-transparent text-t2"
              )}
              onClick={() => onSelect(p.id)}
              style={{ padding: "8px 14px", fontSize: "12.5px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}
            >
              <span
                className="min-w-0 shrink cursor-default overflow-hidden text-ellipsis whitespace-nowrap"
                title={p.name}
              >
                {p.name}
              </span>
              <span
                className={cn(
                  "shrink-0 font-ui text-[9px] uppercase tracking-[0.04em]",
                  p.bindModel ? "text-t3" : "text-accent-t"
                )}
              >
                {p.bindModel ? `→ ${p.bindModel}` : "Global"}
              </span>
            </div>
          ))}
        </div>
      )}
      <div
        className="cursor-pointer border border-dashed border-border2 font-ui text-[calc(var(--ui-fs)-3px)] text-center text-t3 transition-all hover:border-border hover:text-t1"
        style={{ margin: "10px 14px", padding: 6 }}
        onClick={onAdd}
      >
        + New preset
      </div>
    </div>
  );
}
