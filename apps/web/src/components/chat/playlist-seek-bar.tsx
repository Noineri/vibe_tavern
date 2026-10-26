import type { ReactNode } from "react";
import type { NarrationProgress } from "../../lib/tts/tts-orchestrator.js";
import { useT } from "../../i18n/context.js";
import { Slider } from "../shared/slider.js";

/** TPE-18b: m:ss clock for the seek bar (RU-safe: digits only). */
export function formatPlaybackTime(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

/** TPE-18b: cumulative playback position control for the live row. */
export function SeekBar(input: {
  readonly progress: NarrationProgress | null;
  readonly onSeek: (positionSec: number) => void;
}): ReactNode {
  const { t } = useT();
  const progress = input.progress;
  const knownSum = progress ? progress.durations.reduce<number>((sum, d) => sum + (d ?? 0), 0) : 0;
  const rangeMax: number = progress !== null && progress.totalSec !== null ? progress.totalSec : knownSum;
  const position = progress ? Math.min(progress.positionSec, rangeMax) : 0;
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5">
      <Slider
        min={0}
        max={rangeMax}
        step={0.1}
        value={position}
        formatValue={formatPlaybackTime}
        disabled={!progress || rangeMax <= 0}
        aria-label={t("narration_playlist_seek")}
        inputTestId="playlist-seek"
        size="xs"
        onValueChange={input.onSeek}
        className="min-w-0 flex-1"
      />
      <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-4px)] text-t3 tabular-nums">
        {progress
          ? progress.totalSec !== null
            ? `${formatPlaybackTime(position)} / ${formatPlaybackTime(progress.totalSec)}`
            : formatPlaybackTime(position)
          : `0:00`}
      </span>
    </span>
  );
}
