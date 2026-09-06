import type { ReactNode } from "react";
import type { AppMessage } from "../../api/types.js";
import { useT } from "../../i18n/context.js";
import { firstTwoLines } from "../../lib/tts/narration-source.js";
import type { NarrationPlaylistEntry } from "../../lib/tts/narration-cache.js";
import type { NarrationState } from "../../lib/tts/tts-orchestrator.js";
import { cn } from "../../lib/cn.js";
import { Ic } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { EmptyState } from "../shared/empty-state.js";

/** TPE-18a: the playlist body (DiceTray twin) — rows for everything
 *  narrated (or being narrated) in the current chat, plus the footer
 *  controls (global stop + playback rate). NO pause/seek/volume (TPE-18b),
 *  NO library (TPE-18c), NO auto-advance (TPE-18d). */

export interface PlaylistRowModel {
  messageId: string;
  /** What's shown: the live narration text while synthesizing/playing,
   *  else the indexed two-line snippet (owner decision). */
  snippet: string;
  variantIndex: number;
  variantCount: number;
  live: NarrationState | null;
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
  readonly onPlay: (messageId: string) => void;
  readonly onStop: () => void;
  readonly onCycleRate: () => void;
  readonly showTitle: boolean;
}

export function NarrationPlaylist(input: NarrationPlaylistProps): ReactNode {
  const { t } = useT();
  const rows = buildPlaylistRows(input.messages, input.entries, input.narrations, input.liveTextById);

  return (
    <div className="flex max-h-[min(28rem,calc(100dvh-12rem))] flex-col">
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
              onPlay={() => input.onPlay(row.messageId)}
              onStop={input.onStop}
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
      </div>
    </div>
  );
}

function PlaylistRow(input: {
  readonly row: PlaylistRowModel;
  readonly onPlay: () => void;
  readonly onStop: () => void;
}): ReactNode {
  const { t } = useT();
  const { row } = input;
  const live = row.live !== null;
  // The snippet is LLM/character-authored text in a density list —
  // line-clamp-2 truncation is the allowed context (rule: unbounded
  // user data may ellipsize in list rows). Our own UI strings below
  // (swipe label, progress) are never truncated.
  const snippet = row.snippet;
  const progress = row.live && row.live.total > 0
    ? Math.min(100, Math.round((row.live.played / row.live.total) * 100))
    : null;
  return (
    <li
      data-testid="narration-playlist-row"
      data-playlist-message-id={row.messageId}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1.5 py-1.5",
        live ? "bg-accent-dim" : "hover:bg-s2",
      )}
    >
      {live ? (
        <CustomTooltip content={t("narrate_stop")}>
          <button
            type="button"
            aria-label={t("narrate_stop")}
            data-testid="playlist-row-stop"
            onClick={input.onStop}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-accent-t transition-colors hover:bg-s3 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.stopSquare />
          </button>
        </CustomTooltip>
      ) : (
        <CustomTooltip content={t("narrate_action")}>
          <button
            type="button"
            aria-label={t("narrate_action")}
            data-testid="playlist-row-play"
            onClick={input.onPlay}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <Ic.play />
          </button>
        </CustomTooltip>
      )}
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 break-words font-ui text-[calc(var(--ui-fs)-3px)] leading-snug text-t1">
          {snippet}
        </p>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-4px)] text-t3 tabular-nums">
            {t("narration_playlist_swipe", { current: row.variantIndex + 1, total: row.variantCount })}
          </span>
          {row.live && row.live.total > 0 && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5" title={t("narration_playlist_fetching", { played: row.live.played, total: row.live.total })}>
              <span className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-s3">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${progress ?? 0}%` }} />
              </span>
              <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-4px)] text-t3 tabular-nums">
                {t("narration_playlist_fetching", { played: row.live.played, total: row.live.total })}
              </span>
            </span>
          )}
        </div>
      </div>
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
    </li>
  );
}
