import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { buildRailEntries, buildRailSegments, railIndexAtY, railWindow, type RailEntry } from "./scroll-rail-model.js";

interface ScrollRailProps {
  entries: readonly RailEntry[];
  scroller: HTMLElement | null;
  onJump: (displayIndex: number) => void;
  isMobile: boolean;
}

/** Store subscriptions stay below MessageScroller, isolated from the transcript renderer. */
export function ChatScrollRail({ displayIds, ...props }: Omit<ScrollRailProps, "entries"> & { displayIds: string[] }) {
  const messages = useSnapshotStore((state) => state.messagesById);
  const assistant = useSnapshotStore((state) => state.character?.name ?? "");
  const user = useSnapshotStore((state) => state.persona?.name ?? "");
  const entries = useMemo(() => buildRailEntries(displayIds, messages, { assistant, user }), [displayIds, messages, assistant, user]);
  return <ScrollRail entries={entries} {...props} />;
}

/** v3 story map: one quiet thread, bounded ticks on hover, one persistent preview. */
export function ScrollRail({ entries, scroller, onJump, isMobile }: ScrollRailProps) {
  const { t } = useT();
  const railRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const lastJumpRef = useRef(-1);
  const [active, setActive] = useState(-1);
  const [cursorY, setCursorY] = useState(0);
  const [geometry, setGeometry] = useState({ height: 0, width: 0, start: 0, end: 1 });
  const [previewHeight, setPreviewHeight] = useState(0);
  const segments = useMemo(() => buildRailSegments(entries, geometry.height), [entries, geometry.height]);
  const entry = entries[active];

  useLayoutEffect(() => {
    if (!scroller) return;
    const update = () => {
      const next = {
        height: railRef.current?.getBoundingClientRect().height || Math.max(0, scroller.clientHeight - 16),
        width: scroller.clientWidth,
        ...railWindow(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight),
      };
      setGeometry((old) => old.height === next.height && old.width === next.width && old.start === next.start && old.end === next.end ? old : next);
    };
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; update(); });
    };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    resize.observe(scroller);
    mutations.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] });
    scroller.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      scroller.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scroller]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const update = () => setPreviewHeight(preview.getBoundingClientRect().height);
    const resize = new ResizeObserver(update);
    resize.observe(preview);
    update();
    return () => resize.disconnect();
  }, [!!entry]);

  useEffect(() => {
    pointerRef.current = null;
    lastJumpRef.current = -1;
    setActive(-1);
  }, [scroller, entries.length, isMobile]);

  function pointAt(y: number, jump: boolean): void {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect) return;
    const index = railIndexAtY(y, rect.top, rect.height, entries.length);
    if (index < 0) return;
    setActive(index);
    setCursorY(y - rect.top);
    setGeometry((old) => ({ ...old, height: rect.height }));
    if (jump && lastJumpRef.current !== index) {
      lastJumpRef.current = index;
      onJump(entries[index].displayIndex);
    }
  }

  function finishPointer(event: PointerEvent<HTMLDivElement>): void {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    lastJumpRef.current = -1;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type !== "pointerup" || isMobile || !event.currentTarget.matches(":hover")) setActive(-1);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const current = active >= 0 ? active : Math.min(entries.length - 1, Math.floor(geometry.start * entries.length));
    const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
      : ["ArrowDown", "PageDown"].includes(event.key) ? Math.min(entries.length - 1, current + (event.key === "PageDown" ? 10 : 1))
      : ["ArrowUp", "PageUp"].includes(event.key) ? Math.max(0, current - (event.key === "PageUp" ? 10 : 1))
      : ["Enter", " "].includes(event.key) ? current : -1;
    if (event.key === "Escape") setActive(-1);
    if (next < 0) return;
    event.preventDefault();
    setActive(next);
    setCursorY((next + 0.5) / entries.length * geometry.height);
    onJump(entries[next].displayIndex);
  }

  // The mobile interaction is added in CNR-5; never substitute the desktop hitzone.
  if (isMobile || entries.length === 0) return null;
  const open = !!entry;
  const valueIndex = active >= 0 ? active : Math.min(entries.length - 1, Math.floor(geometry.start * entries.length));
  const value = entries[valueIndex];
  const cardTop = Math.max(0, Math.min(geometry.height - previewHeight, cursorY - previewHeight / 2));
  const windowSize = geometry.end - geometry.start;
  const thumbHeight = Math.min(geometry.height, Math.max(24, windowSize * geometry.height));
  const thumbTop = windowSize < 1 ? geometry.start / (1 - windowSize) * (geometry.height - thumbHeight) : 0;
  return (
    <div
      ref={railRef}
      role="scrollbar"
      tabIndex={0}
      aria-label={t("chat_rail_label")}
      aria-controls={scroller?.id || undefined}
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={entries.length}
      aria-valuenow={valueIndex + 1}
      aria-valuetext={`#${value.number} ${value.author || t(value.role === "user" ? "chat_rail_user" : "chat_rail_assistant")}`}
      className="absolute inset-y-2 right-0 z-20 w-9 cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onPointerEnter={(event) => { if (event.pointerType !== "touch") pointAt(event.clientY, false); }}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") pointAt(event.clientY, pointerRef.current === event.pointerId);
      }}
      onPointerLeave={() => { if (pointerRef.current === null) setActive(-1); }}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.pointerType === "touch") return;
        event.preventDefault();
        pointerRef.current = event.pointerId;
        lastJumpRef.current = -1;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointAt(event.clientY, true);
      }}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={() => { if (pointerRef.current !== null) { pointerRef.current = null; lastJumpRef.current = -1; setActive(-1); } }}
      onKeyDown={keyDown}
      onFocus={() => { setActive(valueIndex); setCursorY(geometry.start * geometry.height); }}
      onBlur={() => { if (pointerRef.current === null) setActive(-1); }}
    >
      <div aria-hidden className={cn("pointer-events-none absolute inset-0 transition-opacity motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")}
        style={{ background: "linear-gradient(to right, transparent, color-mix(in srgb, var(--surface) 65%, transparent))" }} />
      <div aria-hidden className={cn("pointer-events-none absolute inset-y-0 right-[5px] w-0.5 rounded-sm bg-t3/15 transition-opacity", open && "opacity-0")}>
        <div className="absolute -left-px w-[3px] rounded-full bg-accent/65" style={{ top: thumbTop, height: thumbHeight }} />
      </div>
      <div aria-hidden className={cn("pointer-events-none absolute inset-0 flex flex-col justify-around pr-1.5 transition-opacity motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")}>
        {segments.map((segment) => {
          const distance = active < segment.startIndex ? segment.startIndex - active : active > segment.endIndex ? active - segment.endIndex : 0;
          const inWindow = segment.endIndex / entries.length >= geometry.start && segment.startIndex / entries.length <= geometry.end;
          const width = distance <= 3 ? [23, 18, 14, 10][distance] : inWindow ? 11 : segment.role === "user" ? 9 : 6;
          return <div key={segment.startIndex} className="flex min-h-0 flex-1 items-center justify-end">
            <span className="relative rounded-sm transition-all duration-150 motion-reduce:transition-none" style={{
              width, height: distance <= 1 ? 2 : 1.5,
              background: distance <= 1 || inWindow ? "var(--accent)" : segment.role === "user" ? "var(--md-quoted)" : "var(--t3)",
              opacity: distance <= 3 ? [1, 0.9, 0.75, 0.55][distance] : inWindow ? 0.85 : segment.role === "user" ? 0.55 : 0.35,
            }}>
              {distance === 0 && <span className="absolute -left-0.5 top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />}
            </span>
          </div>;
        })}
      </div>
      {entry && <div ref={previewRef} role="tooltip" className="pointer-events-none absolute right-[38px] w-max whitespace-normal rounded-md bg-t1 px-2.5 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-snug text-bg shadow-md"
        style={{ top: cardTop, maxWidth: Math.min(360, Math.max(0, geometry.width - 56)), maxHeight: geometry.height, overflowY: "hidden" }}>
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-bg/15 pb-1.5">
          <span className="font-body italic text-accent">#{entry.number}</span>
          <span className="min-w-0 break-words font-semibold">{entry.author || t(entry.role === "user" ? "chat_rail_user" : "chat_rail_assistant")}</span>
          <span className="text-[calc(var(--ui-fs)-3px)] opacity-65">{t(entry.role === "user" ? "chat_rail_user" : "chat_rail_assistant")}</span>
        </div>
        <p className="line-clamp-3 break-words font-body opacity-85">{entry.snippet}</p>
      </div>}
    </div>
  );
}
