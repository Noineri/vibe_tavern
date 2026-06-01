import { useState } from "react";
import { useT } from "../../../i18n/context.js";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { TokenCounter } from "../../shared/TokenCounter.js";

export interface InjectionRow {
  name: string;
  content: string;
  depth: number;
  role: "system" | "user" | "assistant";
  enabled: boolean;
}

type PromptCanvasDraft = {
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: string;
};

interface InjectionTableProps {
  injections: InjectionRow[];
  onChange: (injections: InjectionRow[]) => void;
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number) => void;
}

const roleOptions = ["system", "user", "assistant"] as const;

export function InjectionTable(props: InjectionTableProps) {
  return <PromptOrderCanvas {...props} />;
}

export function PromptOrderCanvas({ injections, onChange, draft, onUpdateField }: InjectionTableProps) {
  const { t } = useT();

  function update(index: number, patch: Partial<InjectionRow>) {
    onChange(injections.map((inj, i) => i === index ? { ...inj, ...patch } : inj));
  }
  function remove(index: number) { onChange(injections.filter((_, i) => i !== index)); }
  function add() { onChange([...injections, { name: "", content: "", depth: 4, role: "system", enabled: true }]); }

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{t("preset_prompt_order_canvas_title")}</div>
          <div className="mt-0.5 font-ui text-[11px] text-t4">{t("preset_prompt_order_canvas_hint")}</div>
        </div>
        <button type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border bg-surface px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all hover:border-accent hover:text-accent-t"
          onClick={add}
        >
          + {t("preset_injection_add")}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <PromptOrderMarker label={t("prompt_slot_world_info_before")} kind="marker" />
        <EditablePromptCard
          label={t("system_prompt")}
          role="system"
          value={draft?.system ?? ""}
          placeholder={t("system_prompt_placeholder")}
          disabled={!draft || !onUpdateField}
          onChange={(value) => onUpdateField?.("system", value)}
        />
        <PromptOrderMarker label={t("prompt_slot_character_description")} kind="builtIn" />
        <PromptOrderMarker label={t("prompt_slot_character_personality")} kind="builtIn" />
        <PromptOrderMarker label={t("scenario")} kind="builtIn" />
        <PromptOrderMarker label={t("prompt_slot_persona")} kind="builtIn" />
        <EditableAuthorNoteCard draft={draft} onUpdateField={onUpdateField} />

        <div className="my-1 rounded-md border border-dashed border-border2 bg-s2/35 p-2">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-ui text-[10px] font-semibold uppercase tracking-[0.08em] text-t4">{t("preset_injections_title")}</span>
            <span className="rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">
              {injections.filter(i => i.enabled).length}/{injections.length}
            </span>
            <div className="h-px flex-1 bg-border2" />
          </div>
          {injections.length === 0 ? (
            <div className="rounded border border-border2 bg-s1 px-3 py-2 font-ui text-[11px] text-t4">
              {t("preset_injections_empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {injections.map((inj, i) => (
                <InjectionRowView key={i} injection={inj} index={i} onUpdate={update} onRemove={remove} />
              ))}
            </div>
          )}
        </div>

        <PromptOrderMarker label={t("prompt_slot_chat_history")} kind="chat" />
        <PromptOrderMarker label={t("prompt_slot_world_info_after")} kind="marker" />
        <PromptOrderMarker label={t("prompt_slot_dialogue_examples")} kind="marker" />
        <EditablePromptCard
          label={t("post_history_instructions")}
          role="system"
          value={draft?.jailbreak ?? ""}
          placeholder={t("jailbreak_placeholder")}
          disabled={!draft || !onUpdateField}
          onChange={(value) => onUpdateField?.("jailbreak", value)}
        />
        <EditablePromptCard
          label={t("prefill_assistant")}
          role="assistant"
          value={draft?.prefill ?? ""}
          placeholder={t("prefill_placeholder")}
          disabled={!draft || !onUpdateField}
          onChange={(value) => onUpdateField?.("prefill", value)}
        />
      </div>
    </div>
  );
}

function PromptOrderMarker({ label, kind }: { label: string; kind: "builtIn" | "marker" | "chat" }) {
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border px-3 py-2 font-ui text-[12px]",
      kind === "chat" ? "border-accent/35 bg-accent/10 text-accent-t" :
      kind === "marker" ? "border-border2 bg-s1 text-t4" :
      "border-border bg-s2/70 text-t2",
    )}>
      <span className={cn(
        "h-1.5 w-1.5 rounded-full",
        kind === "chat" ? "bg-accent" : kind === "marker" ? "bg-t4" : "bg-t3",
      )} />
      <span className="flex-1">{label}</span>
      <span className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] opacity-70">
        {kind === "chat" ? "marker" : kind === "marker" ? "slot" : "read-only"}
      </span>
    </div>
  );
}

function EditablePromptCard({ label, role, value, placeholder, disabled, onChange }: {
  label: string;
  role: "system" | "user" | "assistant";
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex cursor-pointer select-none items-center gap-2.5 px-3 py-2" onClick={() => setExpanded((v) => !v)}>
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="flex-1 font-ui text-[12px] text-t1">{label}</span>
        <TokenCounter text={value} />
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{role}</span>
        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-accent">editable</span>
        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
      </div>
      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <textarea
            className="min-h-[110px] w-full resize-y rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent disabled:opacity-60"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

function EditableAuthorNoteCard({ draft, onUpdateField }: {
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const disabled = !draft || !onUpdateField;
  const position = draft?.authorsNotePosition ?? "in_chat";
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex cursor-pointer select-none items-center gap-2.5 px-3 py-2" onClick={() => setExpanded((v) => !v)}>
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="flex-1 font-ui text-[12px] text-t1">{t("authors_note_label")}</span>
        <TokenCounter text={draft?.authorsNote ?? ""} />
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{position}</span>
        {position === "in_chat" && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">←{draft?.authorsNoteDepth ?? 4}</span>}
        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-accent">editable</span>
        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
      </div>
      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              className="rounded border border-border bg-s2 px-1.5 py-0.5 font-mono text-[11px] text-t1 outline-none cursor-pointer focus:border-accent disabled:opacity-60"
              value={position}
              disabled={disabled}
              onChange={(e) => onUpdateField?.("authorsNotePosition", e.target.value)}
            >
              <option value="in_prompt">{t("an_position_in_prompt")}</option>
              <option value="in_chat">{t("an_position_in_chat")}</option>
              <option value="after_chat">{t("an_position_after_chat")}</option>
            </select>
            {position === "in_chat" && (
              <label className="flex items-center gap-1.5 font-ui text-[11px] text-t4">
                {t("insert_depth_label")}
                <input
                  type="number"
                  className="w-[52px] rounded border border-border bg-s2 px-1.5 py-0.5 text-center font-mono text-[11px] text-t1 outline-none focus:border-accent disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  value={draft?.authorsNoteDepth ?? 4}
                  min={0}
                  max={99}
                  disabled={disabled}
                  onChange={(e) => onUpdateField?.("authorsNoteDepth", Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
            )}
          </div>
          <textarea
            className="min-h-[100px] w-full resize-y rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent disabled:opacity-60"
            value={draft?.authorsNote ?? ""}
            placeholder={t("authors_note_placeholder")}
            disabled={disabled}
            onChange={(e) => onUpdateField?.("authorsNote", e.target.value)}
          />
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
