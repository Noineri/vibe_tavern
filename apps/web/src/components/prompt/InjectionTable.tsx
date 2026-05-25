import { useState } from "react";
import { useT } from "../../i18n/context.js";

export interface InjectionRow {
  name: string;
  content: string;
  depth: number;
  role: "system" | "user" | "assistant";
  enabled: boolean;
}

interface InjectionTableProps {
  injections: InjectionRow[];
  onChange: (injections: InjectionRow[]) => void;
}

export function InjectionTable({ injections, onChange }: InjectionTableProps) {
  const { t } = useT();

  function update(index: number, patch: Partial<InjectionRow>) {
    const next = injections.map((inj, i) => i === index ? { ...inj, ...patch } : inj);
    onChange(next);
  }

  function remove(index: number) {
    onChange(injections.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...injections, { name: "", content: "", depth: 4, role: "system", enabled: true }]);
  }

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">
          {t("preset_injections_title")}
        </span>
        <button
          className="cursor-pointer rounded border border-border bg-s2 px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all hover:border-accent hover:text-accent-t"
          onClick={add}
        >
          + {t("preset_injection_add")}
        </button>
      </div>

      <div className="rounded-md border border-border2 overflow-hidden">
        {injections.length === 0 ? (
          <div className="px-3 py-4 text-center font-ui text-[11px] text-t4">
            {t("preset_injections_empty")}
          </div>
        ) : (
          injections.map((inj, i) => (
            <InjectionRowView
              key={i}
              injection={inj}
              index={i}
              onUpdate={update}
              onRemove={remove}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface InjectionRowViewProps {
  injection: InjectionRow;
  index: number;
  onUpdate: (index: number, patch: Partial<InjectionRow>) => void;
  onRemove: (index: number) => void;
}

function InjectionRowView({ injection, index, onUpdate, onRemove }: InjectionRowViewProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border2 last:border-b-0 bg-s2">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <input
          type="checkbox"
          className="h-3.5 w-3.5 cursor-pointer accent-accent"
          checked={injection.enabled}
          onChange={(e) => { e.stopPropagation(); onUpdate(index, { enabled: e.target.checked }); }}
        />
        <input
          className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4"
          value={injection.name}
          placeholder={t("preset_injection_name")}
          onChange={(e) => { e.stopPropagation(); onUpdate(index, { name: e.target.value }); }}
          onClick={(e) => e.stopPropagation()}
        />
        <input
          type="number"
          className="w-14 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={injection.depth}
          min={0}
          max={99}
          onChange={(e) => { e.stopPropagation(); onUpdate(index, { depth: Math.max(0, Number(e.target.value) || 0) }); }}
          onClick={(e) => e.stopPropagation()}
        />
        <select
          className="w-20 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t2 outline-none cursor-pointer"
          value={injection.role}
          onChange={(e) => { e.stopPropagation(); onUpdate(index, { role: e.target.value as InjectionRow["role"] }); }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="system">system</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
        </select>
        <span className="min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
          {injection.content || t("preset_injection_content_empty")}
        </span>
        <button
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:bg-danger-dim hover:text-danger"
          onClick={(e) => { e.stopPropagation(); onRemove(index); }}
          title={t("preset_injection_delete")}
        >
          ×
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-2.5">
          <textarea
            className="w-full min-h-[80px] rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[calc(var(--ui-fs)-2px)] text-t1 outline-none focus:border-accent resize-y"
            value={injection.content}
            placeholder={t("preset_injection_content")}
            onChange={(e) => onUpdate(index, { content: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
