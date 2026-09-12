import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppMessage } from "../../api/types.js";
import { useT } from "../../i18n/context.js";
import { firstThreeLines } from "../../lib/tts/narration-source.js";
import type { NarrationPlaylistEntry } from "../../lib/tts/narration-cache.js";
import type { NarrationProgress, NarrationState } from "../../lib/tts/tts-orchestrator.js";
import { cn } from "../../lib/cn.js";
import { Ic } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
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
   *  else the indexed snippet (owner decision; three source lines since
   *  2026-09-08 — old rows indexed at two lines stay two until re-voiced). */
  snippet: string;
  variantIndex: number;
  variantCount: number;
  live: NarrationState | null;
  /** TPE-18c: a saved library file exists for this exact variant. */
  inLibrary: boolean;
  /** RD-9 cache honesty: the index entry carries live cache keys (blobs
   *  present in the segment cache). False exactly for post-drop rows —
   *  the save evicted the blobs and the drop cleared the keys. The UI
   *  badges and the save button key off this, never off flags alone. */
  hasCache: boolean;
  /** FS-3: aborted before completing — a cached prefix with an explicit
   *  continue-generation button (no library save: the file is whole-track
   *  only). */
  partial: boolean;
}

function isLiveState(state: NarrationState | undefined): state is NarrationState {
  return state !== undefined && (state.status === "generating" || state.status === "playing" || state.status === "paused");
}

/** RD-9: the chunk-generation line renders only while segments are still
 *  landing (owner: complete recordings must not show «received n of n»).
 *  RD-10: `received < total` is also true transiently during pure cache
 *  reads, so the line additionally requires genuine synthesis work this
 *  lane — a replay that reads every chunk from cache synthesizes nothing
 *  and shows nothing. Exported pure for direct tests — the card keys its
 *  fetch line off this. */
export function isFetchIncomplete(live: NarrationState | null): live is NarrationState {
  return live !== null && live.total > 0 && live.received < live.total && live.synthesized > 0;
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
    // Live text is the full narration input — cut the three-line snippet
    // here (owner decision 2026-09-08); indexed rows already store the snippet.
    const liveSnippet = liveState ? firstThreeLines(liveTextById(message.id) ?? entry?.snippet ?? "") : null;
    const row: PlaylistRowModel = {
      messageId: message.id,
      snippet: liveSnippet ?? entry?.snippet ?? "",
      variantIndex: entry?.variantIndex ?? (selectedIndex >= 0 ? selectedIndex : 0),
      variantCount: variants.length,
      live: liveState,
      inLibrary: entry?.inLibrary === true,
      hasCache: (entry?.cacheKeys.length ?? 0) > 0,
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

/** RD-7: scroll the playlist's own list so the given message's card is
 *  visible (owner: «и при переходе к следующему сообщению прокручивать
 *  до него»). Container-scoped by construction: the card is queried
 *  inside the list element and `block: "nearest"` only moves ancestors
 *  that actually clip the card — the open popover is in-viewport, so
 *  the page/chat never scrolls, only the `overflow-y-auto` list does.
 *  rAF-deferred (bottom-pinning discipline: batch DOM scrolls with
 *  paint, no layout thrash); a missing list/card is a silent no-op so
 *  a closed panel or a short list can never break playback. Returns
 *  whether the scroll was scheduled (card found). */
export function scrollPlaylistListToMessage(list: HTMLElement, messageId: string): boolean {
  // Same escape pattern as showMessageInChat above: CSS.escape in
  // browsers, raw slug fallback in non-DOM runtimes. The selector is
  // data-playlist-message-id, NEVER data-message-id — playlist rows
  // must not shadow the MessageShell chat anchor (pinned by test).
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(messageId) : messageId;
  const card = list.querySelector(`[data-playlist-message-id="${escaped}"]`);
  if (!(card instanceof HTMLElement)) return false;
  const run = (): void => {
    try {
      card.scrollIntoView({ block: "nearest" });
    } catch {
      // Test DOMs without a scroll implementation — the call is
      // best-effort, playback continues regardless.
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
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
  /** RD-5: bar-level play-pause — playing → pause; paused → resume;
   *  idle → start the first playable card (panel owns the choice). */
  readonly onBarPlay: () => void;
  /** RD-5: bulk save — the panel runs the existing per-row save for
   *  every passed id (complete cache rows only, chosen below). */
  readonly onSaveAll: (messageIds: string[]) => void;
  /** RD-5: bulk re-voice — the panel drops the passed rows' caches and
   *  re-narrates fresh (fires only after the confirm below). */
  readonly onRevoiceAll: (messageIds: string[]) => void;
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
  /** RD-7: advance-edge scroll target — set by the panel ONLY when the
   *  continuous chain advances to a new message (never on manual
   *  plays, never while paused/stopped). Null means no scroll owed. */
  readonly scrollToMessageId: string | null;
  /** RD-7: clears the scroll target after the card was scrolled. */
  readonly onScrollToMessageDone: () => void;
}

export function NarrationPlaylist(input: NarrationPlaylistProps): ReactNode {
  const { t } = useT();
  const rows = buildPlaylistRows(input.messages, input.entries, input.narrations, input.liveTextById);
  // RD-5: bulk targets, derived from the same rows the list renders.
  // Save-all: settled cache rows with a COMPLETE track (partials have
  // no whole-track file; library rows are already saved). Re-voice-all:
  // every settled cache row (full + partial); library rows stay out
  // (FS-6 boundary) and live rows stay out (a destructive drop must not
  // race the live lane — row re-voice is settled-only for the same
  // reason). Both skip the live lane: saving is per-row independent,
  // drops are not.
  const completeIds = rows
    .filter((row) => row.live === null && !row.partial && !row.inLibrary && row.hasCache)
    .map((row) => row.messageId);
  const cacheIds = rows
    .filter((row) => row.live === null && !row.inLibrary)
    .map((row) => row.messageId);
  // RD-5: pending bulk re-voice (ids snapshotted at button click) — the
  // confirm below fires onRevoiceAll; cancel leaves caches intact.
  const [pendingRevoice, setPendingRevoice] = useState<string[] | null>(null);
  // RD-7: the list is the panel's own overflow container (flex-1 +
  // overflow-y-auto) — the scroll target below never leaves it.
  const listRef = useRef<HTMLUListElement | null>(null);
  // RD-7: advance-edge follow — runs when the target is set AND whenever
  // the rows re-derive (the next card lands asynchronously after the
  // advance fires, so the first pass usually finds no card and retries
  // on the narrations update). The target clears after the scroll is
  // scheduled; a card that never lands leaves a harmless pending target.
  useEffect(() => {
    if (!input.scrollToMessageId || !listRef.current) return;
    if (scrollPlaylistListToMessage(listRef.current, input.scrollToMessageId)) {
      input.onScrollToMessageDone();
    }
    // rows: re-run as the next card lands (fresh array per render).
  }, [input.scrollToMessageId, rows, input.onScrollToMessageDone]);

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
          {/* RD-8: header count as a chip (owner: variant-2 badge).
            Numeric content only — tabular-nums keeps the width stable
            as the count changes; ml-auto docks it at the right. */}
          <span
            data-testid="playlist-header-count"
            className="ml-auto shrink-0 rounded-full bg-s3 px-2 py-0.5 font-ui text-[10px] font-medium text-t2 tabular-nums"
          >
            {t("narration_playlist_count", { count: rows.length })}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState icon={<Ic.speaker />} title={t("narration_playlist_empty")} />
        </div>
      ) : (
        <ul ref={listRef} data-testid="playlist-row-list" className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
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
      {/* RD-5: the transport bar — transport line (unified play-pause +
        stop + rate + continuous toggle) over a bulk line (save-all +
        re-voice-all as text buttons). Two lines because one line cannot
        hold it: popover w-[26rem] (416px) minus px-3 padding minus the
        w-10 volume rail ≈ 344px of bar width; a single line would need
        play 28 + stop 28 + rate ~44 + save-all ~110 (RU «Сохранить всё»)
        + re-voice-all ~130 (RU «Переозвучить всё») + toggle ~130 +
        gaps ~36 ≈ 500px. Transport line ≈ 28+28+44+130+gaps ≈ 250px <
        340px ✓. Bulk line: two text buttons at natural width (authored
        strings are never truncated; labels wrap instead). */}
      <div className="border-t border-border2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          {/* RD-5: unified bar play-pause (owner's «плей-пауза») — lane
            playing → pause; lane parked → resume; idle → start the
            first card. Replaces the old pause-only toggle: one surface,
            the same lane pause/resume path, no duplicate affordance. */}
          <CustomTooltip
            content={
              input.anyLive && !input.livePaused
                ? t("narration_playlist_pause")
                : input.livePaused
                  ? t("narration_playlist_resume")
                  : t("narration_playlist_bar_play")
            }
          >
            <button
              type="button"
              aria-label={
                input.anyLive && !input.livePaused
                  ? t("narration_playlist_pause")
                  : input.livePaused
                    ? t("narration_playlist_resume")
                    : t("narration_playlist_bar_play")
              }
              data-testid="playlist-bar-play"
              disabled={rows.length === 0}
              onClick={input.onBarPlay}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-default disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              {input.anyLive && !input.livePaused ? <Ic.pause /> : <Ic.play />}
            </button>
          </CustomTooltip>
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
          {/* TPE-18d: continuous-play toggle — label + switch. The full
            phrase lives in the tooltip so the short label never
            truncates meaning. */}
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
        <div className="mt-1.5 flex items-center gap-1.5">
          {/* RD-5: save-all — the existing per-row save over every
            complete cache row; partials skipped (no whole-track file),
            library rows skipped (already saved). No confirm: the
            action is non-destructive (owner decision). */}
          <CustomTooltip content={t("narration_playlist_save_all")}>
            <button
              type="button"
              aria-label={t("narration_playlist_save_all")}
              data-testid="playlist-save-all"
              disabled={completeIds.length === 0}
              onClick={() => input.onSaveAll(completeIds)}
              className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border2 px-2 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-default disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
            >
              <Ic.download />
              <span className="min-w-0">{t("narration_playlist_save_all")}</span>
            </button>
          </CustomTooltip>
          {/* RD-5: re-voice-all — tooltip + shared destructive confirm
            (owner: «на переозвучку повесить конфирм»). Opens the
            confirm with the ids snapshotted here; disabled with no
            cache rows or while the lane is live (same settled-only
            rule as row re-voice). */}
          <CustomTooltip content={t("narration_playlist_revoice_all_hint")}>
            <button
              type="button"
              aria-label={t("narration_playlist_revoice_all")}
              data-testid="playlist-revoice-all"
              disabled={cacheIds.length === 0 || input.anyLive}
              onClick={() => setPendingRevoice(cacheIds)}
              className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border2 px-2 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:cursor-default disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
            >
              <Ic.regen />
              <span className="min-w-0">{t("narration_playlist_revoice_all")}</span>
            </button>
          </CustomTooltip>
        </div>
      </div>
      {/* RD-5: bulk re-voice confirm — fires only after explicit
        confirmation; cancel leaves every cache intact. */}
      {pendingRevoice !== null && (
        <DestructiveConfirmModal
          title={t("narration_playlist_revoice_all_title")}
          body={t("narration_playlist_revoice_all_body", { count: pendingRevoice.length })}
          confirmLabel={t("narration_playlist_revoice_all_confirm")}
          onConfirm={() => {
            const ids = pendingRevoice;
            setPendingRevoice(null);
            input.onRevoiceAll(ids);
          }}
          onCancel={() => setPendingRevoice(null)}
        />
      )}
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
  // RD-6: row-level re-voice confirm (owner: «на переозвучку повесить
  // конфирм») — local pending flag; the shared modal fires the
  // existing input.onRevoice (FS-6 drop+fresh chain), cancel leaves
  // the cache untouched. Two modal instances, not one shared: the
  // RD-5 bulk modal's pending state (string[] | null) and
  // count-parameterized copy are settled code — merging them into a
  // union state would churn RD-5 for zero behavioral gain.
  const [revoicePending, setRevoicePending] = useState(false);
  // RD-9: row-level drop-file confirm (owner: «на убрать так и не
  // сделал конфирм») — same shared modal pattern as the RD-6
  // re-voice confirm; cancel leaves the library file in place.
  const [dropPending, setDropPending] = useState(false);
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
  // RD-8: the row is a dividerless four-zone card (owner: «без
  // разделителя, так чище» — RD-1's border-t rules are gone; zones are
  // one block now). Player composition: a round transport button docks
  // at the LEFT edge, the content zones flow to its right. Magnifier
  // stays docked right of the snippet (a locate action tied to the
  // text, not to playback).
  // Width budget: the popover is w-[26rem] (416px, capped by
  // max-w-[calc(100vw-2rem)]), the list pads px-2 and the card px-2, so
  // a card is ~384px at most: round play 32 + gap 8 + content ~344px.
  // The action row holds at most four 28px icon buttons plus gaps
  // (~130px of the ~344px content width). No fixed widths for authored
  // strings anywhere (RU runs 20–30% longer): labels/badges size to
  // content, and only the snippet (unbounded user data in a density
  // list) clamps.
  // Playing highlight (owner: «с подсветкой карточки»): the card whose
  // narration is PLAYING gets the app's active-item language
  // (DiceTray twin: border-accent/50 + bg-accent-dim) — state-driven,
  // never hover. Live-but-not-playing keeps the plain accent-dim wash.
  return (
    <li
      data-testid="narration-playlist-row"
      data-playlist-message-id={row.messageId}
      className={cn(
        "rounded-md border border-transparent px-2 py-1.5",
        rowPlaying ? "border-accent/50 bg-accent-dim" : live ? "bg-accent-dim" : "hover:bg-s2",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {/* RD-9 left column — the row's transport: round play on top
          (RD-8 surface, RD-2 semantics), stop directly under it.
          Stop shows while the lane is live for this row
          (generating/playing/paused are all «в процессе», owner) —
          position change only, the RD-3 single path is untouched. */}
        <div data-testid="playlist-row-zone-transport" className="flex shrink-0 flex-col items-center gap-1.5">
        {/* RD-8: round transport button, left edge (owner: «круглый
          слева от карточки», variant-2 look). Same RD-2 semantics —
          only the surface changed: playing → pause icon on an accent
          fill; paused → play icon in an accent outline (marks the exact
          row the parked lane will resume from); idle → neutral fill
          with an accent hover. Handlers untouched. */}
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
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5",
              rowPlaying
                ? "bg-accent text-on-accent"
                : rowPaused
                  ? "border border-accent/60 bg-transparent text-accent-t"
                  : "bg-s3 text-t1 hover:bg-accent hover:text-on-accent",
            )}
          >
            {rowPlaying ? <Ic.pause /> : <Ic.play />}
          </button>
        </CustomTooltip>
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
        </div>
        {/* RD-9 center stack: text → state badges → gated generation →
          playback → continue. No dividers: one block. */}
        <div className="min-w-0 flex-1">
      {/* RD-9 head — the THREE-line snippet (owner decision). The
        magnifier moved to the right action column. */}
      <div data-testid="playlist-row-zone-head" className="flex min-w-0 items-start gap-1.5">
        <p className="line-clamp-3 min-w-0 flex-1 break-words font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-t1">
          {snippet}
        </p>
      </div>
      {/* RD-1 zone B — chunk status: swipe badge, cache/library badge,
        and the live fetch progress (n/total + bar). */}
      <div data-testid="playlist-row-zone-chunk" className="mt-1">
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
          {/* FS-7: in-cache badge — settled rows whose index keys are
            live (RD-9 cache honesty: `hasCache`, never flags alone).
            Partial rows keep the badge (their keys are the resumable
            prefix by construction). No fixed widths (RU «В кэше»). */}
          {!live && !row.inLibrary && (row.hasCache || row.partial) && (
            <span
              data-testid="playlist-row-cache-badge"
              className="shrink-0 rounded border border-accent/40 bg-accent-dim px-1 font-ui text-[calc(var(--ui-fs)-4px)] font-medium text-accent-t"
            >
              {t("narration_playlist_in_cache")}
            </span>
          )}
          {/* RD-9: post-drop state (owner: «может, сделать еще одно
            состояние бейджа? например "удалена"») — settled,
            non-partial, keyless. Uniquely the row whose library file
            was dropped after the save evicted its cache: audio-less
            until re-narrated. Neutral terminal tone (border2/t3), not
            the accent the live badges wear. Legacy rows with stale
            keys (dropped pre-fix) keep «В кэше» until re-voiced. */}
          {!live && !row.inLibrary && !row.partial && !row.hasCache && (
            <span
              data-testid="playlist-row-deleted-badge"
              className="shrink-0 rounded border border-border2 px-1 font-ui text-[calc(var(--ui-fs)-4px)] font-medium text-t3"
            >
              {t("narration_playlist_deleted")}
            </span>
          )}
          {/* RD-9: the generation line renders ONLY while chunks are
            still landing (isFetchIncomplete). Complete rows — live or
            settled — show no fetch line at all: «Получено n из n» on a
            finished recording is the noise the owner cut. Badges above
            stay in both states. */}
          {isFetchIncomplete(row.live) && (
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
      {/* RD-9 zone D — playback status: the TPE-18b PLAYBACK position
        bar (range + clock), moved up into the center stack (owner: text →
        badges → generation → playback). Visually distinct from the FETCH
        mini-bar in zone B (accent fill + n/total). Unknown total: seeks
        over the known prefix; unknown segments are slivers, never
        estimates.
        Owner live-fix 2026-09-08 (height jump between playing and
        settled states): the zone renders on EVERY row — live rows get
        the seek + clock, settled rows get a static neutral rail in the
        SAME slot (no thumb, no clock) so the card height never changes
        when a lane starts or settles. The slot mirrors the slider's
        28px (44px coarse-pointer) hit area. */}
      {row.live !== null ? (
        <div data-testid="playlist-row-zone-playback">
          <SeekBar progress={input.progress} onSeek={input.onSeek} />
        </div>
      ) : (
        <div data-testid="playlist-row-zone-playback" className="flex h-7 items-center [@media(pointer:coarse)]:h-11">
          <span data-testid="playlist-row-zone-playback-idle" className="block h-[3px] w-full rounded-full bg-s3" />
        </div>
      )}
        {/* FS-3: partial rows carry an explicit continue-generation
          button — a full-width text control at the bottom of the
          center stack (w-full, wrapping: RU «Продолжить генерацию» never
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
        {/* RD-9: the center stack closes here (head → chunk → playback
          → continue); the actions column follows as the card's third
          flex child (owner: buttons vertical under the magnifier). */}
        </div>
        {/* RD-9 right column — the row's actions, vertical under the
          magnifier (owner): locate first, then the per-kind pair
          (save/show-file, drop/re-voice, drop-cache). Same buttons and
          handlers as before (FS-6 boundary kept: library rows omit
          re-voice, cache-only rows omit reveal) — arrangement only.
          RD-9: save shows ONLY with a live cache (owner: «и прятать
          кнопку сейва» — post-drop rows have nothing to save); re-voice
          stays for cache rows AND the post-drop state (dropCachedRow on
          empty keys removes the entry, the fresh narration follows). */}
        <div data-testid="playlist-row-zone-actions" className="flex shrink-0 flex-col items-center gap-1.5">
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
      {/* RD-9: the per-kind action set moved to the right column
          below (after the center stack closes) — stop rides the left
          transport column now. This block is deleted content-wise. */}
      {/* TPE-18c: library actions on SETTLED rows only. FS-3: partial rows
        offer no library save (the file is whole-track only) — they get
        continue + cache-drop instead. FS-6: cache-only full and partial
        rows offer re-voice (drop plus fresh narration). Library rows keep
        reveal + drop and omit re-voice: the saved file is preserved and
        would otherwise replay first. */}
      {!live && !row.inLibrary && !row.partial && row.hasCache && (
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
            onClick={() => setDropPending(true)}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.del />
          </button>
        </CustomTooltip>
      )}
      {dropPending && (
        <DestructiveConfirmModal
          title={t("narration_playlist_drop_file_title")}
          body={t("narration_playlist_drop_file_body")}
          confirmLabel={t("narration_playlist_drop_file_confirm")}
          onConfirm={() => {
            setDropPending(false);
            input.onDrop();
          }}
          onCancel={() => setDropPending(false)}
        />
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
        narration). RD-6: the button only OPENS the confirm — confirm
        fires input.onRevoice (same FS-6 chain), cancel drops nothing.
        Library rows omit it to preserve the saved file. */}
      {!live && !row.inLibrary && (
        <>
          <CustomTooltip content={t("narration_playlist_revoice")}>
            <button
              type="button"
              aria-label={t("narration_playlist_revoice")}
              data-testid="playlist-row-revoice"
              onClick={() => setRevoicePending(true)}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <Ic.regen />
            </button>
          </CustomTooltip>
          {revoicePending && (
            <DestructiveConfirmModal
              title={t("narration_playlist_revoice_title")}
              body={t("narration_playlist_revoice_body")}
              confirmLabel={t("narration_playlist_revoice")}
              onConfirm={() => {
                setRevoicePending(false);
                input.onRevoice();
              }}
              onCancel={() => setRevoicePending(false)}
            />
          )}
        </>
      )}
        </div>
      </div>
    </li>
  );
}
