import { useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NumberInput } from "../../shared/NumberInput.js";
import type { PromptOrderEntry } from "@vibe-tavern/domain";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
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
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";

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
  authorsNoteRole: string;
  nsfw: string;
  enhanceDefinitions: string;
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

const stablePromptCanvasCollision: CollisionDetection = (args) => {
  const pointerMatches = pointerWithin(args);
  return pointerMatches.length > 0 ? pointerMatches : closestCenter(args);
};

export function InjectionTable(props: InjectionTableProps) {
  return <PromptOrderCanvas {...props} />;
}

export function PromptOrderCanvas({ injections, onChange, draft, onUpdateField, promptOrder = [], onPromptOrderChange }: InjectionTableProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [activeDragKey, setActiveDragKey] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 2 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 1 } }),
  );

  function update(index: number, patch: Partial<InjectionRow>) {
    const next = injections.map((inj, i) => i === index ? { ...inj, ...patch } : inj);
    onChange(next);
    // Keep promptOrder.enabled in sync with customInjections[i].enabled —
    // assemble.ts checks both, so toggling the row must flip both to stay consistent.
    if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
      const identifier = customIdentifier(next[index]!, index);
      syncPromptOrderEnabled(identifier, patch.enabled!);
    }
  }
  function remove(index: number) { onChange(injections.filter((_, i) => i !== index)); }
  function add() {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    onChange([...injections, { identifier: `custom_${suffix}`, name: "", content: "", depth: 4, role: "system", enabled: true, injectionPosition: 0, promptOrderPlacement: "before_chat" }]);
  }
  function syncPromptOrderEnabled(identifier: string, enabled: boolean) {
    const existing = promptOrder.find((entry) => entry.identifier === identifier);
    const next = existing
      ? promptOrder.map((entry) => entry.identifier === identifier ? { ...entry, enabled } : entry)
      : [...promptOrder, { identifier, enabled, kind: "custom" as const }];
    onPromptOrderChange?.(next);
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
    { key: "field:main", identifier: "main", kind: "field", defaultOrder: 0, render: () => <EditablePromptCard identifier="main" enabled={slotEnabled("main")} onToggle={togglePromptSlot} label={t("system_prompt")} role="system" value={draft?.system ?? ""} placeholder={t("system_prompt_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("system", value)} /> },
    { key: "slot:worldInfoBefore", identifier: "worldInfoBefore", kind: "slot", defaultOrder: 10, render: () => <PromptOrderMarker identifier="worldInfoBefore" label={t("prompt_slot_world_info_before")} kind="marker" enabled={slotEnabled("worldInfoBefore")} onToggle={togglePromptSlot} /> },
    { key: "slot:personaDescription", identifier: "personaDescription", kind: "slot", defaultOrder: 20, render: () => <PromptOrderMarker identifier="personaDescription" label={t("prompt_slot_persona")} kind="builtIn" enabled={slotEnabled("personaDescription")} onToggle={togglePromptSlot} /> },
    { key: "slot:charDescription", identifier: "charDescription", kind: "slot", defaultOrder: 30, render: () => <PromptOrderMarker identifier="charDescription" label={t("prompt_slot_character_description")} kind="builtIn" enabled={slotEnabled("charDescription")} onToggle={togglePromptSlot} /> },
    { key: "slot:charPersonality", identifier: "charPersonality", kind: "slot", defaultOrder: 40, render: () => <PromptOrderMarker identifier="charPersonality" label={t("prompt_slot_character_personality")} kind="builtIn" enabled={slotEnabled("charPersonality")} onToggle={togglePromptSlot} /> },
    { key: "slot:scenario", identifier: "scenario", kind: "slot", defaultOrder: 50, render: () => <PromptOrderMarker identifier="scenario" label={t("scenario")} kind="builtIn" enabled={slotEnabled("scenario")} onToggle={togglePromptSlot} /> },
    { key: "field:authorsNote", identifier: "authorsNote", kind: "field", defaultOrder: 60, render: () => <EditableAuthorNoteCard identifier="authorsNote" enabled={slotEnabled("authorsNote")} onToggle={togglePromptSlot} draft={draft} onUpdateField={onUpdateField} /> },
    { key: "field:enhanceDefinitions", identifier: "enhanceDefinitions", kind: "field", defaultOrder: 70, render: () => <EditablePromptCard identifier="enhanceDefinitions" enabled={slotEnabled("enhanceDefinitions")} onToggle={togglePromptSlot} label={t("enhance_definitions")} role="system" value={draft?.enhanceDefinitions ?? ""} placeholder={t("enhance_definitions_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("enhanceDefinitions", value)} /> },
    { key: "field:nsfw", identifier: "nsfw", kind: "field", defaultOrder: 75, render: () => <EditablePromptCard identifier="nsfw" enabled={slotEnabled("nsfw")} onToggle={togglePromptSlot} label={t("nsfw_prompt")} role="system" value={draft?.nsfw ?? ""} placeholder={t("nsfw_prompt_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("nsfw", value)} /> },
    { key: "slot:worldInfoAfter", identifier: "worldInfoAfter", kind: "slot", defaultOrder: 80, render: () => <PromptOrderMarker identifier="worldInfoAfter" label={t("prompt_slot_world_info_after")} kind="marker" enabled={slotEnabled("worldInfoAfter")} onToggle={togglePromptSlot} /> },
    { key: "slot:dialogueExamples", identifier: "dialogueExamples", kind: "slot", defaultOrder: 90, render: () => <PromptOrderMarker identifier="dialogueExamples" label={t("prompt_slot_dialogue_examples")} kind="marker" enabled={slotEnabled("dialogueExamples")} onToggle={togglePromptSlot} /> },
    { key: "slot:chatHistory", identifier: "chatHistory", kind: "slot", defaultOrder: 100, render: () => <PromptOrderMarker identifier="chatHistory" label={t("prompt_slot_chat_history")} kind="chat" enabled={slotEnabled("chatHistory")} onToggle={togglePromptSlot} /> },
    { key: "field:jailbreak", identifier: "jailbreak", kind: "field", defaultOrder: 110, render: () => <EditablePromptCard identifier="jailbreak" enabled={slotEnabled("jailbreak")} onToggle={togglePromptSlot} label={t("post_history_instructions")} role="system" value={draft?.jailbreak ?? ""} placeholder={t("jailbreak_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("jailbreak", value)} /> },
    { key: "field:assistantPrefill", identifier: "assistantPrefill", kind: "field", defaultOrder: 120, render: () => <EditablePromptCard identifier="assistantPrefill" enabled={slotEnabled("assistantPrefill")} onToggle={togglePromptSlot} label={t("prefill_assistant")} role="assistant" value={draft?.prefill ?? ""} placeholder={t("prefill_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("prefill", value)} /> },
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
      render: () => <InjectionRowView injection={inj} index={i} isMobile={isMobile} onUpdate={update} onRemove={remove} />,
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

  const activeDragItem = activeDragKey ? canvasItems.find((item) => item.key === activeDragKey) : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveDragKey(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragKey(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = canvasItems.findIndex((item) => item.key === active.id);
    const to = canvasItems.findIndex((item) => item.key === over.id);
    if (from < 0 || to < 0) return;
    commitCanvasOrder(arrayMove(canvasItems, from, to));
  }

  const dragOverlay = (
    <DragOverlay dropAnimation={null} zIndex={700}>
      {activeDragItem ? (
        <div className="pointer-events-none flex w-full items-stretch gap-1 rounded-md shadow-theme-md">
          <div className="flex w-6 shrink-0 items-center justify-center rounded border border-border bg-s2 font-mono text-[13px] text-t4">⋮⋮</div>
          <div className="min-w-0 flex-1">{activeDragItem.render()}</div>
        </div>
      ) : null}
    </DragOverlay>
  );

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

      <DndContext
        sensors={sensors}
        collisionDetection={stablePromptCanvasCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDragKey(null)}
      >
        <SortableContext items={canvasItems.map((item) => item.key)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {canvasItems.map((item) => (
              <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
                {item.render()}
              </SortableCanvasItem>
            ))}
          </div>
        </SortableContext>
        {typeof document === "undefined" ? dragOverlay : createPortal(dragOverlay, document.body)}
      </DndContext>
    </div>
  );
}

function SortableCanvasItem({ id, overlayActive, children }: { id: string; overlayActive: boolean; children: ReactNode }) {
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
        (isDragging || overlayActive) && "opacity-0"
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex h-9 w-9 shrink-0 touch-none cursor-grab select-none items-center justify-center rounded border border-transparent font-mono text-[13px] text-t4 transition-colors hover:border-border hover:bg-s2 hover:text-t2 active:cursor-grabbing sm:h-auto sm:w-6"
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
      "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 font-ui text-[12px] transition-colors",
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
      <span className="min-w-0 flex-1 truncate sm:overflow-visible sm:whitespace-normal sm:text-clip">{label}</span>
      <span className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] opacity-70">
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
      <div className="flex min-w-0 cursor-pointer select-none flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-2.5" onClick={() => setExpanded((v) => !v)}>
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
        <span className="min-w-[120px] flex-1 truncate font-ui text-[12px] text-t1 sm:overflow-visible sm:whitespace-normal sm:text-clip">{label}</span>
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
  const role = draft?.authorsNoteRole ?? "system";
  return (
    <div className={cn("rounded-md border border-border bg-surface", !enabled && "opacity-55")}>
      <div className="flex min-w-0 cursor-pointer select-none flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-2.5" onClick={() => setExpanded((v) => !v)}>
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
        <span className="min-w-[120px] flex-1 truncate font-ui text-[12px] text-t1 sm:overflow-visible sm:whitespace-normal sm:text-clip">{t("authors_note_label")}</span>
        <TokenCounter text={draft?.authorsNote ?? ""} />
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{role}</span>
        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">{position}</span>
        {position === "in_chat" && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">←{draft?.authorsNoteDepth ?? 4}</span>}
        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-accent">editable</span>
        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>▶</span>
      </div>
      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={role}
              options={roleOptions.map(r => ({ value: r, label: r }))}
              onChange={(v) => onUpdateField?.("authorsNoteRole", v)}
              disabled={disabled}
              compact
            />
            <SegmentedControl
              value={position}
              options={[
                { value: "in_prompt", label: t("an_position_in_prompt") },
                { value: "in_chat", label: t("an_position_in_chat") },
                { value: "after_chat", label: t("an_position_after_chat") },
              ]}
              onChange={(v) => onUpdateField?.("authorsNotePosition", v)}
              disabled={disabled}
              compact
            />
            {position === "in_chat" && (
              <CustomTooltip content={`${t("insert_depth_label")}: ${t("insert_depth_hint")}`}>
                <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                  <span className="sr-only">{t("insert_depth_label")}</span>
                  <NumberInput
                    className="h-[30px] w-[90px]"
                    min={0}
                    max={99}
                    value={draft?.authorsNoteDepth ?? 4}
                    onChange={(v) => onUpdateField?.("authorsNoteDepth", v)}
                    disabled={disabled}
                  />
                </div>
              </CustomTooltip>
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

function InjectionRowView({ injection, index, isMobile, onUpdate, onRemove }: {
  injection: InjectionRow; index: number;
  isMobile: boolean;
  onUpdate: (i: number, p: Partial<InjectionRow>) => void;
  onRemove: (i: number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
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
        <div className="flex min-w-[80px] flex-1 items-center gap-1.5 overflow-hidden">
          {editingName ? (
            <input
              autoFocus
              className={cn("min-w-0 flex-1 rounded border border-border bg-s2 px-1.5 py-0.5 font-ui text-[calc(var(--ui-fs)-1px)] outline-none focus:border-accent placeholder:text-t4", enabled ? "text-t1" : "text-t3")}
              value={injection.name}
              placeholder={t("preset_injection_name")}
              onChange={(e) => onUpdate(index, { name: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); setEditingName(false); }
                if (e.key === "Escape") { e.preventDefault(); setEditingName(false); }
              }}
            />
          ) : (
            <>
              <span className={cn("min-w-0 flex-1 truncate font-ui text-[calc(var(--ui-fs)-1px)]", enabled ? "text-t1" : "text-t3", !injection.name && "text-t4")}>{injection.name || t("preset_injection_name")}</span>
              <button
                type="button"
                className={cn(
                  "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:bg-s2 hover:text-accent focus:bg-s2 focus:text-accent",
                  isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                )}
                onClick={(e) => { e.stopPropagation(); setEditingName(true); }}
                aria-label={t("preset_injection_name")}
              >
                {Ic.edit()}
              </button>
            </>
          )}
        </div>

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
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {/* Depth editor */}
            <CustomTooltip content={t("insert_depth_label")}>
              <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                <span className="sr-only">{t("insert_depth_label")}</span>
                <NumberInput
                  className="h-[30px] w-[90px]"
                  min={0} max={99}
                  value={injection.depth}
                  onChange={(v) => onUpdate(index, { depth: v })}
                />
              </div>
            </CustomTooltip>

            {/* Role select */}
            <label className="flex min-w-0 flex-wrap items-center gap-1.5 font-ui text-[11px] text-t4">
              <span>{t("role")}</span>
              <SegmentedControl
                value={injection.role}
                options={roleOptions.map(r => ({ value: r, label: r }))}
                onChange={(v) => onUpdate(index, { role: v as InjectionRow["role"] })}
                compact
              />
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
