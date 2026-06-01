import { useState, type CSSProperties, type ReactNode } from "react";
import type { PromptOrderEntry } from "@vibe-tavern/domain";
import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useT } from "../../../i18n/context.js";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";

export interface InjectionRow {
  identifier?: string;
  name: string;
  content: string;
  depth: number;
  role: "system" | "user" | "assistant";
  enabled: boolean;
  injectionPosition?: 0 | 1 | "relative" | "absolute";
  injectionOrder?: number;
  promptOrderIndex?: number;
  promptOrderPlacement?: "before_chat" | "after_chat";
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
  promptOrder?: PromptOrderEntry[];
  onPromptOrderChange?: (promptOrder: PromptOrderEntry[]) => void;
}

const roleOptions = ["system", "user", "assistant"] as const;

export function InjectionTable(props: InjectionTableProps) {
  return <PromptOrderCanvas {...props} />;
}

export function PromptOrderCanvas({ injections, onChange, draft, onUpdateField, promptOrder = [], onPromptOrderChange }: InjectionTableProps) {
  const { t } = useT();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 2 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 1 } }),
  );

  function update(index: number, patch: Partial<InjectionRow>) {
    onChange(injections.map((inj, i) => i === index ? { ...inj, ...patch } : inj));
  }
  function remove(index: number) { onChange(injections.filter((_, i) => i !== index)); }
  function add() {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    onChange([...injections, { identifier: `custom_${suffix}`, name: "", content: "", depth: 4, role: "system", enabled: true, injectionPosition: 0, promptOrderPlacement: "before_chat" }]);
  }
  function togglePromptSlot(identifier: string) {
    const existing = promptOrder.find((entry) => entry.identifier === identifier);
    const enabled = existing?.enabled ?? true;
    const next = existing
      ? promptOrder.map((entry) => entry.identifier === identifier ? { ...entry, enabled: !enabled } : entry)
      : [...promptOrder, { identifier, enabled: false, kind: "built_in" as const }];
    onPromptOrderChange?.(next);
  }
  function slotEnabled(identifier: string) {
    return promptOrder.find((entry) => entry.identifier === identifier)?.enabled ?? true;
  }
  function customIdentifier(injection: InjectionRow, index: number) {
    return injection.identifier || `custom_${index}`;
  }

  type CanvasItem =
    | { key: string; identifier: string; kind: "slot"; defaultOrder: number; render: () => ReactNode }
    | { key: string; identifier: string; kind: "field"; defaultOrder: number; render: () => ReactNode }
    | { key: string; identifier: string; kind: "custom"; defaultOrder: number; injectionIndex: number; render: () => ReactNode };

  const hasStoredOrdering = promptOrder.some((entry) => entry.order != null);
  const promptOrderIndex = (identifier: string) => promptOrder.findIndex((entry) => entry.identifier === identifier);
  const promptOrderValue = (identifier: string, fallback: number) => {
    const index = promptOrderIndex(identifier);
    if (!hasStoredOrdering || index < 0) return fallback;
    return promptOrder[index]!.order ?? index;
  };

  const fixedItems: CanvasItem[] = [
    { key: "slot:worldInfoBefore", identifier: "worldInfoBefore", kind: "slot", defaultOrder: 0, render: () => <PromptOrderMarker identifier="worldInfoBefore" label={t("prompt_slot_world_info_before")} kind="marker" enabled={slotEnabled("worldInfoBefore")} onToggle={togglePromptSlot} /> },
    { key: "field:main", identifier: "main", kind: "field", defaultOrder: 10, render: () => <EditablePromptCard identifier="main" enabled={slotEnabled("main")} onToggle={togglePromptSlot} label={t("system_prompt")} role="system" value={draft?.system ?? ""} placeholder={t("system_prompt_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("system", value)} /> },
    { key: "slot:charDescription", identifier: "charDescription", kind: "slot", defaultOrder: 20, render: () => <PromptOrderMarker identifier="charDescription" label={t("prompt_slot_character_description")} kind="builtIn" enabled={slotEnabled("charDescription")} onToggle={togglePromptSlot} /> },
    { key: "slot:charPersonality", identifier: "charPersonality", kind: "slot", defaultOrder: 30, render: () => <PromptOrderMarker identifier="charPersonality" label={t("prompt_slot_character_personality")} kind="builtIn" enabled={slotEnabled("charPersonality")} onToggle={togglePromptSlot} /> },
    { key: "slot:scenario", identifier: "scenario", kind: "slot", defaultOrder: 40, render: () => <PromptOrderMarker identifier="scenario" label={t("scenario")} kind="builtIn" enabled={slotEnabled("scenario")} onToggle={togglePromptSlot} /> },
    { key: "slot:personaDescription", identifier: "personaDescription", kind: "slot", defaultOrder: 50, render: () => <PromptOrderMarker identifier="personaDescription" label={t("prompt_slot_persona")} kind="builtIn" enabled={slotEnabled("personaDescription")} onToggle={togglePromptSlot} /> },
    { key: "field:authorsNote", identifier: "authorsNote", kind: "field", defaultOrder: 60, render: () => <EditableAuthorNoteCard identifier="authorsNote" enabled={slotEnabled("authorsNote")} onToggle={togglePromptSlot} draft={draft} onUpdateField={onUpdateField} /> },
    { key: "slot:chatHistory", identifier: "chatHistory", kind: "slot", defaultOrder: 100, render: () => <PromptOrderMarker identifier="chatHistory" label={t("prompt_slot_chat_history")} kind="chat" enabled={slotEnabled("chatHistory")} onToggle={togglePromptSlot} /> },
    { key: "slot:worldInfoAfter", identifier: "worldInfoAfter", kind: "slot", defaultOrder: 110, render: () => <PromptOrderMarker identifier="worldInfoAfter" label={t("prompt_slot_world_info_after")} kind="marker" enabled={slotEnabled("worldInfoAfter")} onToggle={togglePromptSlot} /> },
    { key: "slot:dialogueExamples", identifier: "dialogueExamples", kind: "slot", defaultOrder: 120, render: () => <PromptOrderMarker identifier="dialogueExamples" label={t("prompt_slot_dialogue_examples")} kind="marker" enabled={slotEnabled("dialogueExamples")} onToggle={togglePromptSlot} /> },
    { key: "field:jailbreak", identifier: "jailbreak", kind: "field", defaultOrder: 130, render: () => <EditablePromptCard identifier="jailbreak" enabled={slotEnabled("jailbreak")} onToggle={togglePromptSlot} label={t("post_history_instructions")} role="system" value={draft?.jailbreak ?? ""} placeholder={t("jailbreak_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("jailbreak", value)} /> },
    { key: "field:assistantPrefill", identifier: "assistantPrefill", kind: "field", defaultOrder: 140, render: () => <EditablePromptCard label={t("prefill_assistant")} role="assistant" value={draft?.prefill ?? ""} placeholder={t("prefill_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("prefill", value)} /> },
  ];

  const customItems: CanvasItem[] = injections.map((inj, i) => {
    const identifier = customIdentifier(inj, i);
    const defaultOrder = inj.promptOrderIndex ?? (inj.promptOrderPlacement === "after_chat" ? 125 + i : 70 + i);
    return {
      key: `custom:${identifier}`,
      identifier,
      kind: "custom" as const,
      defaultOrder,
      injectionIndex: i,
      render: () => <InjectionRowView injection={inj} index={i} onUpdate={update} onRemove={remove} />,
    };
  });

  const canvasItems = [...fixedItems, ...customItems]
    .sort((a, b) => promptOrderValue(a.identifier, a.defaultOrder) - promptOrderValue(b.identifier, b.defaultOrder));

  function commitCanvasOrder(items: CanvasItem[]) {
    const chatOrder = items.findIndex((item) => item.identifier === "chatHistory");
    const entries: PromptOrderEntry[] = items.map((item, index) => {
      const existing = promptOrder.find((entry) => entry.identifier === item.identifier);
      return {
        identifier: item.identifier,
        enabled: existing?.enabled ?? true,
        order: index,
        kind: item.kind === "custom" ? "custom" : "built_in",
      };
    });
    onPromptOrderChange?.(entries);

    const orderByIdentifier = new Map(items.map((item, index) => [item.identifier, index]));
    onChange(injections.map((inj, index) => {
      const identifier = customIdentifier(inj, index);
      const order = orderByIdentifier.get(identifier);
      if (order == null) return inj;
      const placement = chatOrder >= 0 && order > chatOrder ? "after_chat" : "before_chat";
      const isRelative = inj.injectionPosition === 0 || inj.injectionPosition === "relative" || inj.injectionPosition == null;
      return {
        ...inj,
        identifier,
        promptOrderIndex: order,
        ...(isRelative ? { injectionPosition: 0 as const, promptOrderPlacement: placement as "before_chat" | "after_chat" } : {}),
      };
    }));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = canvasItems.findIndex((item) => item.key === active.id);
    const to = canvasItems.findIndex((item) => item.key === over.id);
    if (from < 0 || to < 0) return;
    commitCanvasOrder(arrayMove(canvasItems, from, to));
  }

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

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={canvasItems.map((item) => item.key)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {canvasItems.map((item) => (
              <SortableCanvasItem key={item.key} id={item.key}>
                {item.render()}
              </SortableCanvasItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableCanvasItem({ id, children }: { id: string; children: ReactNode }) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 40 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-stretch gap-1 rounded-md",
        isDragging && "opacity-90 shadow-theme-md"
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex w-6 shrink-0 touch-none cursor-grab select-none items-center justify-center rounded border border-transparent font-mono text-[13px] text-t4 transition-colors hover:border-border hover:bg-s2 hover:text-t2 active:cursor-grabbing"
        aria-label="Drag prompt item"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PromptOrderMarker({ identifier, label, kind, enabled = true, onToggle }: {
  identifier: string;
  label: string;
  kind: "builtIn" | "marker" | "chat";
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
}) {
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border px-3 py-2 font-ui text-[12px] transition-colors",
      !enabled && "opacity-55",
      kind === "chat" ? "border-accent/35 bg-accent/10 text-accent-t" :
      kind === "marker" ? "border-border2 bg-s1 text-t4" :
      "border-border bg-s2/70 text-t2",
    )}>
      <CustomTooltip content={enabled ? "Enabled" : "Disabled"}>
        <button
          type="button"
          className={cn(
            "flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded text-[13px] transition-colors",
            enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
          )}
          onClick={() => onToggle?.(identifier)}
        >
          {enabled ? "●" : "○"}
        </button>
      </CustomTooltip>
      <span className="flex-1">{label}</span>
      <span className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] opacity-70">
        {kind === "chat" ? "marker" : kind === "marker" ? "slot" : "read-only"}
      </span>
    </div>
  );
}

function EditablePromptCard({ identifier, enabled = true, onToggle, label, role, value, placeholder, disabled, onChange }: {
  identifier?: string;
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  label: string;
  role: "system" | "user" | "assistant";
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={cn("rounded-md border border-border bg-surface", !enabled && "opacity-55")}>
      <div className="flex cursor-pointer select-none items-center gap-2.5 px-3 py-2" onClick={() => setExpanded((v) => !v)}>
        {identifier ? (
          <CustomTooltip content={enabled ? "Enabled" : "Disabled"}>
            <button
              type="button"
              className={cn(
                "flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded text-[13px] transition-colors",
                enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
              )}
              onClick={(e) => { e.stopPropagation(); onToggle?.(identifier); }}
            >
              {enabled ? "●" : "○"}
            </button>
          </CustomTooltip>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        )}
        <span className="flex-1 font-ui text-[12px] text-t1">{label}</span>
        <TokenCounter text={value} />
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{role}</span>
        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-accent">editable</span>
        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
      </div>
      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <AutoTextarea
            className="min-h-[110px] w-full resize-none overflow-hidden rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent disabled:opacity-60"
            style={{}}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            maxHeight={420}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

function EditableAuthorNoteCard({ identifier, enabled = true, onToggle, draft, onUpdateField }: {
  identifier?: string;
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const disabled = !draft || !onUpdateField;
  const position = draft?.authorsNotePosition ?? "in_chat";
  return (
    <div className={cn("rounded-md border border-border bg-surface", !enabled && "opacity-55")}>
      <div className="flex cursor-pointer select-none items-center gap-2.5 px-3 py-2" onClick={() => setExpanded((v) => !v)}>
        {identifier ? (
          <CustomTooltip content={enabled ? "Enabled" : "Disabled"}>
            <button
              type="button"
              className={cn(
                "flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded text-[13px] transition-colors",
                enabled ? "text-accent hover:bg-accent/10" : "text-t4 hover:text-t2"
              )}
              onClick={(e) => { e.stopPropagation(); onToggle?.(identifier); }}
            >
              {enabled ? "●" : "○"}
            </button>
          </CustomTooltip>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        )}
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
          <AutoTextarea
            className="min-h-[100px] w-full resize-none overflow-hidden rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent disabled:opacity-60"
            style={{}}
            value={draft?.authorsNote ?? ""}
            placeholder={t("authors_note_placeholder")}
            disabled={disabled}
            maxHeight={420}
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

          <AutoTextarea
            className="min-h-[90px] w-full resize-none overflow-hidden rounded-md border border-border bg-s2 px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent"
            style={{}}
            value={injection.content}
            placeholder={t("preset_injection_content")}
            maxHeight={420}
            onChange={(e) => onUpdate(index, { content: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
