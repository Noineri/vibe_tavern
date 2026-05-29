import { useState } from "react";
import { useT } from "../../i18n/context.js";
import { Ic } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { CustomTooltip } from "../shared/Tooltip.js";

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

const roleOptions = ["system", "user", "assistant"] as const;

export function InjectionTable({ injections, onChange }: InjectionTableProps) {
  const { t } = useT();

  function update(index: number, patch: Partial<InjectionRow>) {
    onChange(injections.map((inj, i) => i === index ? { ...inj, ...patch } : inj));
  }
  function remove(index: number) { onChange(injections.filter((_, i) => i !== index)); }
  function add() { onChange([...injections, { name: "", content: "", depth: 4, role: "system", enabled: true }]); }

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2">
        {injections.length === 0 ? (
          <span className="flex-1 font-ui text-[11px] text-t4">{t("preset_injections_empty")}</span>
        ) : (
          <span className="flex-1 font-ui text-[11px] text-t4">{injections.filter(i => i.enabled).length}/{injections.length} active</span>
        )}
        <button type="button"
          className="flex cursor-pointer items-center gap-1 rounded border border-border bg-surface px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all hover:border-accent hover:text-accent-t"
          onClick={add}
        >
          + {t("preset_injection_add")}
        </button>
      </div>

      {injections.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {injections.map((inj, i) => (
            <InjectionRowView key={i} injection={inj} index={i} onUpdate={update} onRemove={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

function InjectionRowView({ injection, index, onUpdate, onRemove }: {
  injection: InjectionRow; index: number;
  onUpdate: (i: number, p: Partial<InjectionRow>) => void;
  onRemove: (i: number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const enabled = injection.enabled;

  return (
    <div className={cn("rounded-md border transition-colors", enabled ? "border-border bg-surface" : "border-border2 bg-s1 opacity-60")}>
      {/* Header row */}
      <div
        className="group flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Enable toggle */}
        <CustomTooltip content={enabled ? t("preset_injection_enabled") : t("preset_injection_disabled")}>
        <button type="button"
          className={cn(
            "flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded text-[14px] transition-colors",
            enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
          )}
          onClick={(e) => { e.stopPropagation(); onUpdate(index, { enabled: !enabled }); }}
        >
          {enabled ? "●" : "○"}
        </button>
        </CustomTooltip>

        {/* Name */}
        <input
          className={cn("min-w-[80px] flex-1 border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-1px)] outline-none placeholder:text-t4", enabled ? "text-t1" : "text-t3")}
          value={injection.name}
          placeholder={t("preset_injection_name")}
          onChange={(e) => { e.stopPropagation(); onUpdate(index, { name: e.target.value }); }}
          onClick={(e) => e.stopPropagation()}
        />

        {/* Depth badge */}
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">
          ←{injection.depth}
        </span>

        {/* Role badge */}
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">
          {injection.role}
        </span>

        {/* Expand chevron */}
        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>
          ▶
        </span>

        {/* Delete */}
        <CustomTooltip content={t("preset_injection_delete")}>
        <button type="button"
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:bg-danger-dim hover:text-danger"
          onClick={(e) => { e.stopPropagation(); onRemove(index); }}
        >
          {Ic.del()}
        </button>
        </CustomTooltip>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <div className="mb-2 flex items-center gap-3">
            {/* Depth editor */}
            <label className="flex items-center gap-1.5 font-ui text-[11px] text-t4">
              Depth
              <input
                type="number"
                className="w-[44px] rounded border border-border bg-s2 px-1.5 py-0.5 text-center font-mono text-[11px] text-t1 outline-none focus:border-accent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={injection.depth}
                min={0} max={99}
                onChange={(e) => onUpdate(index, { depth: Math.max(0, Number(e.target.value) || 0) })}
              />
            </label>

            {/* Role select */}
            <label className="flex items-center gap-1.5 font-ui text-[11px] text-t4">
              Role
              <select
                className="rounded border border-border bg-s2 px-1.5 py-0.5 font-mono text-[11px] text-t1 outline-none cursor-pointer focus:border-accent"
                value={injection.role}
                onChange={(e) => onUpdate(index, { role: e.target.value as InjectionRow["role"] })}
              >
                {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>

          <textarea
            className="w-full min-h-[90px] rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent resize-y"
            value={injection.content}
            placeholder={t("preset_injection_content")}
            onChange={(e) => onUpdate(index, { content: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
