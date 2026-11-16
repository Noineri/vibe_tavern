/**
 * The narration playlist's row card (TPE-18a body; RD-8/RD-9 card zones),
 * extracted from NarrationPlaylist.tsx by the CNR-8l file-size ratchet when
 * the row list moved onto the shared thin ScrollArea lane: the panel body
 * (row model derivation, list scroller, transport footer) stays in
 * NarrationPlaylist.tsx, this module owns ONE card's zones — the transport
 * column, the center stack (text → badges → generation → playback →
 * continue) and the right action column — plus the two row-scoped helpers
 * (the show-in-chat jump and the fetch-incomplete predicate). No library
 * file writes here; every action calls back into the panel's store actions.
 */

import { useState, type ReactNode } from "react";
import type { NarrationProgress, NarrationState } from "../../lib/tts/tts-orchestrator.js";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Ic } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { DestructiveConfirmModal } from "../shared/destructive-confirm-modal.js";
import { SeekBar } from "./playlist-seek-bar.js";

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

export function PlaylistRow(input: {
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
  // RD-6: row-level re-voice confirm (owner: add a confirm to re-voice)
  // — local pending flag; the shared modal fires the
  // existing input.onRevoice (FS-6 drop+fresh chain), cancel leaves
  // the cache untouched. Two modal instances, not one shared: the
  // RD-5 bulk modal's pending state (string[] | null) and
  // count-parameterized copy are settled code — merging them into a
  // union state would churn RD-5 for zero behavioral gain.
  const [revoicePending, setRevoicePending] = useState(false);
  // RD-9: row-level drop-file confirm (owner: never got around to
  // adding the remove confirm) — same shared modal pattern as the RD-6
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
  // RD-8: the row is a dividerless four-zone card (owner: no divider,
  // cleaner that way — RD-1's border-t rules are gone; zones are
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
  // Playing highlight (owner: highlight the card): the card whose
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
          (generating/playing/paused are all "in progress", owner) —
          position change only, the RD-3 single path is untouched. */}
        <div data-testid="playlist-row-zone-transport" className="flex shrink-0 flex-col items-center gap-1.5">
        {/* RD-8: round transport button, left edge (owner: round,
          left of the card, variant-2 look). Same RD-2 semantics —
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
            prefix by construction). No fixed widths (RU "In cache"). */}
          {!live && !row.inLibrary && (row.hasCache || row.partial) && (
            <span
              data-testid="playlist-row-cache-badge"
              className="shrink-0 rounded border border-accent/40 bg-accent-dim px-1 font-ui text-[calc(var(--ui-fs)-4px)] font-medium text-accent-t"
            >
              {t("narration_playlist_in_cache")}
            </span>
          )}
          {/* RD-9: post-drop state (owner: maybe one more badge state,
            e.g. "deleted") — settled,
            non-partial, keyless. Uniquely the row whose library file
            was dropped after the save evicted its cache: audio-less
            until re-narrated. Neutral terminal tone (border2/t3), not
            the accent the live badges wear. Legacy rows with stale
            keys (dropped pre-fix) keep "In cache" until re-voiced. */}
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
            settled — show no fetch line at all: "Received n of n" on a
            finished recording is the noise the owner cut. Badges above
            stay in both states. */}
          {isFetchIncomplete(row.live) && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
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
          center stack (w-full, wrapping: RU "Continue generation" never
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
          RD-9: save shows ONLY with a live cache (owner: and hide the
          save button — post-drop rows have nothing to save); re-voice
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
