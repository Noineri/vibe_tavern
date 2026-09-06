import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { brandId, type MessageId } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useOrderedMessages, useSnapshotStore } from "../../stores/snapshot-store.js";
import { useMacroContext } from "../../stores/chat-selectors.js";
import { useTtsPlaybackStore } from "../../stores/tts-playback-store.js";
import { useVoiceMapData } from "../../lib/tts/voice-map-data.js";
import { resolveNarrationProfile } from "../../lib/tts/voice-map.js";
import { voicedVariantSource } from "../../lib/tts/narration-source.js";
import { cn } from "../../lib/cn.js";
import { Ic, Icons } from "../shared/icons.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import type { NarrationPlaylistEntry } from "../../lib/tts/narration-cache.js";
import { NarrationPlaylist, nextPlaybackRate } from "./NarrationPlaylist.js";

/** TPE-18a: narration playlist panel — the DicePanel twin for voiced
 *  messages. Pill above the chat (launcher-bar sibling) → Radix Popover
 *  on desktop / BottomSheet on mobile; chat/branch switch resets. The
 *  panel rides entirely on TPE-16 machinery (segment cache, store lane,
 *  player): per-item play replays from cache (zero synthesis on hits). */

export interface NarrationPlaylistPanelProps {
  /** Same contract as DicePanel `docked`: render statically inside the
   *  shared launcher bar instead of absolute-centering above the input. */
  readonly docked?: boolean;
}

/** Stable empty rows (module-level so the playlist selector below never
 *  manufactures a fresh array per render — zustand would treat each one
 *  as a changed snapshot and force-update forever). */
const NO_ENTRIES: NarrationPlaylistEntry[] = [];

export function NarrationPlaylistPanel({ docked = false }: NarrationPlaylistPanelProps = {}): ReactNode {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const activeChat = useSnapshotStore((state) => state.activeChat);
  const activeBranch = useSnapshotStore((state) => state.activeBranch);
  const chatId = activeChat?.id ? String(activeChat.id) : null;
  const branchId = activeBranch?.id ? String(activeBranch.id) : null;
  const characterId = activeChat?.characterId ? String(activeChat.characterId) : null;
  const personaId = activeChat?.personaId ? String(activeChat.personaId) : null;
  const isCoauthorMode = activeChat?.mode === "coauthor";
  const macroContext = useMacroContext();
  const messages = useOrderedMessages();
  const { data: voiceMapData } = useVoiceMapData();

  // Subscribe to the stable playlist map (identity changes only on
  //  load/upsert) and derive this chat's rows in render — selecting the
  //  rows inline would mint a fresh [] per render and loop (see NO_ENTRIES).
  const playlist = useTtsPlaybackStore((s) => s.playlist);
  const entries = chatId && playlist[chatId] ? playlist[chatId] : NO_ENTRIES;
  const narrations = useTtsPlaybackStore((s) => s.narrations);
  const lastStarted = useTtsPlaybackStore((s) => s.lastStarted);
  const rate = useTtsPlaybackStore((s) => s.rate);
  // TPE-18b: player-layer controls (pause/seek/volume ride the store lane).
  const volume = useTtsPlaybackStore((s) => s.volume);
  const progress = useTtsPlaybackStore((s) => s.progress);
  const startNarration = useTtsPlaybackStore((s) => s.startNarration);
  const stopNarration = useTtsPlaybackStore((s) => s.stopNarration);
  const pauseNarration = useTtsPlaybackStore((s) => s.pause);
  const resumeNarration = useTtsPlaybackStore((s) => s.resume);
  const seekNarration = useTtsPlaybackStore((s) => s.seek);
  const setVolume = useTtsPlaybackStore((s) => s.setVolume);
  const setRate = useTtsPlaybackStore((s) => s.setRate);
  const loadPlaylist = useTtsPlaybackStore((s) => s.loadPlaylist);

  // Collapse + reload the index at the chat/branch boundary (DicePanel pattern).
  useEffect(() => {
    setExpanded(false);
  }, [branchId, chatId]);
  useEffect(() => {
    if (chatId) void loadPlaylist(chatId);
  }, [chatId, loadPlaylist]);

  const messageIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const liveIds = useMemo(
    () =>
      Object.entries(narrations)
        .filter(
          ([id, state]) =>
            messageIds.has(brandId<MessageId>(id)) &&
            (state.status === "generating" || state.status === "playing" || state.status === "paused"),
        )
        .map(([id]) => id),
    [narrations, messageIds],
  );
  const anyLive = liveIds.length > 0;
  // TPE-18b: single global lane — the first live row owns the transport.
  const livePaused = liveIds.length > 0 && narrations[liveIds[0]]?.status === "paused";

  const liveTextById = useCallback(
    (messageId: string): string | null =>
      lastStarted && lastStarted.messageId === messageId ? lastStarted.text : null,
    [lastStarted],
  );

  const resolution = useMemo(() => {
    if (!voiceMapData) return null;
    return resolveNarrationProfile(voiceMapData.profiles, voiceMapData.links, {
      ...(characterId ? { characterId } : {}),
      ...(personaId ? { personaId } : {}),
    });
  }, [voiceMapData, characterId, personaId]);

  const onPlay = useCallback(
    (messageId: string) => {
      if (resolution === null || resolution.kind !== "profile") return;
      const message = messages.find((candidate) => candidate.id === messageId);
      const source = voicedVariantSource(message ?? null, macroContext, isCoauthorMode);
      if (!source || !chatId) return;
      void startNarration(messageId, source.text, resolution.profile, {
        chatId,
        variantId: source.variantId,
        variantIndex: source.variantIndex,
        snippet: source.snippet,
      });
    },
    [resolution, messages, macroContext, isCoauthorMode, chatId, startNarration],
  );

  const onCycleRate = useCallback(() => {
    setRate(nextPlaybackRate(rate));
  }, [rate, setRate]);

  const onSeek = useCallback(
    (messageId: string, positionSec: number) => {
      seekNarration(messageId, positionSec);
    },
    [seekNarration],
  );

  // The pill stays hidden until something exists to list — an empty
  // playlist with no live lane is noise above the input area.
  if (!chatId || (entries.length === 0 && !anyLive)) return null;

  const pillLabel = anyLive
    ? t("narration_playlist_generating")
    : t("narration_playlist_count", { count: entries.length });

  const tray = (
    <NarrationPlaylist
      messages={messages}
      entries={entries}
      narrations={narrations}
      liveTextById={liveTextById}
      rate={rate}
      anyLive={anyLive}
      livePaused={livePaused}
      progress={progress}
      volume={volume}
      onPlay={onPlay}
      onStop={stopNarration}
      onCycleRate={onCycleRate}
      onPause={pauseNarration}
      onResume={resumeNarration}
      onSeek={onSeek}
      onVolume={setVolume}
      showTitle={!isMobile}
    />
  );

  const popover = (
    <Popover.Root open={expanded} onOpenChange={setExpanded}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t("narration_playlist_open")}
          data-testid="narration-playlist-pill"
          className={cn(
            "glass-blur flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border2 bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1",
            anyLive && "border-accent/40 bg-accent-dim text-accent-t",
          )}
        >
          {anyLive ? <Icons.audioLines className="animate-pulse" /> : <Ic.speaker />}
          <span>{pillLabel}</span>
          <Icons.Caret direction={expanded ? "d" : "u"} />
        </button>
      </Popover.Trigger>
      {!isMobile && (
        <Popover.Portal container={getModalPortal() ?? undefined}>
          <Popover.Content
            side="top"
            align="center"
            sideOffset={4}
            className="glass-blur z-[220] w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {tray}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );

  const sheet = expanded && isMobile && (
    <BottomSheet open={true} onClose={() => setExpanded(false)} title={t("narration_playlist_title")}>
      {tray}
    </BottomSheet>
  );

  if (docked) {
    return (
      <>
        {popover}
        {sheet}
      </>
    );
  }

  return (
    <div className="absolute bottom-full left-1/2 z-20 mb-1 flex -translate-x-1/2 items-center">
      {popover}
      {sheet}
    </div>
  );
}
