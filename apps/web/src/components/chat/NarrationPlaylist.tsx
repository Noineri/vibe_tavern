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
import { ScrollArea } from "../shared/scroll-area.js";
import { Toggle } from "../shared/Toggle.js";
import { PlaylistRow, type PlaylistRowModel } from "./playlist-row.js";

/** TPE-18a: the playlist body (DiceTray twin) — rows for everything
 *  narrated (or being narrated) in the current chat, plus the footer
 *  controls (global stop + pause + playback rate + volume, TPE-18b;
 *  continuous-play toggle, TPE-18d). NO library file writes here —
 *  the save/reveal/drop buttons call back into TPE-18c store actions.
 *  The row card itself (zones, confirms, show-in-chat jump) lives in
 *  playlist-row.tsx — extracted by the CNR-8l file-size ratchet when
 *  the row list below moved onto the shared thin ScrollArea lane. */

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

/** RD-7: scroll the playlist's own list so the given message's card is
 *  visible (owner: also scroll to it when moving to the next message).
 *  Container-scoped by construction: the card is queried
 *  inside the list element and `block: "nearest"` only moves ancestors
 *  that actually clip the card — the open popover is in-viewport, so
 *  the page/chat never scrolls, only the playlist's own thin-lane
 *  scroller does (CNR-8l: the native viewport Base UI renders under the
 *  <ul>). rAF-deferred (bottom-pinning discipline: batch DOM scrolls with
 *  paint, no layout thrash); a missing list/card is a silent no-op so
 *  a closed panel or a short list can never break playback. Returns
 *  whether the scroll was scheduled (card found). */
export function scrollPlaylistListToMessage(list: HTMLElement, messageId: string): boolean {
  // Same escape pattern as showMessageInChat (playlist-row.tsx):
  // CSS.escape in browsers, raw slug fallback in non-DOM runtimes. The
  // selector is data-playlist-message-id, NEVER data-message-id —
  // playlist rows must not shadow the MessageShell chat anchor (pinned
  // by test).
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(messageId) : messageId;
  const selector = `[data-playlist-message-id="${escaped}"]`;
  if (!(list.querySelector(selector) instanceof HTMLElement)) return false;
  const run = (): void => {
    // Re-resolve at paint time instead of holding the node across the
    // frame boundary: a re-render between schedule and paint can replace
    // the card element, and scrolling the stale detached node would be a
    // silent visual no-op — the card the user actually sees never moves.
    const card = list.querySelector(selector);
    if (!(card instanceof HTMLElement)) return;
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
  // RD-7: the list is the panel's own overflow container (the thin-lane
  // scroller below; the list itself stays its query root) — the scroll
  // target below never leaves it.
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
            className="ml-auto shrink-0 rounded-full bg-s3 px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-4px)] font-medium text-t2 tabular-nums"
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
        // CNR-8l: the row list rides the shared thin vertical lane (3px
        // rest / 5px hover) instead of the native 8px fallback — the flex
        // sizing sits on the ScrollArea root, while the <ul> keeps its own
        // element (the GalleryGrid wrapping-content idiom) so the RD-7 card
        // query root and the data-playlist-message-id anchors are untouched;
        // block:"nearest" scrollIntoView walks ancestors to the native
        // viewport Base UI renders. The lane hides on phones (CNR-7g
        // policy).
        <ScrollArea scrollbarSize="thin" className="min-h-0 flex-1">
          <ul ref={listRef} data-testid="playlist-row-list" className="px-2 py-1.5">
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
        </ScrollArea>
      )}
      {/* RD-5: the transport bar — transport line (unified play-pause +
        stop + rate + continuous toggle) over a bulk line (save-all +
        re-voice-all as text buttons). Two lines because one line cannot
        hold it: popover w-[26rem] (416px) minus px-3 padding minus the
        w-10 volume rail ≈ 344px of bar width; a single line would need
        play 28 + stop 28 + rate ~44 + save-all ~110 (RU "Save all")
        + re-voice-all ~130 (RU "Re-voice all") + toggle ~130 +
        gaps ~36 ≈ 500px. Transport line ≈ 28+28+44+130+gaps ≈ 250px <
        340px ✓. Bulk line: two text buttons at natural width (authored
        strings are never truncated; labels wrap instead). */}
      <div className="border-t border-border2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          {/* RD-5: unified bar play-pause (owner's "play-pause") — lane
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
            (owner: add a confirm to re-voice). Opens the
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
        (owner: no number entry at all). The footer keeps only the
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
