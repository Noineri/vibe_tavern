import { useState, useMemo, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CustomInjection, PromptOrderEntry, PromptSlot, PromptZone } from "@vibe-tavern/domain";
import { inferDefaultPromptSlot, inferSlot } from "@vibe-tavern/domain";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { useDndSensors } from "../../../hooks/use-dnd-sensors.js";
import { DragHandleContext } from "./drag-handle.js";
import type { CanvasLoreEntrySummary } from "../../../lib/prompt-canvas-lore.js";
import { buildFixedItems } from "./build-fixed-items.js";
import type { CanvasItem, CanvasRole, CharacterCanvasDraft, PromptCanvasDraft } from "./canvas-shared.js";
import type { LoreAnchorLoadState } from "./LoreAnchorList.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { CanvasCard } from "./rows/CanvasCard.js";
import { CanvasLegend } from "./CanvasLegend.js";

// NOTE (CANVAS_SINGLE_SOURCE_PLAN Wave 4): injection rows are content-only
// `CustomInjection` ({identifier, name, content, role}). ALL positional state
// (enabled/zone/depth/order) lives on the matching `PromptOrderEntry` in
// `promptOrder` — the canvas is the single source of truth.

// `CharacterCanvasDraft` + `CanvasItem` now live in `canvas-shared.ts` (shared with
// `build-fixed-items.tsx` + the row components); re-exported here for
// `PromptManagerModal` + the characterization test, which import it from here.
export type { CharacterCanvasDraft };

interface InjectionTableProps {
  injections: CustomInjection[];
  onChange: (injections: CustomInjection[]) => void;
  draft?: PromptCanvasDraft | null;
  onUpdateField?: (key: keyof PromptCanvasDraft, value: string | number | boolean) => void;
  characterDraft?: CharacterCanvasDraft | null;
  onCharacterFieldUpdate?: (key: keyof CharacterCanvasDraft, value: string | number) => void;
  personaDescription?: string | null;
  onPersonaDescriptionUpdate?: (value: string) => void;
  loreAnchorEntries?: CanvasLoreEntrySummary[];
  loreAnchorLoadState?: LoreAnchorLoadState;
  promptOrder?: PromptOrderEntry[];
  onPromptOrderChange?: (promptOrder: PromptOrderEntry[]) => void;
}

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

type ZonesState = {
  before_chat: CanvasItem[];
  after_chat: CanvasItem[];
  depth4: CanvasItem[];
  depth3: CanvasItem[];
  depth2: CanvasItem[];
  depth1: CanvasItem[];
};

/** Drop-zone container ids → ZonesState keys. Replaces the former 6-rung
 *  if-ladder in `findZoneAndIndex` with a single lookup. The ids match the `id`
 *  props passed to `<SortableZone>` in the canvas JSX below. */
const ZONE_ID_TO_KEY: Record<string, keyof ZonesState> = {
  "zone-before_chat": "before_chat",
  "zone-after_chat": "after_chat",
  "depth-4": "depth4",
  "depth-3": "depth3",
  "depth-2": "depth2",
  "depth-1": "depth1",
};

/** A single sortable zone: a droppable container wrapping one SortableContext
 *  of canvas items. Collapses the 6× copy-pasted zone blocks (before_chat, the
 *  4 depth tiers, after_chat) into one parameterized component — only the id,
 *  label, depth, and items differ between zones. Behavior is identical to the
 *  inline `<DroppableDepthContainer><SortableContext>…</…>` it replaces. */
function SortableZone({ id, label, depth, items, activeDragKey }: {
  id: string;
  label: string;
  depth: number | "before" | "after";
  items: CanvasItem[];
  activeDragKey: string | null;
}) {
  return (
    <DroppableDepthContainer id={id} depth={depth} label={label}>
      <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <SortableCanvasItem key={item.key} id={item.key} overlayActive={item.key === activeDragKey}>
            {item.render()}
          </SortableCanvasItem>
        ))}
      </SortableContext>
    </DroppableDepthContainer>
  );
}

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
export function PromptOrderCanvas({
  injections,
  onChange,
  draft,
  onUpdateField,
  characterDraft,
  onCharacterFieldUpdate,
  personaDescription,
  onPersonaDescriptionUpdate,
  loreAnchorEntries,
  loreAnchorLoadState,
  promptOrder = [],
  onPromptOrderChange,
}: InjectionTableProps) {
  const { t } = useT();
  const [activeDragKey, setActiveDragKey] = useState<string | null>(null);
  const [accordionOpen, setAccordionOpen] = useState(false);
  
  const sensors = useDndSensors();

  // Single read index over `promptOrder`. Every slot helper below reads the
  // canvas entry for an identifier O(1) via this Map instead of an O(N)
  // `promptOrder.find()` — the former `defaultZones` sort comparator turned
  // the read path into O(N²logN); this collapses it to O(NlogN). Rebuilt only
  // when `promptOrder` changes.
  const orderByIdentifier = useMemo(
    () => new Map(promptOrder.map((e) => [e.identifier, e] as const)),
    [promptOrder],
  );

  // Content-only write: `name`/`content`/`role` live on the injection.
  // Positional state (`enabled`/`zone`/`depth`/`order`) is written via the
  // dedicated canvas callbacks (togglePromptSlot / updateSlotDepth) — never here.
  function update(index: number, patch: Partial<CustomInjection>) {
    onChange(injections.map((inj, i) => i === index ? { ...inj, ...patch } : inj));
  }
  function remove(index: number) {
    const removed = injections[index];
    const identifier = removed ? customIdentifier(removed, index) : null;
    onChange(injections.filter((_, i) => i !== index));
    // Drop the matching canvas entry too so the deleted content isn't orphaned
    // (keeps the 1:1 injection<->custom-entry invariant, I3).
    if (identifier) {
      onPromptOrderChange?.(promptOrder.filter((e) => e.identifier !== identifier));
    }
  }
  function add() {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const identifier = `custom_${suffix}`;
    // Content entry + canvas entry appended together (spec point 2).
    // `order: 999` sorts last among before_chat defaults (max ~75); dense-
    // renumbered on the next drag via commitList (I6).
    onChange([...injections, { identifier, name: "", content: "", role: "system" }]);
    onPromptOrderChange?.([
      ...promptOrder,
      { identifier, enabled: true, kind: "custom" as const, zone: "before_chat" as const, depth: null, order: 999 },
    ]);
  }
  function defaultBuiltInEntry(identifier: string): PromptOrderEntry {
    const slot = inferDefaultPromptSlot(identifier);
    return {
      identifier,
      enabled: true,
      kind: "built_in",
      zone: slot.zone,
      depth: slot.depth,
      order: slot.order,
    };
  }

  function togglePromptSlot(identifier: string) {
    const existing = orderByIdentifier.get(identifier);
    const enabled = existing?.enabled ?? true;
    const next = existing
      ? promptOrder.map((entry) => entry.identifier === identifier ? { ...entry, enabled: !enabled } : entry)
      : [...promptOrder, { ...defaultBuiltInEntry(identifier), enabled: false }];
    onPromptOrderChange?.(next);
  }
  function slotEnabled(identifier: string) {
    return orderByIdentifier.get(identifier)?.enabled ?? true;
  }
  function customIdentifier(injection: CustomInjection, index: number) {
    return injection.identifier || `custom_${index}`;
  }

  function resolvedSlot(identifier: string): PromptSlot {
    const entry = orderByIdentifier.get(identifier);
    return entry?.zone
      ? { zone: entry.zone, depth: entry.depth ?? null, order: entry.order ?? inferDefaultPromptSlot(identifier).order }
      : inferDefaultPromptSlot(identifier);
  }

  function slotLabelFor(identifier: string): string | null {
    const slot = resolvedSlot(identifier);
    if (slot.zone === "before_chat") return null;
    if (slot.zone === "after_chat") return "after";
    return `←${slot.depth ?? 4}`;
  }

  function slotDepthFor(identifier: string): number | null {
    const slot = resolvedSlot(identifier);
    return slot.zone === "in_chat" ? (slot.depth ?? 4) : null;
  }

  function slotRoleFor(identifier: string, fallback: CanvasRole): CanvasRole {
    return orderByIdentifier.get(identifier)?.role ?? fallback;
  }

  function updateSlotDepth(identifier: string, depth: number) {
    const existing = orderByIdentifier.get(identifier);
    const next = existing
      ? promptOrder.map((entry) => entry.identifier === identifier ? { ...entry, depth } : entry)
      : [...promptOrder, { ...defaultBuiltInEntry(identifier), zone: "in_chat" as const, depth }];
    onPromptOrderChange?.(next);
  }

  function updateSlotRole(identifier: string, role: CanvasRole) {
    const existing = orderByIdentifier.get(identifier);
    const next = existing
      ? promptOrder.map((entry) => entry.identifier === identifier ? { ...entry, role } : entry)
      : [...promptOrder, { ...defaultBuiltInEntry(identifier), role }];
    onPromptOrderChange?.(next);
  }

  // Single read path: positional state comes ONLY from the `promptOrder`
  // entry (the canvas). Custom items no longer carry `slot` — they read the
  // SAME canvas entry as built-ins. Falls back to the domain's per-identifier
  // default slot when no canvas entry exists yet (charDepthPrompt is the one
  // non-relative default: in_chat depth 4).
  function getCanvasItemSlot(item: CanvasItem): PromptSlot {
    const existingOrder = orderByIdentifier.get(item.identifier);
    if (existingOrder?.zone) {
      return { zone: existingOrder.zone, depth: existingOrder.depth ?? null, order: existingOrder.order ?? item.defaultOrder };
    }
    return inferDefaultPromptSlot(item.identifier, existingOrder?.order ?? item.defaultOrder);
  }

  const fixedItems = buildFixedItems({
    t,
    draft,
    onUpdateField,
    characterDraft,
    onCharacterFieldUpdate,
    personaDescription,
    onPersonaDescriptionUpdate,
    loreAnchorEntries,
    loreAnchorLoadState,
    slotEnabled,
    togglePromptSlot,
    slotLabelFor,
    slotDepthFor,
    slotRoleFor,
    updateSlotDepth,
    updateSlotRole,
  });

  // Prefill is special: always last, not draggable
  const prefillItem = fixedItems.find(i => i.identifier === "assistantPrefill");
  const canvasFixedItems = fixedItems.filter(i => i.identifier !== "assistantPrefill");

  const customItems: CanvasItem[] = injections.map((inj, i) => {
    const identifier = customIdentifier(inj, i);
    // A canvas entry should always exist (built at import/apply — Wave 3); this
    // defaultOrder is only an `inferSlot` fallback if it's somehow missing.
    const defaultOrder = 70 + i;
    return {
      key: `custom:${identifier}`,
      identifier,
      kind: "custom" as const,
      defaultOrder,
      injectionIndex: i,
      render: () => {
        const entry = orderByIdentifier.get(identifier);
        const slot: PromptSlot = entry?.zone
          ? { zone: entry.zone, depth: entry.depth ?? null, order: entry.order ?? defaultOrder }
          : inferSlot({ defaultOrder, order: defaultOrder });
        return (
          <CanvasCard
            identifier={identifier}
            category="custom"
            label={inj.name || t("preset_injection_name")}
            editableName={{ value: inj.name, placeholder: t("preset_injection_name"), onRename: (name) => update(i, { name }) }}
            enabled={entry?.enabled ?? true}
            onToggle={() => togglePromptSlot(identifier)}
            value={inj.content}
            placeholder={t("preset_injection_content")}
            onChange={(v) => update(i, { content: v })}
            role={inj.role}
            onRoleChange={(r) => update(i, { role: r })}
            slotLabel={slot.zone === "in_chat" ? "in-chat" : slot.zone === "after_chat" ? t("after_badge") : null}
            slotDepth={slot.depth}
            onSlotDepthChange={(d) => updateSlotDepth(identifier, d)}
            onRemove={() => remove(i)}
          />
        );
      },
    };
  });

  // NOTE: `canvasItems` and `defaultZones` below are intentionally NOT memoized.
  // `fixedItems`/`customItems` are rebuilt each render (they close over `t`,
  // `draft`, `characterDraft`, and the slot helpers), so a useMemo over them
  // would bust every render anyway — the former useMemo wrappers were no-ops
  // that only misled. With the `orderByIdentifier` Map index above, the
  // `defaultZones` build is O(N·log N) (the sort comparator reads the Map in
  // O(1)), cheap at the canvas's ~15-20 items. The DnD invariant is unaffected:
  // `activeZones` (null-on-start, no useEffect sync) is independent state — see
  // the WARNING above.
  const canvasItems = [...canvasFixedItems, ...customItems];

  const defaultZones: ZonesState = (() => {
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
  })();

  const [activeZones, setActiveZones] = useState<ZonesState | null>(null);

  const zonesToRender = activeZones || defaultZones;

  function findZoneAndIndex(id: string, zones: ZonesState): { zoneKey: keyof ZonesState | null; index: number } {
    const zoneKey = ZONE_ID_TO_KEY[id];
    if (zoneKey) return { zoneKey, index: -1 };

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

      // Unified single write: EVERY item (built-in + custom) commits positional
      // state to its `promptOrder` entry with a dense zone-local `order` (= the
      // visual index). Custom items are content-only, so drag NEVER touches
      // `customInjections` (I2, I6). D1: in_chat zones pass depth ≥ 1
      // (1/2/3/4) — never 0 — so they cannot collide with after_chat (pinned at
      // depth 0). See the ordering model.
      let nextPromptOrder = [...promptOrder];

      const commitList = (list: CanvasItem[], targetZone: PromptZone, targetDepth: number | null) => {
        list.forEach((item, index) => {
          const idx = nextPromptOrder.findIndex(e => e.identifier === item.identifier);
          const existing = idx >= 0 ? nextPromptOrder[idx] : null;
          const entry: PromptOrderEntry = {
            identifier: item.identifier,
            enabled: existing?.enabled ?? true,
            zone: targetZone,
            depth: targetDepth,
            order: index,
            kind: item.kind === "custom" ? "custom" : (existing?.kind ?? "built_in"),
          };
          if (idx >= 0) nextPromptOrder[idx] = entry;
          else nextPromptOrder.push(entry);
        });
      };

      commitList(finalZones.before_chat, "before_chat", null);
      commitList(finalZones.after_chat, "after_chat", null);
      commitList(finalZones.depth4, "in_chat", 4);
      commitList(finalZones.depth3, "in_chat", 3);
      commitList(finalZones.depth2, "in_chat", 2);
      commitList(finalZones.depth1, "in_chat", 1);

      onPromptOrderChange?.(nextPromptOrder);

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
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Checkbox
            checked={draft?.mergeConsecutiveRoles ?? false}
            disabled={!draft || !onUpdateField}
            onChange={(checked) => onUpdateField?.("mergeConsecutiveRoles", checked)}
            title={t("merge_consecutive_roles_hint")}
            label={<span className="font-ui text-[11px]">{t("merge_consecutive_roles")}</span>}
          />
          <button type="button"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border bg-surface px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-all hover:border-accent hover:text-accent-t"
            onClick={add}
          >
            + {t("preset_injection_add")}
          </button>
        </div>
      </div>

      <CanvasLegend />

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
          <SortableZone id="zone-before_chat" label={t("prompt_zone_before_chat")} depth="before" items={zonesToRender.before_chat} activeDragKey={activeDragKey} />

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
                  {zonesToRender.depth4.length + zonesToRender.depth3.length + zonesToRender.depth2.length + zonesToRender.depth1.length} {t("injection_items_label")}
                </span>
                <span className={cn("shrink-0 text-[11px] text-accent-t/70 transition-transform", accordionOpen && "rotate-90")}>
                  ▶
                </span>
              </div>
            </button>
            
            {accordionOpen && (
              <div className="flex flex-col gap-1 p-2 border-t border-accent/20 bg-surface rounded-b-md">
                <SortableZone id="depth-4" label={t("depth_zone_4plus")} depth={4} items={zonesToRender.depth4} activeDragKey={activeDragKey} />

                <div className="mx-2 h-px bg-border/60" />

                <SortableZone id="depth-3" label={t("depth_zone_3")} depth={3} items={zonesToRender.depth3} activeDragKey={activeDragKey} />

                <div className="mx-2 h-px bg-border/60" />

                <SortableZone id="depth-2" label={t("depth_zone_2")} depth={2} items={zonesToRender.depth2} activeDragKey={activeDragKey} />

                <div className="mx-2 h-px bg-border/60" />

                <SortableZone id="depth-1" label={t("depth_zone_1")} depth={1} items={zonesToRender.depth1} activeDragKey={activeDragKey} />
              </div>
            )}
          </div>

          {/* ZONE 3: AFTER CHAT */}
          <SortableZone id="zone-after_chat" label={t("prompt_zone_after_chat")} depth="after" items={zonesToRender.after_chat} activeDragKey={activeDragKey} />

          {/* Prefill: pinned, not draggable */}
          {prefillItem && (
            <div className="rounded-md border border-transparent p-1">
              {prefillItem.render()}
            </div>
          )}

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
