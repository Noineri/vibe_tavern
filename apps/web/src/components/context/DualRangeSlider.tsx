import { cn } from "../../lib/cn.js";

/**
 * Dual-range slider — memory-strategy primitive for the Summary tab.
 *
 * Two overlapping range inputs (`dual-range-l` = lower/from, `dual-range-u` =
 * upper/to). Invariant: dragging `from` up never crosses `to`, dragging `to`
 * down never crosses `from`; both clamp to [min,max]. Pinned by
 * DualRangeSlider.test.tsx.
 */
export function DualRangeSlider({ min, max, from, to, disabled, onChange }: {
  min: number; max: number; from: number; to: number;
  disabled?: boolean;
  onChange: (from: number, to: number) => void;
}) {
  const clampValue = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  const safeFrom = Math.min(clampValue(from), clampValue(to));
  const safeTo = Math.max(clampValue(from), clampValue(to));

  function handleFrom(v: number) {
    const next = clampValue(v);
    onChange(Math.min(next, safeTo), safeTo);
  }
  function handleTo(v: number) {
    const next = clampValue(v);
    onChange(safeFrom, Math.max(safeFrom, next));
  }
  const trackPct = (v: number) => max > min ? Math.min(100, Math.max(0, ((clampValue(v) - min) / (max - min)) * 100)) : 0;

  const thumbCls =
    "absolute inset-x-0 top-0 h-5 w-full appearance-none bg-transparent " +
    "[&::-webkit-slider-thumb]:h-[16px] [&::-webkit-slider-thumb]:w-[16px] " +
    "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
    "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent " +
    "[&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-sm " +
    "[&::-webkit-slider-thumb]:transition-shadow [&::-webkit-slider-thumb]:hover:shadow-[0_0_0_3px_var(--accent-dim)] " +
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:cursor-pointer";

  return (
    <div className="relative h-5 pb-4">
      {/* Track bg */}
      <div className="absolute left-0 right-0 top-[7px] h-[6px] rounded-full bg-s3" />
      {/* Filled track between the two thumbs */}
      <div
        className="absolute top-[7px] h-[6px] rounded-full bg-accent"
        style={{ left: `${trackPct(safeFrom)}%`, width: `${Math.max(0, trackPct(safeTo) - trackPct(safeFrom))}%` }}
      />
      {/* Both inputs: pointer-events:none on container, auto on thumb via Tailwind */}
      <input
        type="range" min={min} max={max} value={safeFrom}
        disabled={disabled}
        onChange={(e) => handleFrom(Number(e.target.value))}
        className={cn("dual-range-l z-[2] pointer-events-none", thumbCls)}
      />
      <input
        type="range" min={min} max={max} value={safeTo}
        disabled={disabled}
        onChange={(e) => handleTo(Number(e.target.value))}
        className={cn("dual-range-u z-[3] pointer-events-none", thumbCls)}
      />
    </div>
  );
}
