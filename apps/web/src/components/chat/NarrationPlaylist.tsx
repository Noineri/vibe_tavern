import type { ReactNode } from "react";
import type { AppMessage } from "../../api/types.js";
import { useT } from "../../i18n/context.js";
import { firstTwoLines } from "../../lib/tts/narration-source.js";
import type { NarrationPlaylistEntry } from "../../lib/tts/narration-cache.js";
import type { NarrationProgress, NarrationState } from "../../lib/tts/tts-orchestrator.js";
import { cn } from "../../lib/cn.js";
import { Ic } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { EmptyState } from "../shared/empty-state.js";
import { PlaylistVolumeRail } from "./playlist-volume-rail.js";
import { Toggle } from "../shared/Toggle.js";

/** TPE-18a: the playlist body (DiceTray twin) — rows for everything
 *  narrated (or being narrated) in the current chat, plus the footer
 *  controls (global stop + pause + playback rate + volume, TPE-18b;
 *  continuous-play toggle, TPE-18d). NO library file writes here —
 *  the save/reveal/drop buttons call back into TPE-18c store actions. */

/** TPE-18b: m:ss clock for the seek bar (RU-safe: digits only). */
export function formatPlaybackTime(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

export interface PlaylistRowModel {
  messageId: string;
  /** What's shown: the live narration text while synthesizing/playing,
   *  else the indexed two-line snippet (owner decision). */
  snippet: string;
  variantIndex: number;
  variantCount: number;
  live: NarrationState | null;
  /** TPE-18c: a saved library file exists for this exact variant. */
  inLibrary: boolean;
  /** FS-3: aborted before completing — a cached prefix with an explicit
   *  continue-generation button (no library save: the file is whole-track
   *  only). */
  partial: boolean;
}

function isLiveState(state: NarrationState | undefined): state is NarrationState {
  return state !== undefined && (state.status === "generating" || state.status === "playing" || state.status === "paused");
}

/** Derive panel rows from chat order: every character (assistant-role)
 *  message that is indexed or live, live ones first. Greetings are
 *  assistant-role messages, so they are included. */
export function buildPlaylistRows(
  messages: AppMessage[],
  entries: NarrationPlaylistEntry[],
  narrations: Record<string, NarrationState>,
  liveTextById: (messageId: string) => string | null,
): PlaylistRowModel[] {
  const entryById = new Map(entries.map((entry) => [entry.messageId, entry]));
  const live: PlaylistRowModel[] = [];
  const settled: PlaylistRowModel[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const variants = message.variants;
    if (variants.length === 0) continue;
    const state = narrations[message.id];
    const liveState = isLiveState(state) ? state : null;
    const entry = entryById.get(message.id);
    if (!liveState && !entry) continue;
    const selectedIndex =
      (message.selectedVariantIndex !== null && message.selectedVariantIndex !== undefined
        ? message.selectedVariantIndex
        : undefined) ??
      variants.findIndex((variant) => variant.isSelected);
    // Live text is the full narration input — cut the two-line snippet
    // here (owner decision); indexed rows already store the snippet.
    const liveSnippet = liveState ? firstTwoLines(liveTextById(message.id) ?? entry?.snippet ?? "") : null;
    const row: PlaylistRowModel = {
      messageId: message.id,
      snippet: liveSnippet ?? entry?.snippet ?? "",
      variantIndex: entry?.variantIndex ?? (selectedIndex >= 0 ? selectedIndex : 0),
      variantCount: variants.length,
      live: liveState,
      inLibrary: entry?.inLibrary === true,
      partial: entry?.partial === true,
    };
    if (liveState) live.push(row);
    else settled.push(row);
  }
  return [...live, ...settled];
}

/** Scroll the message into view and flash-highlight it. Best-effort DOM
 *  work: a missing element (virtualized away) is a silent no-op, never an
 *  error — the row stays usable. Returns whether the target was found. */
export function showMessageInChat(messageId: string): boolean {
  // CSS.escape is universal in browsers; the fallback keeps non-DOM
  // runtimes (happy-dom) working — messageIds are our own generated
  // slugs, so an unescaped attribute selector is safe there.
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(messageId) : messageId;
  const element = document.querySelector(`[data-message-id="${escaped}"]`);
  if (!(element instanceof HTMLElement)) return false;
  try {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch {
    // Smooth scrolling is best-effort (older engines, test DOMs) — the
    // flash below still orients the user when already in view.
    try {
      element.scrollIntoView();
    } catch {
      // A missing scroll implementation must not break the action.
    }
  }
  if (typeof element.animate === "function") {
    try {
      element.animate(
        [{ boxShadow: "0 0 0 2px var(--accent)" }, { boxShadow: "0 0 0 0 transparent" }],
        { duration: 1200 },
      );
    } catch {
      // The Web Animations API is best-effort here — scroll already landed.
    }
  }
  return true;
}

/** TPE-18b: cumulative playback position control for the live row. */
function SeekBar(input: {
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
      <input
        type="range"
        min={0}
        max={rangeMax}
        step={0.1}
        value={position}
        disabled={!progress || rangeMax <= 0}
        aria-label={t("narration_playlist_seek")}
        data-testid="playlist-seek"
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) input.onSeek(v);
        }}
        style={{ "--p": rangeMax > 0 ? `${((position / rangeMax) * 100).toFixed(1)}%` : "0%" } as React.CSSProperties}
        className="playlist-slider playlist-slider--seek min-w-0 flex-1 border-0"
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

const PLAYBACK_RATES = [1, 1.25, 1.5, 0.75];

export function nextPlaybackRate(current: number): number {
  const position = PLAYBACK_RATES.indexOf(current);
  return PLAYBACK_RATES[(position + 1) % PLAYBACK_RATES.length] ?? 1;
}

export interface NarrationPlaylistProps {
  readonly messages: AppMessage[];
  readonly entries: NarrationPlaylistEntry[];
  readonly narrations: Record<string, NarrationState>;
  readonly liveTextById: (messageId: string) => string | null;
  readonly rate: number;
  readonly anyLive: boolean;
  /** TPE-18b: the live lane is parked (pause toggle shows Resume). */
  readonly livePaused: boolean;
  /** TPE-18b: live progress per message (seek-bar source). */
  readonly progress: Record<string, NarrationProgress>;
  readonly volume: number;
  /** TPE-18d: continuous-play pref (footer toggle, default OFF). */
  readonly continuous: boolean;
  readonly onContinuous: (value: boolean) => void;
  readonly onPlay: (messageId: string) => void;
  readonly onStop: () => void;
  readonly onCycleRate: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onSeek: (messageId: string, positionSec: number) => void;
  readonly onVolume: (volume: number) => void;
  /** TPE-18c: library actions (settled rows only — live rows hide them). */
  readonly onSave: (messageId: string) => void;
  readonly onReveal: (messageId: string) => void;
  readonly onDrop: (messageId: string) => void;
  /** FS-3: drop a cache-only row (partial) — evicts its cached segments
   *  and removes the index entry. */
  readonly onDropCache: (messageId: string) => void;
  /** FS-6: re-voice a cache-only settled row — drop its cached segments,
   *  then re-narrate fresh. Library rows are excluded: the saved file is
   *  preserved by scope and would otherwise replay library-first. */
  readonly onRevoice: (messageId: string) => void;
  /** TPE-18c: rows with a save in flight (button disabled, no double-save). */
  readonly savingIds: ReadonlySet<string>;
  /** TPE-18c: false where no OS file manager exists (Android) — the
   *  reveal button hides instead of failing into a 501. */
  readonly canReveal: boolean;
  readonly showTitle: boolean;
}

export function NarrationPlaylist(input: NarrationPlaylistProps): ReactNode {
  const { t } = useT();
  const rows = buildPlaylistRows(input.messages, input.entries, input.narrations, input.liveTextById);

  return (
    <div className="flex max-h-[min(28rem,calc(100dvh-12rem))]">
      {/* RD-4: left content column (title + rows + transport footer) —
        min-w-0 flex-1, the only shrinker; the volume rail owns the
        fixed w-11 right edge. */}
      <div className="flex min-w-0 flex-1 flex-col">
      {input.showTitle && (
        <div className="flex items-center gap-2 border-b border-border2 px-3 py-2">
          <Ic.speaker />
          <span className="font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-t1">
            {t("narration_playlist_title")}
          </span>
          <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
            {t("narration_playlist_count", { count: rows.length })}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState icon={<Ic.speaker />} title={t("narration_playlist_empty")} />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
          {rows.map((row) => (
            <PlaylistRow
              key={row.messageId}
              row={row}
              progress={input.progress[row.messageId] ?? null}
              saving={input.savingIds.has(row.messageId)}
              canReveal={input.canReveal}
              onPlay={() => input.onPlay(row.messageId)}
              onPause={input.onPause}
              onResume={input.onResume}
              onStop={input.onStop}
              onSeek={(positionSec) => input.onSeek(row.messageId, positionSec)}
              onSave={() => input.onSave(row.messageId)}
              onReveal={() => input.onReveal(row.messageId)}
              onDrop={() => input.onDrop(row.messageId)}
              onDropCache={() => input.onDropCache(row.messageId)}
              onRevoice={() => input.onRevoice(row.messageId)}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5 border-t border-border2 px-3 py-2">
        <CustomTooltip content={t("narrate_stop")}>
          <button
            type="button"
            aria-label={t("narrate_stop")}
            data-testid="playlist-stop"
            disabled={!input.anyLive}
            onClick={input.onStop}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-default disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.stopSquare />
          </button>
        </CustomTooltip>
        {/* TPE-18b: pause/resume toggle for the live lane. Same 28px
          footprint as stop — footer arithmetic: 28+28+~44+gaps fits the
          392px inner width with room for RU labels. */}
        <CustomTooltip content={input.livePaused ? t("narration_playlist_resume") : t("narration_playlist_pause")}>
          <button
            type="button"
            aria-label={input.livePaused ? t("narration_playlist_resume") : t("narration_playlist_pause")}
            data-testid="playlist-pause"
            disabled={!input.anyLive}
            onClick={input.livePaused ? input.onResume : input.onPause}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-default disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            {input.livePaused ? <Ic.play /> : <Ic.pause />}
          </button>
        </CustomTooltip>
        <CustomTooltip content={t("narration_playlist_rate")}>
          <button
            type="button"
            aria-label={t("narration_playlist_rate")}
            data-testid="playlist-rate"
            onClick={input.onCycleRate}
            className="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md px-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold text-t3 tabular-nums transition-colors hover:bg-s3 hover:text-t1"
          >
            {`×${input.rate}`}
          </button>
        </CustomTooltip>
        {/* TPE-18d: continuous-play toggle — label + switch. Footer
          arithmetic: stop 28 + pause 28 + rate ~44 + gaps 18 ≈ 118px;
          toggle ~34 + RU label ~90 + gaps ≈ 140px; total ≈ 260px <
          392px inner width. The full phrase lives in the tooltip so
          the short label never truncates meaning. */}
        <CustomTooltip content={t("narration_playlist_continuous_hint")}>
          <label className="ml-auto flex min-w-0 cursor-pointer items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
            <Toggle
              checked={input.continuous}
              onChange={input.onContinuous}
              aria-label={t("narration_playlist_continuous")}
            />
            <span className="truncate">{t("narration_playlist_continuous")}</span>
          </label>
        </CustomTooltip>
      </div>
      {/* FS-5's horizontal volume block (label + range + percent box) is
        GONE — RD-4 replaces it with the right-edge vertical rail below
        (owner: «без ввода цифр вообще»). The footer keeps only the
        transport row (stop/pause/rate/continuous); the bar reshuffle is
        RD-5's unit. */}
      </div>
      <PlaylistVolumeRail
        value={input.volume}
        onChange={input.onVolume}
        rangeTestId="playlist-volume"
        muteTestId="playlist-volume-mute"
        percentTestId="playlist-volume-percent"
      />
    </div>
  );
}

function PlaylistRow(input: {
  readonly row: PlaylistRowModel;
  /** TPE-18b: live progress for the seek bar (null for settled rows). */
  readonly progress: NarrationProgress | null;
  /** TPE-18c: a save is in flight for this row. */
  readonly saving: boolean;
  readonly canReveal: boolean;
  readonly onPlay: () => void;
  /** RD-2: lane-global pause/resume (same path as the footer toggle) —
   *  the row only OFFERS pause while its own narration is playing and
   *  resume while its own lane is parked. */
  readonly onPause: () => void;
  readonly onResume: () => void;
  /** RD-3: second SURFACE for the same single stopNarration path — the
   *  row stops only its own live narration (see rowStop below). */
  readonly onStop: () => void;
  readonly onSeek: (positionSec: number) => void;
  readonly onSave: () => void;
  readonly onReveal: () => void;
  readonly onDrop: () => void;
  readonly onDropCache: () => void;
  readonly onRevoice: () => void;
}): ReactNode {
  const { t } = useT();
  const { row } = input;
  const live = row.live !== null;
  // RD-2: this row owns the lane's transport icon — pause only while
  // its own narration is playing, resume offer while it is parked.
  const rowPlaying = row.live?.status === "playing";
  const rowPaused = row.live?.status === "paused";
  // The snippet is LLM/character-authored text in a density list —
  // line-clamp-2 truncation is the allowed context (rule: unbounded
  // user data may ellipsize in list rows). Our own UI strings below
  // (swipe label, progress) are never truncated.
  const snippet = row.snippet;
  const progress = row.live && row.live.total > 0
    ? Math.min(100, Math.round((row.live.received / row.live.total) * 100))
    : null;
  // RD-1: the row is a four-zone card — head (A), chunk status (B),
  // controls (C), playback (D, live rows only). Zones B/C/D are split
  // by thin rules (border-border2, the file's existing divider token).
  // Width budget: the popover is w-[26rem] (416px, capped by
  // max-w-[calc(100vw-2rem)]), the list pads px-2 and the card px-2, so
  // a zone is ~384px at most. Head: snippet flexes, magnifier is a fixed
  // 28px dock. The control panel holds at most four 28px icon buttons
  // plus gaps (~130px). No fixed widths for authored strings anywhere
  // (RU runs 20–30% longer): labels/badges size to content, and only
  // the snippet (unbounded user data in a density list) clamps.
  return (
    <li
      data-testid="narration-playlist-row"
      data-playlist-message-id={row.messageId}
      className={cn(
        "rounded-md px-2 py-1.5",
        live ? "bg-accent-dim" : "hover:bg-s2",
      )}
    >
      {/* RD-1 zone A — head: the two-line snippet (owner decision) plus
        the show-in-chat magnifier docked at the right edge. */}
      <div data-testid="playlist-row-zone-head" className="flex min-w-0 items-start gap-1.5">
        <p className="line-clamp-2 min-w-0 flex-1 break-words font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-t1">
          {snippet}
        </p>
        <CustomTooltip content={t("narration_playlist_show_in_chat")}>
          <button
            type="button"
            aria-label={t("narration_playlist_show_in_chat")}
            data-testid="playlist-row-show"
            onClick={() => showMessageInChat(row.messageId)}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.search />
          </button>
        </CustomTooltip>
      </div>
      {/* RD-1 zone B — chunk status: swipe badge, cache/library badge,
        and the live fetch progress (n/total + bar). */}
      <div data-testid="playlist-row-zone-chunk" className="mt-1 border-t border-border2 pt-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-4px)] text-t3 tabular-nums">
            {t("narration_playlist_swipe", { current: row.variantIndex + 1, total: row.variantCount })}
          </span>
          {/* TPE-18c: in-library badge — a tiny chip in the meta line
            (no extra row width: ~70px next to the swipe label, both fit
            the ~260px settled content width even in RU). */}
          {row.inLibrary && (
            <span
              data-testid="playlist-row-library-badge"
              className="shrink-0 rounded border border-accent/40 bg-accent-dim px-1 font-ui text-[calc(var(--ui-fs)-4px)] font-medium text-accent-t"
            >
              {t("narration_playlist_in_library")}
            </span>
          )}
          {/* FS-7: in-cache badge — the twin of the library badge
            (same markup/density/position). Mutually exclusive:
            library rows show ONLY the library badge. Settled
            cache-backed rows (full and FS-3 partial) carry it; live
            rows show no state badge. No fixed widths (RU «В кэше»). */}
          {!live && !row.inLibrary && (
            <span
              data-testid="playlist-row-cache-badge"
              className="shrink-0 rounded border border-accent/40 bg-accent-dim px-1 font-ui text-[calc(var(--ui-fs)-4px)] font-medium text-accent-t"
            >
              {t("narration_playlist_in_cache")}
            </span>
          )}
          {row.live && row.live.total > 0 && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5" title={t("narration_playlist_fetching", { received: row.live.received, total: row.live.total })}>
              <span className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-s3">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${progress ?? 0}%` }} />
              </span>
              <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-4px)] text-t3 tabular-nums">
                {t("narration_playlist_fetching", { received: row.live.received, total: row.live.total })}
              </span>
            </span>
          )}
        </div>
      </div>
      {/* RD-1 zone C — the row control panel: play plus the per-kind
        action set, laid out horizontally. RD-3: the row stop joins this
        panel — a second SURFACE for the same single stopNarration path
        (FS-2 invariant intact: one path, two surfaces). Icon-only
        buttons: no RU width risk; the panel holds at most five 28px
        buttons plus gaps (~160px of the ~384px card width). */}
      <div data-testid="playlist-row-zone-controls" className="mt-1 border-t border-border2 pt-1">
        <div className="flex items-center gap-1.5">
          {/* RD-2: the play button turns into pause while THIS row's
            narration is playing (owner decision) — same lane pause as
            the footer toggle. A parked lane offers resume (native
            orchestrator resume: playback continues from position, no
            re-synthesis). Everywhere else the button (re)starts the
            lane via onPlay: settled rows replay from cache, a
            still-generating lane re-arms fresh (FS-2 restart). */}
          <CustomTooltip
            content={
              rowPlaying ? t("narration_playlist_pause") : rowPaused ? t("narration_playlist_resume") : t("narrate_action")
            }
          >
            <button
              type="button"
              aria-label={
                rowPlaying ? t("narration_playlist_pause") : rowPaused ? t("narration_playlist_resume") : t("narrate_action")
              }
              data-testid="playlist-row-play"
              onClick={rowPlaying ? input.onPause : rowPaused ? input.onResume : input.onPlay}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              {rowPlaying ? <Ic.pause /> : <Ic.play />}
            </button>
          </CustomTooltip>
          {/* RD-3: row stop — owner's «отдельно кнопка стоп», next to
            play/pause. Visible on live rows only (generating/playing/
            paused are all stopNarration-abortable); settled, partial
            and library rows never render it. Routes through the SAME
            input.onStop the footer stop uses — no second path. */}
          {live && (
            <CustomTooltip content={t("narrate_stop")}>
              <button
                type="button"
                aria-label={t("narrate_stop")}
                data-testid="playlist-row-stop"
                onClick={input.onStop}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
              >
                <Ic.stopSquare />
              </button>
            </CustomTooltip>
          )}
      {/* TPE-18c: library actions on SETTLED rows only. FS-3: partial rows
        offer no library save (the file is whole-track only) — they get
        continue + cache-drop instead. FS-6: cache-only full and partial
        rows offer re-voice (drop plus fresh narration). Library rows keep
        reveal + drop and omit re-voice: the saved file is preserved and
        would otherwise replay first. */}
      {!live && !row.inLibrary && !row.partial && (
        <CustomTooltip content={input.saving ? t("narration_playlist_saving") : t("narration_playlist_save")}>
          <button
            type="button"
            aria-label={t("narration_playlist_save")}
            data-testid="playlist-row-save"
            disabled={input.saving}
            onClick={input.onSave}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-default disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.download />
          </button>
        </CustomTooltip>
      )}
      {!live && row.inLibrary && input.canReveal && (
        <CustomTooltip content={t("narration_playlist_reveal_file")}>
          <button
            type="button"
            aria-label={t("narration_playlist_reveal_file")}
            data-testid="playlist-row-reveal"
            onClick={input.onReveal}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.fileText />
          </button>
        </CustomTooltip>
      )}
      {!live && row.inLibrary && (
        <CustomTooltip content={t("narration_playlist_drop_file")}>
          <button
            type="button"
            aria-label={t("narration_playlist_drop_file")}
            data-testid="playlist-row-drop"
            onClick={input.onDrop}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.del />
          </button>
        </CustomTooltip>
      )}
      {/* FS-3: cache-drop for partial cache-only rows (a partial that
        also carries a library flag keeps the library drop above — the
        file goes first, the row stays). Same 28px icon language. */}
      {!live && row.partial && !row.inLibrary && (
        <CustomTooltip content={t("narration_playlist_drop_cached")}>
          <button
            type="button"
            aria-label={t("narration_playlist_drop_cached")}
            data-testid="playlist-row-drop-cache"
            onClick={input.onDropCache}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.del />
          </button>
        </CustomTooltip>
      )}
      {/* FS-6: re-voice for cache-only settled rows (drop plus fresh
        narration). Library rows omit it to preserve the saved file. */}
      {!live && !row.inLibrary && (
        <CustomTooltip content={t("narration_playlist_revoice")}>
          <button
            type="button"
            aria-label={t("narration_playlist_revoice")}
            data-testid="playlist-row-revoice"
            onClick={input.onRevoice}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.regen />
          </button>
        </CustomTooltip>
      )}
        </div>
        {/* FS-3: partial rows carry an explicit continue-generation
          button — a full-width text control docked at the bottom of the
          control panel (w-full, wrapping: RU «Продолжить генерацию» never
          truncates). Re-running the narration resumes from cache (TPE-16:
          only missing segments synthesize) and a genuine completion clears
          the partial flag. */}
        {!live && row.partial && (
          <button
            type="button"
            data-testid="playlist-row-continue"
            onClick={input.onPlay}
            className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-accent/40 bg-accent-dim px-2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-accent-t transition-colors hover:bg-accent/20 [&_svg]:h-3 [&_svg]:w-3"
          >
            <Ic.play />
            <span>{t("narration_playlist_continue")}</span>
          </button>
        )}
      </div>
      {/* RD-1 zone D — playback status, live rows only: the TPE-18b
        PLAYBACK position bar (range + clock) at full card width,
        visually distinct from the FETCH mini-bar in zone B (accent fill +
        n/total). Unknown total: seeks over the known prefix; unknown
        segments are slivers, never estimates. */}
      {row.live !== null && (
        <div data-testid="playlist-row-zone-playback" className="mt-1 border-t border-border2 pt-1">
          <SeekBar progress={input.progress} onSeek={input.onSeek} />
        </div>
      )}
    </li>
  );
}
