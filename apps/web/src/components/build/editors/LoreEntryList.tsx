/**
 * LoreEntryList — drag-and-drop list of lore entries grouped by prompt position.
 *
 * Desktop: entire card is draggable (mouse sensor with distance constraint
 * preserves click). Visual indicator: centered grab bar at top edge.
 * Mobile: ≡ handle on the left is the drag trigger, 44px touch target.
 * Cross-section drag changes position + sortOrder.
 */

import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { cn } from "../../../lib/cn.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import type { LoreEntryRecord } from "../../../app-client.js";

// ── Position config ──────────────────────────────────────────────────────

interface PositionSection {
  value: string;
  label: string;
  labelRu: string;
}

const POSITION_SECTIONS: PositionSection[] = [
  { value: "before_char", label: "Before Character", labelRu: "Перед персонажем" },
  { value: "after_char", label: "After Character", labelRu: "После персонажа" },
  { value: "top_an", label: "Before Author's Note", labelRu: "Перед заметкой автора" },
  { value: "bottom_an", label: "After Author's Note", labelRu: "После заметки автора" },
  { value: "before_examples", label: "Before Examples", labelRu: "Перед примерами" },
  { value: "after_examples", label: "After Examples", labelRu: "После примеров" },
  { value: "at_depth", label: "In Chat (at depth)", labelRu: "В чате (на глубине)" },
  { value: "outlet", label: "Outlet", labelRu: "Outlet" },
];

const FALLBACK_SECTION: PositionSection = POSITION_SECTIONS[1]; // after_char

function normalizeUiPosition(position: string | undefined): string {
  switch (position) {
    // Legacy canonical prompt-layer positions from the old importer.
    // Do not expose these as lorebook UI sections.
    case "before_prompt":
      return "before_char";
    case "in_prompt":
      return "after_char";
    case "in_chat":
      return "at_depth";
    case "hidden_system":
      return "outlet";
    default:
      return position ?? FALLBACK_SECTION.value;
  }
}

function getSection(position: string | undefined): PositionSection {
  const normalized = normalizeUiPosition(position);
  return POSITION_SECTIONS.find((s) => s.value === normalized) ?? FALLBACK_SECTION;
}

// ── Debug helpers ──────────────────────────────────────────────────────

const DND_DEBUG_FLAG = "vt:loreDndDebug";

function isDndDebugEnabled(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(DND_DEBUG_FLAG) === "1";
}

function snapRect(node: HTMLElement | null | undefined) {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return {
    top: Math.round(rect.top * 100) / 100,
    left: Math.round(rect.left * 100) / 100,
    bottom: Math.round(rect.bottom * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
    transform: style.transform,
    transition: style.transition,
    opacity: style.opacity,
    display: style.display,
    visibility: style.visibility,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
  };
}

function debugLog(label: string, payload: Record<string, unknown>) {
  if (!isDndDebugEnabled()) return;
  // Log as plain JSON so it can be copied without expanding DevTools objects.
  // eslint-disable-next-line no-console
  console.log(`[LoreDnD] ${label}`, JSON.stringify(payload));
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [item] = next.splice(from, 1);
  if (!item) return items;
  next.splice(to, 0, item);
  return next;
}

function entryOrderSignature(items: LoreEntryRecord[]): string {
  return items.map((entry) => `${entry.id}:${getSection(entry.position).value}`).join("|");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

interface DragPoint {
  x: number;
  y: number;
}

interface ScrollSnapshot {
  node: Element | Window;
  top: number;
  left: number;
}

function getTouchPoint(event: Event): DragPoint | null {
  if (typeof TouchEvent === "undefined" || !(event instanceof TouchEvent)) return null;
  const touch = event.touches[0] ?? event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function getScrollPosition(node: Element | Window): DragPoint {
  if (node === window) return { x: window.scrollX, y: window.scrollY };
  const element = node as Element;
  return { x: element.scrollLeft, y: element.scrollTop };
}

function getScrollSnapshots(node: HTMLElement | null): ScrollSnapshot[] {
  const snapshots: ScrollSnapshot[] = [];
  for (let parent = node?.parentElement ?? null; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight;
    const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth;
    if (canScrollY || canScrollX) {
      const position = getScrollPosition(parent);
      snapshots.push({ node: parent, top: position.y, left: position.x });
    }
  }
  const windowPosition = getScrollPosition(window);
  snapshots.push({ node: window, top: windowPosition.y, left: windowPosition.x });
  return snapshots;
}

function getScrollDelta(snapshots: ScrollSnapshot[]): DragPoint {
  return snapshots.reduce(
    (sum, snapshot) => {
      const now = getScrollPosition(snapshot.node);
      return { x: sum.x + now.x - snapshot.left, y: sum.y + now.y - snapshot.top };
    },
    { x: 0, y: 0 }
  );
}

// ── Props ──────────────────────────────────────────────────────────────

interface OverlayRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface DragPreviewItem {
  id: string;
  node: HTMLElement;
  rect: DOMRect;
  index: number;
}

interface LoreEntryListProps {
  entries: LoreEntryRecord[];
  activeEntryId: string | null;
  isMobile: boolean;
  isRu: boolean;
  t: (key: string) => string;
  onEntryClick: (entryId: string) => void;
  onReorder: (updates: Array<{ id: string; sortOrder: number; position?: string }>) => void | Promise<unknown>;
}

interface EntryCardVisualProps {
  entry: LoreEntryRecord;
  isActive: boolean;
  isMobile: boolean;
  t: (key: string) => string;
  onClick?: () => void;
  rootRef?: (node: HTMLElement | null) => void;
  mobileHandleRef?: (node: HTMLElement | null) => void;
  style?: CSSProperties;
  rootProps?: HTMLAttributes<HTMLDivElement>;
  mobileHandleProps?: HTMLAttributes<HTMLDivElement>;
  draggingPlaceholder?: boolean;
  overlay?: boolean;
}

function EntryCardVisual({
  entry,
  isActive,
  isMobile,
  t,
  onClick,
  rootRef,
  mobileHandleRef,
  style,
  rootProps,
  mobileHandleProps,
  draggingPlaceholder = false,
  overlay = false,
}: EntryCardVisualProps) {
  return (
    <div
      ref={rootRef}
      data-lore-dnd={overlay ? "overlay" : "source"}
      data-lore-entry-id={entry.id}
      style={style}
      className={cn(
        "relative rounded-lg border transition-shadow min-h-[44px]",
        isMobile && "flex",
        !isMobile && !overlay && "cursor-grab active:cursor-grabbing",
        isActive
          ? "border-accent bg-accent-dim"
          : "border-border bg-surface hover:bg-s2",
        draggingPlaceholder && "opacity-0",
        overlay && "pointer-events-none shadow-lg"
      )}
      {...rootProps}
    >
      {/* Desktop: centered under the card's top edge, visual only. */}
      {!isMobile && (
        <div className="pointer-events-none absolute left-1/2 top-1.5 z-10 -translate-x-1/2">
          <div className="h-[4px] w-11 rounded-full bg-t3/25 shadow-sm" />
        </div>
      )}

      {/* Mobile: left-side dedicated drag handle. */}
      {isMobile && (
        <div
          ref={mobileHandleRef}
          className={cn(
            "flex w-12 shrink-0 select-none items-center justify-center rounded-l-lg text-t3",
            !overlay && "cursor-grab touch-none active:cursor-grabbing active:bg-s2"
          )}
          style={{ touchAction: "none" }}
          onClick={(e) => e.stopPropagation()}
          {...mobileHandleProps}
        >
          <span className="text-xl leading-none">≡</span>
        </div>
      )}

      {/* Card content */}
      <div className="min-w-0 flex-1 px-3.5 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              entry.enabled ? "bg-success" : "bg-t3"
            )}
          />
          <span
            className={cn(
              "flex-1 truncate text-[13px] font-medium",
              entry.enabled ? "text-t1" : "text-t3 line-through"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onClick?.();
            }}
          >
            {entry.title || t("lore_no_entries")}
          </span>
        </div>

        {/* Clickable content area below title */}
        <div className={cn(onClick && "cursor-pointer")} onClick={onClick}>
          <div className="mt-1 truncate font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
            {entry.keys.length > 0
              ? `keys: ${entry.keys.join(", ")}`
              : t("lore_no_entries")}
          </div>
          {entry.content && (
            <div
              className="mt-1.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {entry.content}
            </div>
          )}
          {entry.content && (
            <TokenCounter
              text={entry.content}
              className="mt-1 flex justify-end font-ui text-[11px] tabular-nums text-t3/50"
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Draggable Entry Card ───────────────────────────────────────────────

function DraggableEntryCard({
  entry,
  isActive,
  isMobile,
  t,
  onClick,
  hideSourceWhileDragging,
}: {
  entry: LoreEntryRecord;
  isActive: boolean;
  isMobile: boolean;
  t: (key: string) => string;
  onClick: () => void;
  hideSourceWhileDragging: boolean;
}) {
  const sourceNodeRef = useRef<HTMLElement | null>(null);
  const activatorNodeRef = useRef<HTMLElement | null>(null);
  const lastStableRectRef = useRef<ReturnType<typeof snapRect>>(null);

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: entry.id,
  });

  const handleRootRef = useCallback(
    (node: HTMLElement | null) => {
      sourceNodeRef.current = node;
      setNodeRef(node);
      if (!isMobile) {
        activatorNodeRef.current = node;
        setActivatorNodeRef(node);
      }
    },
    [isMobile, setActivatorNodeRef, setNodeRef]
  );

  const handleMobileHandleRef = useCallback(
    (node: HTMLElement | null) => {
      activatorNodeRef.current = node;
      setActivatorNodeRef(node);
    },
    [setActivatorNodeRef]
  );

  useLayoutEffect(() => {
    if (!isDndDebugEnabled()) return;

    if (!isDragging) {
      lastStableRectRef.current = snapRect(sourceNodeRef.current);
      return;
    }

    debugLog("source isDragging layout", {
      id: entry.id,
      title: entry.title,
      isMobile,
      stableBeforeDrag: lastStableRectRef.current,
      sourceNow: snapRect(sourceNodeRef.current),
      activatorNow: snapRect(activatorNodeRef.current),
      parentNow: snapRect(sourceNodeRef.current?.parentElement ?? null),
    });

    const raf1 = window.requestAnimationFrame(() => {
      debugLog("source raf+1", {
        id: entry.id,
        source: snapRect(sourceNodeRef.current),
        activator: snapRect(activatorNodeRef.current),
        parent: snapRect(sourceNodeRef.current?.parentElement ?? null),
      });
    });
    const raf2 = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        debugLog("source raf+2", {
          id: entry.id,
          source: snapRect(sourceNodeRef.current),
          activator: snapRect(activatorNodeRef.current),
          parent: snapRect(sourceNodeRef.current?.parentElement ?? null),
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [entry.id, entry.title, isDragging, isMobile]);

  const style: CSSProperties = {
    // The fixed manual overlay is the only moving representation of the active
    // card. The source stays in normal layout as a stable placeholder.
    transition: isDragging ? "none" : "box-shadow 120ms ease",
    zIndex: isDragging ? 0 : undefined,
  };

  return (
    <EntryCardVisual
      entry={entry}
      isActive={isActive}
      isMobile={isMobile}
      t={t}
      onClick={onClick}
      rootRef={handleRootRef}
      style={style}
      rootProps={!isMobile ? { ...attributes, ...listeners } : undefined}
      mobileHandleRef={isMobile ? handleMobileHandleRef : undefined}
      mobileHandleProps={isMobile ? { ...attributes, ...listeners } : undefined}
      draggingPlaceholder={hideSourceWhileDragging}
    />
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export function LoreEntryList({
  entries,
  activeEntryId,
  isMobile,
  isRu,
  t,
  onEntryClick,
  onReorder,
}: LoreEntryListProps) {
  // DnD architecture note:
  // We intentionally use @dnd-kit/core only, not @dnd-kit/sortable. Sortable's
  // React-driven layout preview caused first-frame jumps in the lorebook
  // accordion/flex layout. During drag we keep React order unchanged, move a
  // fixed portal overlay manually, and apply sibling preview transforms directly
  // to DOM nodes from cached rects. The only real reorder happens on drag end.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overlayRect, setOverlayRect] = useState<OverlayRect | null>(null);
  const [overlayHasMoved, setOverlayHasMoved] = useState(false);
  const [optimisticEntries, setOptimisticEntries] = useState<LoreEntryRecord[] | null>(null);
  const overlayNodeRef = useRef<HTMLElement | null>(null);
  const overlayWrapperRef = useRef<HTMLDivElement | null>(null);
  const overlayRectRef = useRef<OverlayRect | null>(null);
  const overlayTransformRef = useRef("translate3d(0, 0, 0)");
  const overlayBaselineDeltaRef = useRef<{ x: number; y: number } | null>(null);
  const dragInputTypeRef = useRef<"mouse" | "touch" | "unknown">("unknown");
  const touchStartPointRef = useRef<DragPoint | null>(null);
  const touchCurrentPointRef = useRef<DragPoint | null>(null);
  const dragScrollSnapshotsRef = useRef<ScrollSnapshot[]>([]);
  const dragPreviewItemsRef = useRef<DragPreviewItem[]>([]);
  const dragSourceIndexRef = useRef<number | null>(null);
  const dragTargetIndexRef = useRef<number | null>(null);
  const dragSlotSizeRef = useRef(0);
  const lastDebugOverRef = useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      // Keep a small distance so clicks still open the editor, but avoid the
      // visible catch-up jump caused by waiting until the pointer moved 6–13px.
      activationConstraint: { distance: 2 },
    }),
    useSensor(TouchSensor, {
      // Mobile uses a dedicated 44px handle with touch-action:none, so we can
      // activate almost immediately. A larger threshold combines badly with
      // touch move coalescing and makes the overlay feel like it trails the
      // finger.
      activationConstraint: { distance: 1 },
    })
  );

  const displayEntries = optimisticEntries ?? entries;

  useEffect(() => {
    if (!optimisticEntries) return;
    if (entryOrderSignature(entries) === entryOrderSignature(optimisticEntries)) {
      setOptimisticEntries(null);
    }
  }, [entries, optimisticEntries]);

  useEffect(() => {
    if (activeDragId === null || dragInputTypeRef.current !== "touch") return;

    const handleTouchMove = (event: TouchEvent) => {
      const point = getTouchPoint(event);
      if (point) touchCurrentPointRef.current = point;
    };

    // Keep a live viewport-space touch point. dnd-kit deltas can include scroll
    // compensation when an inner mobile panel autoscrolls near the edge; the
    // manual fixed overlay should instead stay attached to the finger.
    window.addEventListener("touchmove", handleTouchMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener("touchmove", handleTouchMove, { capture: true });
    };
  }, [activeDragId]);

  // Group entries by position for rendering (memoized)
  const grouped = useMemo(() => {
    const map = new Map<string, LoreEntryRecord[]>();
    for (const sec of POSITION_SECTIONS) {
      map.set(sec.value, []);
    }
    for (const entry of displayEntries) {
      const key = getSection(entry.position).value;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry);
    }
    return map;
  }, [displayEntries]);

  const renderedEntries = useMemo(
    () => POSITION_SECTIONS.flatMap((sec) => grouped.get(sec.value) ?? []),
    [grouped]
  );

  const activeEntry = useMemo(
    () => displayEntries.find((entry) => entry.id === activeDragId) ?? null,
    [activeDragId, displayEntries]
  );

  const clearPreviewTransforms = useCallback(() => {
    for (const item of dragPreviewItemsRef.current) {
      item.node.style.transform = "";
      item.node.style.transition = "";
      item.node.style.willChange = "";
    }
  }, []);

  const resetDragState = useCallback(() => {
    clearPreviewTransforms();
    setActiveDragId(null);
    setOverlayRect(null);
    setOverlayHasMoved(false);
    overlayNodeRef.current = null;
    overlayWrapperRef.current = null;
    overlayRectRef.current = null;
    overlayTransformRef.current = "translate3d(0, 0, 0)";
    overlayBaselineDeltaRef.current = null;
    dragInputTypeRef.current = "unknown";
    touchStartPointRef.current = null;
    touchCurrentPointRef.current = null;
    dragScrollSnapshotsRef.current = [];
    dragPreviewItemsRef.current = [];
    dragSourceIndexRef.current = null;
    dragTargetIndexRef.current = null;
    dragSlotSizeRef.current = 0;
    lastDebugOverRef.current = null;
  }, [clearPreviewTransforms]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const activatorEvent = event.activatorEvent;
    dragInputTypeRef.current =
      typeof TouchEvent !== "undefined" && activatorEvent instanceof TouchEvent
        ? "touch"
        : typeof MouseEvent !== "undefined" && activatorEvent instanceof MouseEvent
          ? "mouse"
          : "unknown";
    const initialTouchPoint = getTouchPoint(activatorEvent);
    touchStartPointRef.current = initialTouchPoint;
    touchCurrentPointRef.current = initialTouchPoint;

    const dndRect = event.active.rect.current.initial;
    const activeId = event.active.id as string;
    const sourceNode = document.querySelector(
      `[data-lore-entry-id="${window.CSS.escape(activeId)}"][data-lore-dnd="source"]`
    ) as HTMLElement | null;
    const sourceRect = sourceNode?.getBoundingClientRect() ?? null;
    const nextOverlayRect = dndRect
      ? {
          top: dndRect.top,
          left: dndRect.left,
          width: dndRect.width,
          height: dndRect.height,
        }
      : sourceRect
        ? {
            top: sourceRect.top,
            left: sourceRect.left,
            width: sourceRect.width,
            height: sourceRect.height,
          }
        : null;

    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-lore-entry-id][data-lore-dnd="source"]')
    );
    const previewItems = nodes.map((node, index) => ({
      id: node.dataset.loreEntryId ?? "",
      node,
      rect: node.getBoundingClientRect(),
      index,
    })).filter((item) => item.id);
    const sourceIndex = previewItems.findIndex((item) => item.id === activeId);
    const sourceItem = sourceIndex >= 0 ? previewItems[sourceIndex] : null;
    const neighbor = sourceItem
      ? previewItems.find((item) => item.node.parentElement === sourceItem.node.parentElement && item.index > sourceIndex)
        ?? [...previewItems].reverse().find((item) => item.node.parentElement === sourceItem.node.parentElement && item.index < sourceIndex)
      : null;
    const measuredGap = sourceItem && neighbor
      ? Math.max(0, Math.min(24, Math.abs(neighbor.rect.top - sourceItem.rect.top) - sourceItem.rect.height))
      : 6;

    dragPreviewItemsRef.current = previewItems;
    dragScrollSnapshotsRef.current = getScrollSnapshots(sourceNode);
    dragSourceIndexRef.current = sourceIndex >= 0 ? sourceIndex : null;
    dragTargetIndexRef.current = sourceIndex >= 0 ? sourceIndex : null;
    dragSlotSizeRef.current = (sourceRect?.height ?? nextOverlayRect?.height ?? sourceItem?.rect.height ?? 0) + measuredGap;

    debugLog("drag start", {
      activeId,
      dndInitialRect: dndRect
        ? {
            top: Math.round(dndRect.top * 100) / 100,
            left: Math.round(dndRect.left * 100) / 100,
            width: Math.round(dndRect.width * 100) / 100,
            height: Math.round(dndRect.height * 100) / 100,
          }
        : null,
      sourceQueryRect: snapRect(sourceNode),
      overlayRect: nextOverlayRect,
      previewCount: previewItems.length,
      sourceIndex,
      measuredGap,
      slotSize: dragSlotSizeRef.current,
      scrollY: window.scrollY,
      inputType: dragInputTypeRef.current,
      initialTouchPoint,
      scrollSnapshots: dragScrollSnapshotsRef.current.map((snapshot) => ({
        node: snapshot.node === window ? "window" : (snapshot.node as Element).tagName,
        top: snapshot.top,
        left: snapshot.left,
      })),
      activeElement: document.activeElement?.tagName,
    });

    // In this app/version, event.active.rect.current.initial can be null on
    // drag start. Flush a manual overlay using the live DOM rect fallback so
    // the source does not disappear for a frame before the visible clone exists.
    flushSync(() => {
      overlayTransformRef.current = "translate3d(0, 0, 0)";
      overlayRectRef.current = nextOverlayRect;
      overlayBaselineDeltaRef.current = null;
      setOverlayHasMoved(false);
      setActiveDragId(activeId);
      setOverlayRect(nextOverlayRect);
    });

    window.requestAnimationFrame(() => {
      debugLog("drag start raf overlay", {
        activeId,
        manualOverlayWrapper: snapRect(overlayWrapperRef.current),
        manualOverlayCard: snapRect(overlayNodeRef.current),
        sourceQueryRect: snapRect(sourceNode),
      });
    });
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const node = overlayWrapperRef.current;
    if (!node) return;

    // Desktop needs first-delta normalization to hide the 2px activation
    // threshold "catch-up" snap. Touch is different: move events can be
    // coalesced, so subtracting the first delta creates a persistent offset that
    // feels like the card is lagging behind the finger. The mobile handle uses a
    // tiny activation distance instead and follows the raw touch delta.
    if (!overlayBaselineDeltaRef.current) {
      overlayBaselineDeltaRef.current =
        dragInputTypeRef.current === "touch" ? { x: 0, y: 0 } : { x: event.delta.x, y: event.delta.y };
    }

    const base = overlayBaselineDeltaRef.current;
    const touchStart = touchStartPointRef.current;
    const touchCurrent = touchCurrentPointRef.current;
    const useTouchPoint = dragInputTypeRef.current === "touch" && touchStart && touchCurrent;
    // Mouse wheel-scroll during a drag shifts the page/panel under the
    // position:fixed overlay without moving the pointer — dnd-kit then reports
    // the scroll as a content-space `event.delta` change, so feeding it into the
    // fixed overlay makes the card visually detach from the cursor. Compensate
    // by subtracting the accumulated scroll delta on the mouse path only.
    // (Touch coordinates above are already viewport-relative, so they must NOT
    // have scroll subtracted — that would re-introduce the lag the touchmove
    // listener exists to fix.) Mirrors the hit-test compensation below.
    const scrollDelta = getScrollDelta(dragScrollSnapshotsRef.current);
    const x = Math.round(useTouchPoint ? touchCurrent.x - touchStart.x : event.delta.x - base.x - scrollDelta.x);
    const y = Math.round(useTouchPoint ? touchCurrent.y - touchStart.y : event.delta.y - base.y - scrollDelta.y);
    const nextTransform = `translate3d(${x}px, ${y}px, 0)`;
    overlayTransformRef.current = nextTransform;
    node.style.transform = nextTransform;

    const items = dragPreviewItemsRef.current;
    const sourceIndex = dragSourceIndexRef.current;
    const sourceRect = sourceIndex === null ? null : items[sourceIndex]?.rect;
    if (sourceIndex !== null && sourceRect) {
      const centerY = sourceRect.top - scrollDelta.y + sourceRect.height / 2 + y;
      let targetIndex = sourceIndex;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const item of items) {
        const itemCenterY = item.rect.top - scrollDelta.y + item.rect.height / 2;
        const distance = Math.abs(centerY - itemCenterY);
        if (distance < closestDistance) {
          closestDistance = distance;
          targetIndex = item.index;
        }
      }

      if (dragTargetIndexRef.current !== targetIndex) {
        dragTargetIndexRef.current = targetIndex;
        const slot = dragSlotSizeRef.current;
        for (const item of items) {
          if (item.index === sourceIndex) continue;
          let offset = 0;
          if (sourceIndex < targetIndex && item.index > sourceIndex && item.index <= targetIndex) {
            offset = -slot;
          } else if (sourceIndex > targetIndex && item.index >= targetIndex && item.index < sourceIndex) {
            offset = slot;
          }

          item.node.style.transition = "transform 160ms cubic-bezier(0.2, 0, 0, 1)";
          item.node.style.willChange = offset ? "transform" : "";
          item.node.style.transform = offset ? `translate3d(0, ${Math.round(offset)}px, 0)` : "";
        }

        debugLog("preview target changed", {
          activeId: String(event.active.id),
          targetId: items[targetIndex]?.id ?? null,
          sourceIndex,
          targetIndex,
          centerY: Math.round(centerY * 100) / 100,
          scrollDelta,
        });
      }
    }

    setOverlayHasMoved((hasMoved) => hasMoved || x !== 0 || y !== 0);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const activeId = event.active.id as string;
      const sourceIndex = dragSourceIndexRef.current;
      const targetIndex = dragTargetIndexRef.current;
      const targetPreviewItem = targetIndex === null ? null : dragPreviewItemsRef.current[targetIndex];
      const baseOverlayRect = overlayRectRef.current;

      if (sourceIndex === null || targetIndex === null || sourceIndex === targetIndex) {
        resetDragState();
        return;
      }

      const activeIdx = renderedEntries.findIndex((e) => e.id === activeId);
      const overEntry = renderedEntries[targetIndex];
      if (activeIdx === -1 || !overEntry) {
        resetDragState();
        return;
      }

      const reordered = moveItem(renderedEntries, activeIdx, targetIndex);
      const activeEntry = renderedEntries[activeIdx];
      const targetSection = getSection(overEntry.position);

      // Build updates: assign sequential sortOrder, update position if section changed
      const updates: Array<{ id: string; sortOrder: number; position?: string }> = [];
      const activeNewPosition = targetSection.value;
      const positionChanged = getSection(activeEntry.position).value !== activeNewPosition;
      const optimistic = reordered.map((entry, i) => ({
        ...entry,
        sortOrder: i,
        ...(entry.id === activeId && positionChanged ? { position: activeNewPosition } : {}),
      }));

      for (let i = 0; i < reordered.length; i++) {
        const entry = reordered[i];
        const needsPositionUpdate = entry.id === activeId && positionChanged;
        updates.push({
          id: entry.id,
          sortOrder: i,
          ...(needsPositionUpdate ? { position: activeNewPosition } : {}),
        });
      }

      // Commit phase: first let the manual overlay settle into the target slot,
      // then swap the React order while the active source stays invisible under
      // the overlay. This prevents the final text/card pop when the record is
      // replaced in the list after the API reorder.
      const overlayNode = overlayWrapperRef.current;
      if (overlayNode && baseOverlayRect && targetPreviewItem) {
        const scrollDelta = getScrollDelta(dragScrollSnapshotsRef.current);
        const x = Math.round(targetPreviewItem.rect.left - scrollDelta.x - baseOverlayRect.left);
        const y = Math.round(targetPreviewItem.rect.top - scrollDelta.y - baseOverlayRect.top);
        const settleTransform = `translate3d(${x}px, ${y}px, 0)`;
        overlayTransformRef.current = settleTransform;
        overlayNode.style.transition = "transform 120ms cubic-bezier(0.2, 0, 0, 1)";
        overlayNode.style.transform = settleTransform;
        await wait(120);
      }

      // React still has to replace the old list order with the committed one.
      // Before that render, snapshot every source card rect; after the optimistic
      // render, invert moved siblings back to their old pixels and animate them
      // to zero (FLIP). This masks text/layout pops caused by DOM replacement.
      const beforeRects = new Map<string, DOMRect>();
      for (const node of document.querySelectorAll<HTMLElement>('[data-lore-entry-id][data-lore-dnd="source"]')) {
        const id = node.dataset.loreEntryId;
        if (id) beforeRects.set(id, node.getBoundingClientRect());
      }

      clearPreviewTransforms();
      flushSync(() => {
        setOptimisticEntries(optimistic);
      });

      const flipNodes: HTMLElement[] = [];
      for (const node of document.querySelectorAll<HTMLElement>('[data-lore-entry-id][data-lore-dnd="source"]')) {
        const id = node.dataset.loreEntryId;
        if (!id || id === activeId) continue;
        const before = beforeRects.get(id);
        if (!before) continue;
        const after = node.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        node.style.transition = "none";
        node.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)`;
        node.style.willChange = "transform";
        flipNodes.push(node);
      }

      // Force the inverted positions to stick before animating them back to the
      // real optimistic layout. This keeps text blocks from popping when React
      // replaces the old order with the committed order.
      if (flipNodes.length > 0) {
        void document.body.offsetHeight;
        await nextAnimationFrame();
        for (const node of flipNodes) {
          node.style.transition = "transform 160ms cubic-bezier(0.2, 0, 0, 1)";
          node.style.transform = "";
        }
        await wait(170);
        for (const node of flipNodes) {
          node.style.transition = "";
          node.style.willChange = "";
        }
      } else {
        await nextAnimationFrame();
      }

      // Final handoff: the visible object is still the portal overlay, while the
      // newly-rendered source card is hidden in the committed slot. Align the
      // source to the overlay with a compensation transform, then cross-fade the
      // overlay out and the source in so the text does not visibly jump.
      const landedSourceNode = document.querySelector(
        `[data-lore-entry-id="${window.CSS.escape(activeId)}"][data-lore-dnd="source"]`
      ) as HTMLElement | null;
      const overlayForHandoff = overlayWrapperRef.current;
      if (landedSourceNode && overlayForHandoff) {
        const overlayHandoffRect = overlayForHandoff.getBoundingClientRect();
        const sourceHandoffRect = landedSourceNode.getBoundingClientRect();
        const handoffX = Math.round(overlayHandoffRect.left - sourceHandoffRect.left);
        const handoffY = Math.round(overlayHandoffRect.top - sourceHandoffRect.top);

        landedSourceNode.style.opacity = "0";
        landedSourceNode.style.transition = "none";
        landedSourceNode.style.transform = `translate3d(${handoffX}px, ${handoffY}px, 0)`;
        landedSourceNode.style.willChange = "opacity, transform";
        overlayForHandoff.style.transition = "opacity 120ms ease-out";
        void document.body.offsetHeight;
        await nextAnimationFrame();
        landedSourceNode.style.transition = "opacity 120ms ease-out, transform 120ms cubic-bezier(0.2, 0, 0, 1)";
        landedSourceNode.style.opacity = "1";
        landedSourceNode.style.transform = "translate3d(0, 0, 0)";
        overlayForHandoff.style.opacity = "0";
        await wait(130);
        flushSync(() => {
          resetDragState();
        });
        landedSourceNode.style.opacity = "";
        landedSourceNode.style.transition = "";
        landedSourceNode.style.transform = "";
        landedSourceNode.style.willChange = "";
      } else {
        resetDragState();
      }

      void Promise.resolve(onReorder(updates)).catch((error) => {
        // eslint-disable-next-line no-console
        console.error("Failed to reorder lore entries", error);
        setOptimisticEntries(null);
      });
    },
    [clearPreviewTransforms, onReorder, renderedEntries, resetDragState]
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={resetDragState}
    >
      {POSITION_SECTIONS.map((sec) => {
        const sectionEntries = grouped.get(sec.value) ?? [];
        if (sectionEntries.length === 0) return null;

        return (
          <div key={sec.value} className="mb-2">
            {/* Section divider */}
            <div className="mb-1.5 flex items-center gap-2 px-1">
              <div className="h-px flex-1 bg-border" />
              <span className="shrink-0 font-ui text-[11px] uppercase tracking-wider text-t3/60">
                {isRu ? sec.labelRu : sec.label}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* Entries: custom DOM-transform preview; no sortable React state during drag. */}
            <div className="flex flex-col gap-1.5 [transition:none]">
              {sectionEntries.map((entry) => (
                <DraggableEntryCard
                  key={entry.id}
                  entry={entry}
                  isActive={entry.id === activeEntryId}
                  isMobile={isMobile}
                  t={t}
                  onClick={() => onEntryClick(entry.id)}
                  hideSourceWhileDragging={entry.id === activeDragId && overlayHasMoved}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Empty state */}
      {displayEntries.length === 0 && (
        <div className="py-3 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
          {t("lore_no_entries")}
        </div>
      )}

      {activeEntry && overlayRect && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={overlayWrapperRef}
              className="pointer-events-none fixed z-[9999]"
              style={{
                top: overlayRect.top,
                left: overlayRect.left,
                width: overlayRect.width,
                height: overlayRect.height,
                boxSizing: "border-box",
                transform: overlayTransformRef.current,
                transition: "none",
                willChange: "transform",
              }}
            >
              <EntryCardVisual
                entry={activeEntry}
                isActive={activeEntry.id === activeEntryId}
                isMobile={isMobile}
                t={t}
                rootRef={(node) => {
                  overlayNodeRef.current = node;
                }}
                overlay
              />
            </div>,
            document.body
          )
        : null}
    </DndContext>
  );
}
