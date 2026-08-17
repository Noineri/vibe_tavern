import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../../lib/cn.js";

/** Thumb diameter — must stay in sync with `.dual-range::-*-thumb` in styles.css. */
const THUMB_PX = 16;

type Handle = "from" | "to";

/**
 * Dual-range slider — memory-strategy primitive for the Summary tab.
 *
 * Two overlapping range inputs (`dual-range-l` = lower/from, `dual-range-u` =
 * upper/to). Invariant: dragging `from` up never crosses `to`, dragging `to`
 * down never crosses `from`; both clamp to [min,max]. Pinned by
 * DualRangeSlider.test.tsx.
 *
 * The inputs are inert to the pointer (`.dual-range` sets `pointer-events:none`)
 * and remain for keyboard control and assistive tech; the wrapper hit-tests the
 * pointer, picks the nearer handle, and drives the value itself. Letting each
 * thumb be its own hit target instead — the shape this component used to have —
 * only works in Chromium, because Firefox ignores `pointer-events` on
 * `::-moz-range-thumb`; see the `.dual-range` comment in styles.css.
 */
export function DualRangeSlider({ min, max, from, to, disabled, onChange }: {
  min: number; max: number; from: number; to: number;
  disabled?: boolean;
  onChange: (from: number, to: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef<Handle | null>(null);
  const [hot, setHot] = useState<Handle | null>(null);

  const clampValue = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  const safeFrom = Math.min(clampValue(from), clampValue(to));
  const safeTo = Math.max(clampValue(from), clampValue(to));

  /** Applies the from/to invariant and skips no-op emissions during a drag. */
  function commit(handle: Handle, v: number) {
    const next = clampValue(v);
    const nextFrom = handle === "from" ? Math.min(next, safeTo) : safeFrom;
    const nextTo = handle === "from" ? safeTo : Math.max(safeFrom, next);
    if (nextFrom === safeFrom && nextTo === safeTo) return;
    onChange(nextFrom, nextTo);
  }

  // A native thumb travels between its own half-widths, so the painted fill and
  // the pointer math use that same inset — otherwise grabbing a thumb near an
  // end would snap it by up to half a thumb.
  const ratio = (v: number) => max > min ? (clampValue(v) - min) / (max - min) : 0;
  const offset = (r: number) => `calc(${(r * 100).toFixed(3)}% + ${(THUMB_PX / 2 - r * THUMB_PX).toFixed(3)}px)`;
  const fillSpan = (r: number) => `calc(${(r * 100).toFixed(3)}% - ${(r * THUMB_PX).toFixed(3)}px)`;

  function valueAt(clientX: number) {
    const el = trackRef.current;
    if (!el || max <= min) return min;
    const rect = el.getBoundingClientRect();
    const travel = rect.width - THUMB_PX;
    if (travel <= 0) return min;
    return clampValue(Math.round(min + ((clientX - rect.left - THUMB_PX / 2) / travel) * (max - min)));
  }

  /** Nearer handle wins; when both thumbs are stacked, the one that can still move. */
  function nearestHandle(v: number): Handle {
    const dFrom = Math.abs(v - safeFrom);
    const dTo = Math.abs(v - safeTo);
    if (dFrom < dTo) return "from";
    if (dTo < dFrom) return "to";
    return v > safeFrom ? "to" : "from";
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || e.button !== 0) return;
    const v = valueAt(e.clientX);
    const handle = nearestHandle(v);
    draggingRef.current = handle;
    setHot(handle);
    e.currentTarget.setPointerCapture(e.pointerId);
    (handle === "from" ? fromRef : toRef).current?.focus({ preventScroll: true });
    commit(handle, v);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const v = valueAt(e.clientX);
    const dragging = draggingRef.current;
    if (dragging) commit(dragging, v);
    else setHot(nearestHandle(v));
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const inputCls = "absolute inset-x-0 top-0 h-5 w-full dual-range";

  return (
    <div
      ref={trackRef}
      className={cn("relative h-5 touch-pan-y pb-4", !disabled && "cursor-pointer")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => { if (!draggingRef.current) setHot(null); }}
    >
      {/* Track bg */}
      <div className="absolute left-0 right-0 top-[7px] h-[6px] rounded-full bg-s3" />
      {/* Filled track between the two thumbs */}
      <div
        className="absolute top-[7px] h-[6px] rounded-full bg-accent"
        style={{ left: offset(ratio(safeFrom)), width: fillSpan(Math.max(0, ratio(safeTo) - ratio(safeFrom))) }}
      />
      <input
        ref={fromRef}
        type="range" min={min} max={max} value={safeFrom}
        disabled={disabled}
        onChange={(e) => commit("from", Number(e.target.value))}
        className={cn("dual-range-l z-[2]", inputCls, hot === "from" && "is-hot")}
      />
      <input
        ref={toRef}
        type="range" min={min} max={max} value={safeTo}
        disabled={disabled}
        onChange={(e) => commit("to", Number(e.target.value))}
        className={cn("dual-range-u z-[3]", inputCls, hot === "to" && "is-hot")}
      />
    </div>
  );
}
