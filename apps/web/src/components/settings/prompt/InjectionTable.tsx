import { useState, useMemo, type CSSProperties, type ReactNode, createContext, useContext } from "react";
import { createPortal } from "react-dom";

const DragHandleContext = createContext<{
  attributes: any;
  listeners: any;
  setActivatorNodeRef: (node: any) => void;
} | null>(null);

function DragHandle({ disabled }: { disabled?: boolean }) {
  const ctx = useContext(DragHandleContext);
  if (!ctx) return null;
  return (
    <button
      ref={disabled ? undefined : ctx.setActivatorNodeRef}
      type="button"
      className={cn(
        "flex h-5 w-5 shrink-0 select-none items-center justify-center rounded font-mono text-[13px] transition-colors sm:h-auto sm:w-5",
        disabled 
          ? "opacity-30 cursor-not-allowed text-t4" 
          : "cursor-grab touch-none text-t4 hover:bg-s2 hover:text-t2 active:cursor-grabbing"
      )}
      aria-label="Drag prompt item"
      {...(disabled ? {} : ctx.attributes)}
      {...(disabled ? {} : ctx.listeners)}
    >
      ⋮⋮
    </button>
  );
}
import { NumberInput } from "../../shared/NumberInput.js";
import type { PromptOrderEntry, PromptSlot, PromptZone } from "@vibe-tavern/domain";
import { migrateInjection } from "@vibe-tavern/domain";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent
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
  slot?: PromptSlot;
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

export function InjectionTable(props: InjectionTableProps) {
  return <PromptOrderCanvas {...props} />;
}

function DroppableDepthContainer({ id, depth, children, label, className }: { id: string; depth: number | string; children: ReactNode; label?: string; className?: string }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md border border-transparent p-1 transition-colors min-h-[40px] flex flex-col gap-1.5",
        className
      )}
    >
      {label && <div className="mb-0.5 px-1 font-mono text-[10px] text-t4 uppercase tracking-wider">{label}</div>}
      {children}
    </div>
  );
}

type CanvasItem =
  | { key: string; identifier: string; kind: "slot"; defaultOrder: number; render: () => ReactNode }
  | { key: string; identifier: string; kind: "field"; defaultOrder: number; render: () => ReactNode }
  | { key: string; identifier: string; kind: "custom"; defaultOrder: number; injectionIndex: number; render: () => ReactNode };

type ZonesState = {
  before_chat: CanvasItem[];
  after_chat: CanvasItem[];
  depth4: CanvasItem[];
  depth3: CanvasItem[];
  depth2: CanvasItem[];
  depth1: CanvasItem[];
};

/**
 * PromptOrderCanvas
 * 
 * WARNING TO FUTURE AGENTS / DEVELOPERS:
 * This component uses @dnd-kit/core with MULTIPLE SortableContexts (cross-container drag and drop).
 * 
 * To ensure smooth visual transitions (items spreading apart immediately when dragged into a new container)
 * and prevent "twitching", we MUST handle `onDragOver` by mutating a local state (`activeZones`).
 * 
 * 1. `zonesToRender` dynamically switches between `defaultZones` (computed from props) when NOT dragging, 
 *    and `activeZones` when dragging.
 * 2. We deliberately initialize `activeZones` to `null` and only populate it on `onDragStart`.
 *    Do NOT use `useEffect` to sync `activeZones` with `defaultZones`! Doing so will trigger infinite 
 *    React re-render loops (Error #185) because `defaultZones` changes reference on every render.
 * 3. In `onDragOver`, we manually move items between arrays within `activeZones` so `dnd-kit` can accurately
 *    compute placeholder spaces on the fly.
 * 4. Finally, `onDragEnd` applies the sorted `activeZones` back into the parent `promptOrder` and `injections` props.
 */
export function PromptOrderCanvas({ injections, onChange, draft, onUpdateField, promptOrder = [], onPromptOrderChange }: InjectionTableProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [activeDragKey, setActiveDragKey] = useState<string | null>(null);
  const [accordionOpen, setAccordionOpen] = useState(false);
  
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 2 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 1 } }),
  );

  function update(index: number, patch: Partial<InjectionRow>) {
    const next = injections.map((inj, i) => i === index ? { ...inj, ...patch } : inj);
    onChange(next);
    if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
      const identifier = customIdentifier(next[index]!, index);
      syncPromptOrderEnabled(identifier, patch.enabled!);
    }
  }
  function remove(index: number) { onChange(injections.filter((_, i) => i !== index)); }
  function add() {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const newInj: InjectionRow = { identifier: `custom_${suffix}`, name: "", content: "", depth: 4, role: "system", enabled: true, slot: { zone: "before_chat", depth: null, order: 999 } };
    onChange([...injections, newInj]);
  }
  function syncPromptOrderEnabled(identifier: string, enabled: boolean) {
    const existing = promptOrder.find((entry) => entry.identifier === identifier);
    const next = existing
      ? promptOrder.map((entry) => entry.identifier === identifier ? { ...entry, enabled } : entry)
      : [...promptOrder, { identifier, enabled, kind: "custom" as const, zone: "before_chat" as const, depth: null, order: 999 }];
    onPromptOrderChange?.(next);
  }
  function togglePromptSlot(identifier: string) {
    const existing = promptOrder.find((entry) => entry.identifier === identifier);
    const enabled = existing?.enabled ?? true;
    const next = existing
      ? promptOrder.map((entry) => entry.identifier === identifier ? { ...entry, enabled: !enabled } : entry)
      : [...promptOrder, { identifier, enabled: false, kind: "built_in" as const, zone: "before_chat" as const, depth: null, order: 999 }];
    onPromptOrderChange?.(next);
  }
  function slotEnabled(identifier: string) {
    return promptOrder.find((entry) => entry.identifier === identifier)?.enabled ?? true;
  }
  function customIdentifier(injection: InjectionRow, index: number) {
    return injection.identifier || `custom_${index}`;
  }

  function slotLabelFor(identifier: string): string | null {
    const entry = promptOrder.find(e => e.identifier === identifier);
    const zone = entry?.zone;
    if (!zone) return null;
    if (zone === "before_chat") return null;
    if (zone === "after_chat") return "after";
    const depth = entry?.depth ?? 0;
    return `←${depth}`;
  }

  function slotDepthFor(identifier: string): number | null {
    const entry = promptOrder.find(e => e.identifier === identifier);
    if (entry?.zone === "in_chat") return entry.depth ?? 4;
    return null;
  }

  function updateSlotDepth(identifier: string, depth: number) {
    const next = promptOrder.map(e =>
      e.identifier === identifier ? { ...e, depth } : e
    );
    onPromptOrderChange?.(next);
  }

  function getCanvasItemSlot(item: CanvasItem): PromptSlot {
    if (item.kind === "custom") {
      const inj = injections[item.injectionIndex];
      return inj.slot ?? migrateInjection(inj).slot;
    }
    const existingOrder = promptOrder.find(e => e.identifier === item.identifier);
    if (existingOrder?.zone) {
      return { zone: existingOrder.zone, depth: existingOrder.depth ?? null, order: existingOrder.order ?? item.defaultOrder };
    }
    const isAfterChat = item.identifier === "jailbreak" || item.identifier === "assistantPrefill" || item.defaultOrder > 100;
    return {
      zone: isAfterChat ? "after_chat" : "before_chat",
      depth: null,
      order: existingOrder?.order ?? item.defaultOrder
    };
  }

  const fixedItems: CanvasItem[] = [
    { key: "field:main", identifier: "main", kind: "field", defaultOrder: 0, render: () => <EditablePromptCard identifier="main" enabled={slotEnabled("main")} onToggle={togglePromptSlot} label={t("system_prompt")} role="system" value={draft?.system ?? ""} placeholder={t("system_prompt_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("system", value)} /> },
    { key: "slot:worldInfoBefore", identifier: "worldInfoBefore", kind: "slot", defaultOrder: 10, render: () => <PromptOrderMarker identifier="worldInfoBefore" label={t("prompt_slot_world_info_before")} tooltip={t("prompt_slot_world_info_before_hint")} kind="marker" enabled={slotEnabled("worldInfoBefore")} onToggle={togglePromptSlot} /> },
    { key: "slot:personaDescription", identifier: "personaDescription", kind: "slot", defaultOrder: 20, render: () => <PromptOrderMarker identifier="personaDescription" label={t("prompt_slot_persona")} kind="builtIn" enabled={slotEnabled("personaDescription")} onToggle={togglePromptSlot} /> },
    { key: "slot:charDescription", identifier: "charDescription", kind: "slot", defaultOrder: 30, render: () => <PromptOrderMarker identifier="charDescription" label={t("prompt_slot_character_description")} kind="builtIn" enabled={slotEnabled("charDescription")} onToggle={togglePromptSlot} /> },
    { key: "slot:charPersonality", identifier: "charPersonality", kind: "slot", defaultOrder: 40, render: () => <PromptOrderMarker identifier="charPersonality" label={t("prompt_slot_character_personality")} kind="builtIn" enabled={slotEnabled("charPersonality")} onToggle={togglePromptSlot} /> },
    { key: "slot:scenario", identifier: "scenario", kind: "slot", defaultOrder: 50, render: () => <PromptOrderMarker identifier="scenario" label={t("scenario")} kind="builtIn" enabled={slotEnabled("scenario")} onToggle={togglePromptSlot} /> },
    { key: "field:authorsNote", identifier: "authorsNote", kind: "field", defaultOrder: 60, render: () => <EditableAuthorNoteCard identifier="authorsNote" enabled={slotEnabled("authorsNote")} onToggle={togglePromptSlot} draft={draft} onUpdateField={onUpdateField} slotLabel={slotLabelFor("authorsNote")} slotDepth={slotDepthFor("authorsNote")} onSlotDepthChange={(d) => updateSlotDepth("authorsNote", d)} /> },
    { key: "field:enhanceDefinitions", identifier: "enhanceDefinitions", kind: "field", defaultOrder: 70, render: () => <EditablePromptCard identifier="enhanceDefinitions" enabled={slotEnabled("enhanceDefinitions")} onToggle={togglePromptSlot} label={t("enhance_definitions")} role="system" value={draft?.enhanceDefinitions ?? ""} placeholder={t("enhance_definitions_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("enhanceDefinitions", value)} /> },
    { key: "field:nsfw", identifier: "nsfw", kind: "field", defaultOrder: 75, render: () => <EditablePromptCard identifier="nsfw" enabled={slotEnabled("nsfw")} onToggle={togglePromptSlot} label={t("nsfw_prompt")} role="system" value={draft?.nsfw ?? ""} placeholder={t("nsfw_prompt_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("nsfw", value)} /> },
    { key: "slot:worldInfoAfter", identifier: "worldInfoAfter", kind: "slot", defaultOrder: 80, render: () => <PromptOrderMarker identifier="worldInfoAfter" label={t("prompt_slot_world_info_after")} tooltip={t("prompt_slot_world_info_after_hint")} kind="marker" enabled={slotEnabled("worldInfoAfter")} onToggle={togglePromptSlot} /> },
    { key: "slot:dialogueExamples", identifier: "dialogueExamples", kind: "slot", defaultOrder: 90, render: () => <PromptOrderMarker identifier="dialogueExamples" label={t("prompt_slot_dialogue_examples")} kind="marker" enabled={slotEnabled("dialogueExamples")} onToggle={togglePromptSlot} /> },
    { key: "field:jailbreak", identifier: "jailbreak", kind: "field", defaultOrder: 110, render: () => <EditablePromptCard identifier="jailbreak" enabled={slotEnabled("jailbreak")} onToggle={togglePromptSlot} label={t("post_history_instructions")} role="system" value={draft?.jailbreak ?? ""} placeholder={t("jailbreak_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("jailbreak", value)} slotLabel={slotLabelFor("jailbreak")} /> },
    { key: "field:assistantPrefill", identifier: "assistantPrefill", kind: "field", defaultOrder: 120, render: () => <EditablePromptCard identifier="assistantPrefill" enabled={slotEnabled("assistantPrefill")} onToggle={togglePromptSlot} label={t("prefill_assistant")} role="assistant" value={draft?.prefill ?? ""} placeholder={t("prefill_placeholder")} disabled={!draft || !onUpdateField} onChange={(value) => onUpdateField?.("prefill", value)} slotLabel={slotLabelFor("assistantPrefill")} /> },
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

  const canvasItems = useMemo(() => [...fixedItems, ...customItems], [fixedItems, customItems]);

  const defaultZones: ZonesState = useMemo(() => {
    const zones: ZonesState = {
      before_chat: [], after_chat: [], depth4: [], depth3: [], depth2: [], depth1: []
    };
    canvasItems.forEach(item => {
      const slot = getCanvasItemSlot(item);
      if (slot.zone === "before_chat") zones.before_chat.push(item);
      else if (slot.zone === "after_chat") zones.after_chat.push(item);
      else if (slot.zone === "in_chat") {
        if (slot.depth === null || slot.depth >= 4) zones.depth4.push(item);
        else if (slot.depth === 3) zones.depth3.push(item);
        else if (slot.depth === 2) zones.depth2.push(item);
        else zones.depth1.push(item);
      }
    });

    for (const key of Object.keys(zones) as Array<keyof ZonesState>) {
      zones[key].sort((a, b) => getCanvasItemSlot(a).order - getCanvasItemSlot(b).order);
    }
    return zones;
  }, [canvasItems]);

  const [activeZones, setActiveZones] = useState<ZonesState | null>(null);

  const zonesToRender = activeZones || defaultZones;

  function findZoneAndIndex(id: string, zones: ZonesState): { zoneKey: keyof ZonesState | null; index: number } {
    if (id === "zone-before_chat") return { zoneKey: "before_chat", index: -1 };
    if (id === "zone-after_chat") return { zoneKey: "after_chat", index: -1 };
    if (id === "depth-4") return { zoneKey: "depth4", index: -1 };
    if (id === "depth-3") return { zoneKey: "depth3", index: -1 };
    if (id === "depth-2") return { zoneKey: "depth2", index: -1 };
    if (id === "depth-1") return { zoneKey: "depth1", index: -1 };

    for (const [key, items] of Object.entries(zones)) {
      const idx = items.findIndex(i => i.key === id);
      if (idx !== -1) return { zoneKey: key as keyof ZonesState, index: idx };
    }
    return { zoneKey: null, index: -1 };
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDragKey(String(event.active.id));
    setActiveZones(defaultZones);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setActiveZones((prev) => {
      if (!prev) return null;
      const activeInfo = findZoneAndIndex(String(active.id), prev);
      const overInfo = findZoneAndIndex(String(over.id), prev);

      if (!activeInfo.zoneKey || !overInfo.zoneKey) return prev;
      if (activeInfo.zoneKey === overInfo.zoneKey) {
        if (activeInfo.index !== overInfo.index && overInfo.index !== -1) {
          return {
            ...prev,
            [activeInfo.zoneKey]: arrayMove(prev[activeInfo.zoneKey], activeInfo.index, overInfo.index)
          };
        }
        return prev;
      }

      const next = { ...prev };
      const activeItem = prev[activeInfo.zoneKey][activeInfo.index];
      
      next[activeInfo.zoneKey] = prev[activeInfo.zoneKey].filter(i => i.key !== active.id);
      
      const newContainerList = [...next[overInfo.zoneKey]];
      const newIndex = overInfo.index !== -1 ? overInfo.index : newContainerList.length;
      newContainerList.splice(newIndex, 0, activeItem);
      next[overInfo.zoneKey] = newContainerList;

      return next;
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragKey(null);
    const { active, over } = event;
    
    setActiveZones((prev) => {
      if (!prev) return null;
      let finalZones: ZonesState = { ...prev };
      
      if (over && active.id !== over.id) {
         const activeInfo = findZoneAndIndex(String(active.id), prev);
         const overInfo = findZoneAndIndex(String(over.id), prev);

         if (activeInfo.zoneKey && overInfo.zoneKey && activeInfo.zoneKey === overInfo.zoneKey && overInfo.index !== -1) {
            finalZones[activeInfo.zoneKey] = arrayMove(prev[activeInfo.zoneKey], activeInfo.index, overInfo.index);
         }
      }

      let nextPromptOrder = [...promptOrder];
      let nextInjections = [...injections];

      const commitList = (list: CanvasItem[], targetZone: PromptZone, targetDepth: number | null) => {
        list.forEach((item, index) => {
          if (item.kind === "custom") {
             const idx = item.injectionIndex;
             const inj = nextInjections[idx];
             const slot = inj.slot ?? migrateInjection(inj).slot;
             nextInjections[idx] = { ...inj, slot: { ...slot, zone: targetZone, depth: targetDepth, order: index }, depth: targetDepth ?? inj.depth };
          } else {
             const idx = nextPromptOrder.findIndex(e => e.identifier === item.identifier);
             if (idx >= 0) {
               nextPromptOrder[idx] = { ...nextPromptOrder[idx], zone: targetZone, depth: targetDepth, order: index };
             } else {
               nextPromptOrder.push({ identifier: item.identifier, enabled: true, zone: targetZone, depth: targetDepth, order: index, kind: "built_in" });
             }
          }
        });
      };

      commitList(finalZones.before_chat, "before_chat", null);
      commitList(finalZones.after_chat, "after_chat", null);
      commitList(finalZones.depth4, "in_chat", 4);
      commitList(finalZones.depth3, "in_chat", 3);
      commitList(finalZones.depth2, "in_chat", 2);
      commitList(finalZones.depth1, "in_chat", 1);

      onPromptOrderChange?.(nextPromptOrder);
      onChange(nextInjections);

      return null;
    });
  }

  const activeDragItem = activeDragKey ? canvasItems.find((item) => item.key === activeDragKey) : null;

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
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDragKey(null)}
      >
        <div className="flex flex-col gap-4">
          
          {/* ZONE 1: BEFORE CHAT */}
          <DroppableDepthContainer id="zone-before_chat" depth="before" label={t("prompt_zone_before_chat")}>
            <SortableContext items={zonesToRender.before_chat.map(i => i.key)} strategy={verticalListSortingStrategy}>
              {zonesToRender.before_chat.map((item) => (
                <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
                  {item.render()}
                </SortableCanvasItem>
              ))}
            </SortableContext>
          </DroppableDepthContainer>

          {/* ZONE 2: CHAT HISTORY ACCORDION */}
          <div className="rounded-md border border-accent/35 bg-accent/10">
            <button
              type="button"
              className="relative flex w-full items-center justify-center px-3 py-2 font-ui text-[12px] font-medium text-accent-t hover:bg-accent/20 transition-colors rounded-t-md"
              onClick={() => setAccordionOpen(!accordionOpen)}
            >
              <span>{t("prompt_slot_chat_history")}</span>
              
              <div className="absolute right-3 flex items-center gap-3">

                <span className="rounded bg-background/40 px-1.5 py-0.5 font-mono text-[10px] text-accent-t">
                  {zonesToRender.depth4.length + zonesToRender.depth3.length + zonesToRender.depth2.length + zonesToRender.depth1.length} items
                </span>
                <span className={cn("shrink-0 text-[11px] text-accent-t/70 transition-transform", accordionOpen && "rotate-90")}>
                  ▶
                </span>
              </div>
            </button>
            
            {accordionOpen && (
              <div className="flex flex-col gap-1 p-2 border-t border-accent/20 bg-surface rounded-b-md">
                <DroppableDepthContainer id="depth-4" depth={4} label="Depth 4+">
                  <SortableContext items={zonesToRender.depth4.map(i => i.key)} strategy={verticalListSortingStrategy}>
                    {zonesToRender.depth4.map((item) => (
                      <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
                        {item.render()}
                      </SortableCanvasItem>
                    ))}
                  </SortableContext>
                </DroppableDepthContainer>

                <div className="mx-2 h-px bg-border/60" />

                <DroppableDepthContainer id="depth-3" depth={3} label="Depth 3">
                  <SortableContext items={zonesToRender.depth3.map(i => i.key)} strategy={verticalListSortingStrategy}>
                    {zonesToRender.depth3.map((item) => (
                      <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
                        {item.render()}
                      </SortableCanvasItem>
                    ))}
                  </SortableContext>
                </DroppableDepthContainer>

                <div className="mx-2 h-px bg-border/60" />

                <DroppableDepthContainer id="depth-2" depth={2} label="Depth 2">
                  <SortableContext items={zonesToRender.depth2.map(i => i.key)} strategy={verticalListSortingStrategy}>
                    {zonesToRender.depth2.map((item) => (
                      <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
                        {item.render()}
                      </SortableCanvasItem>
                    ))}
                  </SortableContext>
                </DroppableDepthContainer>

                <div className="mx-2 h-px bg-border/60" />

                <DroppableDepthContainer id="depth-1" depth={1} label="Depth 1">
                  <SortableContext items={zonesToRender.depth1.map(i => i.key)} strategy={verticalListSortingStrategy}>
                    {zonesToRender.depth1.map((item) => (
                      <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
                        {item.render()}
                      </SortableCanvasItem>
                    ))}
                  </SortableContext>
                </DroppableDepthContainer>
              </div>
            )}
          </div>

          {/* ZONE 3: AFTER CHAT */}
          <DroppableDepthContainer id="zone-after_chat" depth="after" label={t("prompt_zone_after_chat")}>
            <SortableContext items={zonesToRender.after_chat.map(i => i.key)} strategy={verticalListSortingStrategy}>
              {zonesToRender.after_chat.map((item) => (
                <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
                  {item.render()}
                </SortableCanvasItem>
              ))}
            </SortableContext>
          </DroppableDepthContainer>

        </div>
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
    transform: CSS.Translate.toString(transform),
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
      <DragHandleContext.Provider value={{ attributes, listeners, setActivatorNodeRef }}>
        <div className="min-w-0 flex-1">{children}</div>
      </DragHandleContext.Provider>
    </div>
  );
}

function PromptOrderMarker({ identifier, label, kind, enabled = true, onToggle, tooltip }: {
  identifier: string;
  label: string;
  kind: "builtIn" | "marker" | "chat";
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  tooltip?: string;
}) {
  return (
    <div className={cn(
      "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 font-ui text-[12px] transition-colors",
      !enabled && "opacity-55",
      kind === "chat" ? "border-accent/35 bg-accent/10 text-accent-t" :
      kind === "marker" ? "border-border2 bg-s1 text-t4" :
      "border-border bg-s2/70 text-t2",
    )}>
      <DragHandle />
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
      <span className="min-w-0 flex-1 truncate sm:overflow-visible sm:whitespace-normal sm:text-clip">
        {tooltip ? (
          <CustomTooltip content={tooltip}>
            <span className="cursor-help border-b border-dotted border-current pb-0.5">{label}</span>
          </CustomTooltip>
        ) : (
          label
        )}
      </span>
      <span className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] opacity-70">
        {kind === "chat" ? "marker" : kind === "marker" ? "slot" : "read-only"}
      </span>
    </div>
  );
}

function EditablePromptCard({ identifier, enabled = true, onToggle, label, role, value, placeholder, disabled, onChange, slotLabel }: {
  identifier?: string;
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  label: string;
  role: "system" | "user" | "assistant";
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
  slotLabel?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("rounded-md border border-border bg-surface", !enabled && "opacity-55")}>
      <div className="flex min-w-0 cursor-pointer select-none flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-2.5" onClick={() => setExpanded((v) => !v)}>
        <DragHandle disabled={expanded} />
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
        {slotLabel && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">{slotLabel}</span>}
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

function EditableAuthorNoteCard({ identifier, enabled = true, onToggle, draft, onUpdateField, slotLabel, slotDepth, onSlotDepthChange }: {
  identifier?: string;
  enabled?: boolean;
  onToggle?: (identifier: string) => void;
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number) => void;
  slotLabel?: string | null;
  slotDepth?: number | null;
  onSlotDepthChange?: (depth: number) => void;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);

  const disabled = !draft || !onUpdateField;
  const role = draft?.authorsNoteRole ?? "system";
  return (
    <div className={cn("rounded-md border border-border bg-surface", !enabled && "opacity-55")}>
      <div className="flex min-w-0 cursor-pointer select-none flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-2.5" onClick={() => setExpanded((v) => !v)}>
        <DragHandle disabled={expanded} />
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
        {slotLabel && <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">{slotLabel}</span>}
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
            {slotDepth != null && slotDepth >= 4 && (
              <CustomTooltip content={t("insert_depth_label")}>
                <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                  <span className="sr-only">{t("insert_depth_label")}</span>
                  <NumberInput
                    className="h-[30px] w-[90px]"
                    min={4} max={99}
                    value={slotDepth}
                    onChange={(v) => onSlotDepthChange?.(v)}
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
  const slotDepth = injection.slot?.depth ?? injection.depth;
  const showDepthInput = injection.slot?.zone === "in_chat" && slotDepth >= 4;

  return (
    <div className={cn("rounded-md border transition-colors", enabled ? "border-border bg-surface" : "border-border2 bg-s1 opacity-60")}>
      <div
        className="group flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <DragHandle disabled={expanded} />
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

        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t3 tabular-nums">
          ←{slotDepth}
        </span>

        <span className="shrink-0 rounded bg-s2 px-1.5 py-0.5 font-mono text-[10px] text-t4">
          {injection.role}
        </span>

        <span className={cn("shrink-0 text-[11px] text-t4 transition-transform", expanded && "rotate-90")}>
          ▶
        </span>

        <CustomTooltip content={t("preset_injection_delete")}>
        <button type="button"
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t4 transition-all hover:danger-dim hover:text-danger"
          onClick={(e) => { e.stopPropagation(); onRemove(index); }}
        >
          {Ic.del()}
        </button>
        </CustomTooltip>
      </div>

      {expanded && (
        <div className="border-t border-border2 px-3 pb-3 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {showDepthInput && (
              <CustomTooltip content={t("insert_depth_label")}>
                <div className="flex shrink-0 items-center gap-1.5 font-ui text-[11px] text-t4">
                  <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                  <span className="sr-only">{t("insert_depth_label")}</span>
                  <NumberInput
                    className="h-[30px] w-[90px]"
                    min={4} max={99}
                    value={slotDepth}
                    onChange={(v) => onUpdate(index, { depth: v, slot: { ...(injection.slot ?? { zone: "in_chat", depth: 4, order: 0 }), depth: v } })}
                  />
                </div>
              </CustomTooltip>
            )}

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
