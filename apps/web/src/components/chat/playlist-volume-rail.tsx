import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useT } from "../../i18n/context.js";
import { Ic } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";

/** RD-4: vertical volume rail — the owner's paint-concept right edge.
 *  Replaces the FS-5 horizontal footer block (label + range + percent
 *  number box) outright: «кнопка отключения звука + вертикальный
 *  слайдер громкости, без ввода цифр вообще».
 *
 *  Value contract: INTERNAL value stays 0..1 (the persisted
 *  vt.tts.narration-volume format is unchanged — same onChange path as
 *  the old slider, so the store clamps/persists/forwards to the lane).
 *  The percent value appears ABOVE the thumb WHILE DRAGGING (owner:
 *  «отображать проценты над слайдером в момент движения») and never
 *  otherwise — no input field, no persistent or read-only number.
 *  Keyboard focus counts as interacting too (same flag): arrow-key
 *  adjusters need the feedback a dragger gets.
 *
 *  Mute: no new store state — the rail stashes the last nonzero volume
 *  in a ref; mute writes 0 through the normal path, unmute restores the
 *  stash (fresh mount at 0 restores full volume). Dragging away from 0
 *  clears the muted look because the value IS the mute state.
 *
 *  RD-8: variant-2 styling (owner) — w-10, softened left divider, a
 *  subtle recessed backdrop. The mock's bg-black/20 is mapped, not
 *  copied: the s2/s3 tokens flip direction between themes (light-lava
 *  s2 is darker than surface, coffee s2 is lighter), so neither reads
 *  as a recess everywhere — a faint black overlay darkens in BOTH.
 *  Rail width arithmetic (budgeted on paper — popover is 26rem = 416px):
 *  the rail is a fixed w-10 (40px) column; the percent label peaks at
 *  "100%" (~24px in 10px tabular-nums) so it can never clip the panel
 *  edge. The left content column is min-w-0 flex-1, the only shrinker.
 *
 *  Keyboard: Up/Right +step, Down/Left −step with preventDefault (an
 *  explicit handler — native vertical arrow mapping varies, and the
 *  preventDefault keeps the browser from double-applying). */
export function PlaylistVolumeRail(input: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly rangeTestId?: string;
  readonly muteTestId?: string;
  readonly percentTestId?: string;
}): ReactNode {
  const { t } = useT();
  const { value, onChange, disabled = false, rangeTestId, muteTestId, percentTestId } = input;
  const [interacting, setInteracting] = useState(false);
  const stashRef = useRef(value > 0 ? value : 1);
  useEffect(() => {
    if (value > 0) stashRef.current = value;
  }, [value]);
  const muted = value <= 0;
  const percent = Math.round(value * 100);

  function stepVolume(delta: number): void {
    const next = Math.min(1, Math.max(0, Math.round((value + delta) * 100) / 100));
    onChange(next);
  }

  return (
    <div data-testid="playlist-volume-rail" className="flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border2/50 bg-black/15 px-1 py-2">
      {/* RD-4: reserved percent slot ABOVE the slider — blank space when
        idle (not a zero, not a number), "N%" only while interacting. */}
      <span
        data-testid={percentTestId}
        aria-hidden={!interacting}
        className="flex h-4 items-center font-ui text-[calc(var(--ui-fs)-5px)] text-t2 tabular-nums"
      >
        {interacting ? `${percent}%` : ""}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (!Number.isNaN(next)) onChange(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            e.preventDefault();
            stepVolume(0.05);
          } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            e.preventDefault();
            stepVolume(-0.05);
          }
        }}
        onPointerDown={() => setInteracting(true)}
        onPointerUp={() => setInteracting(false)}
        onPointerCancel={() => setInteracting(false)}
        onMouseDown={() => setInteracting(true)}
        onMouseUp={() => setInteracting(false)}
        onFocus={() => setInteracting(true)}
        onBlur={() => setInteracting(false)}
        disabled={disabled}
        aria-label={t("narration_playlist_volume")}
        data-testid={rangeTestId}
        style={{ writingMode: "vertical-lr", direction: "rtl", "--p": `${percent}%` } as CSSProperties}
        className="playlist-slider playlist-slider--vertical min-h-0 w-7 flex-1 border-0 p-0"
      />
      <CustomTooltip content={muted ? t("narration_playlist_unmute") : t("narration_playlist_mute")}>
        <button
          type="button"
          aria-label={muted ? t("narration_playlist_unmute") : t("narration_playlist_mute")}
          data-testid={muteTestId}
          disabled={disabled}
          onClick={() => {
            onChange(muted ? stashRef.current : 0);
          }}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-default disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          {muted ? <Ic.mute /> : <Ic.speaker />}
        </button>
      </CustomTooltip>
    </div>
  );
}
