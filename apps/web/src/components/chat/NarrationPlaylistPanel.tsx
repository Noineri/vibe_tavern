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
import { isAndroidDevice } from "../../lib/platform.js";
import { Ic, Icons } from "../shared/icons.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import type { NarrationPlaylistEntry } from "../../lib/tts/narration-cache.js";
import { NarrationPlaylist, buildPlaylistRows, nextPlaybackRate } from "./NarrationPlaylist.js";

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
  // TPE-18d: continuous-play pref + chain arming/consumption.
  const continuous = useTtsPlaybackStore((s) => s.continuous);
  const advanceTo = useTtsPlaybackStore((s) => s.advanceTo);
  const setContinuous = useTtsPlaybackStore((s) => s.setContinuous);
  const clearAdvance = useTtsPlaybackStore((s) => s.clearAdvance);
  const stopNarration = useTtsPlaybackStore((s) => s.stopNarration);
  const pauseNarration = useTtsPlaybackStore((s) => s.pause);
  const resumeNarration = useTtsPlaybackStore((s) => s.resume);
  const seekNarration = useTtsPlaybackStore((s) => s.seek);
  const setVolume = useTtsPlaybackStore((s) => s.setVolume);
  const setRate = useTtsPlaybackStore((s) => s.setRate);
  const loadPlaylist = useTtsPlaybackStore((s) => s.loadPlaylist);
  // TPE-18c: library actions + per-row saving spinners.
  const saveToLibrary = useTtsPlaybackStore((s) => s.saveToLibrary);
  const dropLibraryRow = useTtsPlaybackStore((s) => s.dropLibraryRow);
  // FS-3: cache-only row drop (partial discard).
  const dropCachedRow = useTtsPlaybackStore((s) => s.dropCachedRow);
  const revealLibraryRow = useTtsPlaybackStore((s) => s.revealLibraryRow);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  // RD-7: advance-edge scroll target (set in the advance effect below,
  // cleared by the list once the card is scrolled). Declared up here so
  // the chat-boundary reset below reads naturally in source order.
  const [advanceScrollTarget, setAdvanceScrollTarget] = useState<string | null>(null);
  const clearAdvanceScrollTarget = useCallback(() => setAdvanceScrollTarget(null), []);
  // Static per mount (UA-based, not viewport): Android hides reveal.
  const [canReveal] = useState(() => !isAndroidDevice());

  // Collapse + reload the index at the chat/branch boundary (DicePanel pattern).
  useEffect(() => {
    setExpanded(false);
    // RD-7: a pending advance scroll belongs to the old chat — drop it.
    setAdvanceScrollTarget(null);
  }, [branchId, chatId]);
  // Collapse + reload the index at the chat/branch boundary (DicePanel pattern).
  // TPE-18c: library scope rides along when known so in-library flags
  // reconcile against the server (the index flag alone is a hint).
  useEffect(() => {
    if (!chatId) return;
    const scope = characterId && branchId ? { characterId, branchId } : undefined;
    void loadPlaylist(chatId, scope);
  }, [chatId, characterId, branchId, loadPlaylist]);

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

  // RD-5: the actual lane start — the chain queue is an explicit
  // argument so bulk flows (re-voice-all) can pass a queue captured
  // BEFORE destructive drops, instead of deriving it after.
  const startWithQueue = useCallback(
    (messageId: string, chainQueue: string[]): boolean => {
      if (resolution === null || resolution.kind !== "profile") return false;
      const message = messages.find((candidate) => candidate.id === messageId);
      const source = voicedVariantSource(message ?? null, macroContext, isCoauthorMode);
      if (!source || !chatId) return false;
      void startNarration(messageId, source.text, resolution.profile, {
        chatId,
        chainQueue,
        characterId,
        branchId,
        variantId: source.variantId,
        variantIndex: source.variantIndex,
        snippet: source.snippet,
      });
      return true;
    },
    [resolution, messages, macroContext, isCoauthorMode, chatId, characterId, branchId, startNarration],
  );

  const onPlay = useCallback(
    (messageId: string) => {
      // TPE-18d: arm the chain with the CURRENT panel row order (the
      // same derivation the list renders — live rows first, chat order).
      // Message-row starts never set chainQueue, so only panel plays
      // chain; a natural completion arms the row after the finished one.
      const chainQueue = buildPlaylistRows(messages, entries, narrations, liveTextById).map((row) => row.messageId);
      startWithQueue(messageId, chainQueue);
    },
    [messages, entries, narrations, liveTextById, startWithQueue],
  );

  // RD-5: bar-level play — the lane owns the icon. Parked lane resumes
  // (same path as the footer toggle RD-2 mirrored); idle lane starts
  // the FIRST card in panel order (live-first derivation: idle means no
  // live rows, so this is the first settled card in chat order). The
  // bar play is disabled with zero rows, so first is never undefined.
  const onBarPlay = useCallback(() => {
    if (livePaused) {
      resumeNarration();
      return;
    }
    if (anyLive) {
      pauseNarration();
      return;
    }
    const first = buildPlaylistRows(messages, entries, narrations, liveTextById)[0];
    if (first) onPlay(first.messageId);
  }, [livePaused, anyLive, resumeNarration, pauseNarration, messages, entries, narrations, liveTextById, onPlay]);

  // RD-7: the scroll target is set ONLY on this advance edge — the
  // store fires advanceTo solely on natural completion (stop/pause
  // paths clear it) and the effect additionally requires the
  // continuous pref, so manual plays and parked lanes can never owe
  // a scroll. The list component scrolls once the card lands.
  // TPE-18d: consume an armed advance — the store fires this only on a
  // natural completion (stop paths clear it), so reaching here always
  // means "played to the end, chain on". onPlay re-arms from the
  // clicked row, keeping the queue fresh as rows land.
  useEffect(() => {
    if (!advanceTo || advanceTo.chatId !== chatId || !continuous) return;
    const targetId = advanceTo.messageId;
    onPlay(targetId);
    clearAdvance();
    setAdvanceScrollTarget(targetId);
  }, [advanceTo, chatId, continuous, onPlay, clearAdvance]);

  const onCycleRate = useCallback(() => {
    setRate(nextPlaybackRate(rate));
  }, [rate, setRate]);

  const onSeek = useCallback(
    (messageId: string, positionSec: number) => {
      seekNarration(messageId, positionSec);
    },
    [seekNarration],
  );

  // TPE-18c: library row actions. Save shows a per-row spinner until the
  // merge + upload lands (badge flip confirms); failures already toasted
  // in the store, so the handlers only clear the spinner on both paths.
  const clearSaving = useCallback((messageId: string) => {
    setSavingIds((prev) => {
      if (!prev.has(messageId)) return prev;
      const next = new Set(prev);
      next.delete(messageId);
      return next;
    });
  }, []);
  const onSave = useCallback(
    (messageId: string) => {
      if (!chatId || !branchId || !characterId || savingIds.has(messageId)) return;
      setSavingIds((prev) => new Set(prev).add(messageId));
      void saveToLibrary({ chatId, branchId, characterId, messageId }).then(
        () => clearSaving(messageId),
        () => clearSaving(messageId),
      );
    },
    [chatId, branchId, characterId, savingIds, saveToLibrary, clearSaving],
  );
  const onReveal = useCallback(
    (messageId: string) => {
      if (!chatId || !branchId || !characterId) return;
      // Store toasts on failure — the panel only avoids the unhandled
      // rejection (async wrapper, not fire-and-forget void).
      void (async () => {
        try {
          await revealLibraryRow({ chatId, branchId, characterId, messageId });
        } catch {
          // Already surfaced via the store toast above.
        }
      })();
    },
    [chatId, branchId, characterId, revealLibraryRow],
  );
  const onDrop = useCallback(
    (messageId: string) => {
      if (!chatId || !branchId || !characterId) return;
      void (async () => {
        try {
          await dropLibraryRow({ chatId, branchId, characterId, messageId });
        } catch {
          // Already surfaced via the store toast above.
        }
      })();
    },
    [chatId, branchId, characterId, dropLibraryRow],
  );
  // FS-6: re-voice a cache-only settled row. Drop first so every segment
  // synthesizes fresh, then start with the same source onPlay uses. The
  // pre-start checks prevent a destructive drop when a narration cannot
  // start; the catch is a race guard for a row saved to the library after
  // render (its file stays untouched and re-voice aborts). This handler is
  // intentionally never offered on library rows.
  const onRevoice = useCallback(
    (messageId: string) => {
      if (!chatId || resolution === null || resolution.kind !== "profile") return;
      const message = messages.find((candidate) => candidate.id === messageId);
      const source = voicedVariantSource(message ?? null, macroContext, isCoauthorMode);
      if (!source) return;
      void (async () => {
        try {
          await dropCachedRow(chatId, messageId);
        } catch {
          return;
        }
        onPlay(messageId);
      })();
    },
    [chatId, dropCachedRow, macroContext, isCoauthorMode, messages, onPlay, resolution],
  );
  // FS-3: cache-drop for partial rows — local only (segment eviction +
  // index removal), so no branch/character scope is needed. The store
  // throws only for library rows, which never render this button; the
  // catch mirrors the library handlers above.
  const onDropCache = useCallback(
    (messageId: string) => {
      if (!chatId) return;
      void (async () => {
        try {
          await dropCachedRow(chatId, messageId);
        } catch {
          // Unreachable from the UI (button renders on cache-only rows).
        }
      })();
    },
    [chatId, dropCachedRow],
  );
  // RD-5: bulk save — the existing per-row save over every passed id
  // (the component passes complete cache rows only). No confirm: the
  // action writes library files, it destroys nothing. Per-row spinners
  // ride the same savingIds path as single saves.
  const onSaveAll = useCallback(
    (messageIds: string[]) => {
      for (const messageId of messageIds) onSave(messageId);
    },
    [onSave],
  );
  // RD-5: bulk re-voice — drop every passed row's cached segments,
  // then re-narrate the whole set fresh (fires only after the shared
  // destructive confirm). Pre-validate the first start BEFORE any drop
  // (FS-6 pattern): a failed pre-check must not destroy caches. The
  // chain needs Continuous on to walk the full queue, so it is enabled
  // here (the modal copy says so); the captured queue — not a fresh
  // derivation — arms the first start, because the drops land before it
  // and a post-drop derivation would see no rows. Library rows never
  // reach here (excluded from the component's target set).
  const onRevoiceAll = useCallback(
    (messageIds: string[]) => {
      if (messageIds.length === 0 || !chatId || resolution === null || resolution.kind !== "profile") return;
      const firstId = messageIds[0];
      if (firstId === undefined) return;
      const firstMessage = messages.find((candidate) => candidate.id === firstId);
      const source = voicedVariantSource(firstMessage ?? null, macroContext, isCoauthorMode);
      if (!source) return;
      void (async () => {
        if (!continuous) setContinuous(true);
        for (const messageId of messageIds) {
          try {
            await dropCachedRow(chatId, messageId);
          } catch {
            // Race: the row was saved to the library after render —
            // skip it, its file stays untouched.
          }
        }
        startWithQueue(firstId, messageIds);
      })();
    },
    [chatId, resolution, messages, macroContext, isCoauthorMode, continuous, setContinuous, dropCachedRow, startWithQueue],
  );

  // The pill stays mounted while the chat has anything to list — live
  // lanes, completed narrations, AND aborted-but-cached partials (FS-3:
  // partial tracks count, so stopNarration persists the aborted lane as a
  // partial row and the completed-only index no longer decides alone).
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
      onBarPlay={onBarPlay}
      onSaveAll={onSaveAll}
      onRevoiceAll={onRevoiceAll}
      onSeek={onSeek}
      onVolume={setVolume}
      continuous={continuous}
      onContinuous={setContinuous}
      scrollToMessageId={advanceScrollTarget}
      onScrollToMessageDone={clearAdvanceScrollTarget}
      onSave={onSave}
      onReveal={onReveal}
      onDrop={onDrop}
      onDropCache={onDropCache}
      onRevoice={onRevoice}
      savingIds={savingIds}
      canReveal={canReveal}
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
