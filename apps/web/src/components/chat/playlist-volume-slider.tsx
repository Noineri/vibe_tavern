import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { lblCls } from "../build/fields/field-styles.js";

/** FS-5: playlist-local volume slider — the playlist twin of the shared
 *  SliderField (which settings keep using untouched). Same contract shape
 *  (label + range + number), styled by the .playlist-slider family in
 *  styles.css instead of the bare native control.
 *
 *  Value contract: INTERNAL value stays 0..1 (the persisted
 *  vt.tts.narration-volume format is unchanged); the number box displays
 *  PERCENTS 0–100 (owner: «лучше проценты»).
 *
 *  Footer width arithmetic (budgeted on paper — popover is 26rem = 416px):
 *  the label sits on its OWN line (wraps freely, so even the longest RU
 *  string «Громкость озвучки» can never clip); the control row is
 *  track (flex-1, min-w-0 — the only shrinker) + gap-2 (8px) + percent box
 *  (~64px: 3 digits + % suffix, tabular-nums, shrink-0). Worst case leaves
 *  416 − 24 (px-3) − 64 − 8 = 320px for the track. No overflow at 26rem. */
export function PlaylistVolumeSlider(input: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly rangeTestId?: string;
  readonly numberTestId?: string;
}): ReactNode {
  const { label, value, onChange, disabled = false, rangeTestId, numberTestId } = input;
  const [draft, setDraft] = useState<string>(String(Math.round(value * 100)));
  useEffect(() => {
    setDraft(String(Math.round(value * 100)));
  }, [value]);

  function commit(raw: string): void {
    const digits = raw.replace(/[^0-9]/g, "");
    if (digits.length === 0) {
      setDraft(String(Math.round(value * 100)));
      return;
    }
    const percent = Math.min(100, Math.max(0, parseInt(digits, 10)));
    setDraft(String(percent));
    onChange(percent / 100);
  }

  function handleRangeChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const next = parseFloat(e.target.value);
    if (!Number.isNaN(next)) onChange(next);
  }

  return (
    <div>
      <label className={lblCls}>{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={handleRangeChange}
          disabled={disabled}
          aria-label={label}
          data-testid={rangeTestId}
          style={{ "--p": `${Math.round(value * 100)}%` } as CSSProperties}
          className="playlist-slider min-w-0 flex-1 border-0 p-0"
        />
        <span className="flex shrink-0 items-center gap-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 tabular-nums">
          <input
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
            }}
            disabled={disabled}
            aria-label={label}
            data-testid={numberTestId}
            className="h-[30px] w-[52px] rounded-md border border-border2 bg-s1 px-1 text-center text-t1 outline-none focus-visible:border-accent disabled:opacity-40"
          />
          <span aria-hidden="true">%</span>
        </span>
      </div>
    </div>
  );
}
