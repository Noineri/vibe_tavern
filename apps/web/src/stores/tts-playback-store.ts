/**
 * Tts playback store — plain zustand store wiring the narration orchestrator.
 * Holds per-message narration state, global rate and auto-narrate flag
 * (default OFF — owner decision; manual per-message narrate is the default
 * journey).
 *
 * Lane invariant: exactly ONE orchestrator (and one real HTML-audio player)
 * exists for the app's lifetime — startNarration reuses it and the
 * orchestrator's own epoch/reset enforces the single global narration lane.
 * The orchestrator is only ever recreated when the injected test deps change
 * identity (the old one gets stop()ed first), which never happens in prod.
 */

import { create } from "zustand";
import { toast } from "sonner";
import type { TtsProfileRecord } from "../api/tts-api.js";
import { generateTtsSpeech } from "../api/tts-api.js";
import {
  __resetSharedKokoroClientForTests,
  ensureSharedKokoroModel,
} from "../lib/tts/kokoro/kokoro-client-instance.js";
import { createHtmlAudioNarrationPlayer } from "../lib/tts/narration-player.js";
import type { NarrationPlayer } from "../lib/tts/narration-player.js";
import { chunkNarrationText } from "../lib/tts/kokoro/kokoro-text.js";
import { createTtsOrchestrator } from "../lib/tts/tts-orchestrator.js";
import type { NarrationState, SynthesizeOptions } from "../lib/tts/tts-orchestrator.js";
import { createNarrationSegmentCache, createNarrationPlaylistIndex } from "../lib/tts/narration-cache.js";
import type { NarrationPlaylistEntry, NarrationPlaylistIndex, NarrationSegmentCache } from "../lib/tts/narration-cache.js";
import type { NarratedReport, NarrationProgress } from "../lib/tts/tts-orchestrator.js";
import { clampNarrationVolume, persistNarrationVolume, readNarrationVolume } from "../lib/tts/narration-volume.js";
import { persistContinuousPlay, readContinuousPlay } from "../lib/tts/narration-continuous.js";
import { encodeNarrationSegmentsToOgg } from "../lib/tts/narration-ogg.js";
import { narrationLibraryClient } from "../lib/tts/narration-library-client.js";
import type { NarrationLibraryClient, NarrationLibraryIds } from "../lib/tts/narration-library-client.js";

export type { NarrationState };

export interface TtsPlaybackState {
  narrations: Record<string, NarrationState>;
  rate: number;
  autoNarrate: boolean;
  /** TPE-18a: playlist index rows per chat (loaded via loadPlaylist). */
  playlist: Record<string, NarrationPlaylistEntry[]>;
  /** TPE-18a: the most recently started narration (text + index meta so
   *  the panel can render the live row before the index row lands).
   *  Cleared by stopNarration, overwritten by every start. */
  lastStarted: {
    messageId: string;
    text: string;
    meta: NarrationStartMeta | null;
  } | null;
  /** TPE-18b: global narration volume 0..1 (persisted local pref) —
   *  applies to every segment element, both playback surfaces. */
  volume: number;
  /** TPE-18b: live playback progress per message (seek-bar source). */
  progress: Record<string, NarrationProgress>;
  /** TPE-18d: continuous play — a naturally completed row advances to
   *  the next playlist row (panel order) until messages run out.
   *  Persisted local pref, default OFF (one-shot stays the default). */
  continuous: boolean;
  /** TPE-18d: the next row to start — armed by natural completion
   *  (handleNarrated), consumed by the panel effect (which owns the
   *  text/profile needed to start it). Cleared by every stop, every
   *  fresh start, and chat switches away from its chat. */
  advanceTo: { chatId: string; messageId: string } | null;
}

/** TPE-18a: index metadata for one narration start — identifies the chat
 *  and variant the playlist row belongs to. TPE-18c: characterId +
 *  branchId ride along so the store can address the narration library
 *  (one file per message per variant) without a second lookup.
 *  TPE-18d: chainQueue carries the panel row order at start time so a
 *  natural completion can arm the next row (message-row starts never
 *  set it — only playlist row plays chain). */
export interface NarrationStartMeta {
  chatId: string;
  chainQueue?: string[];
  /** Character whose assets folder hosts the library file (null =
   *  unindexed narration — plays, but never library-addressable). */
  characterId: string | null;
  /** Branch the narrated message lives on (null = same as above). */
  branchId: string | null;
  variantId: string;
  variantIndex: number;
  /** First two lines of the voiced variant text (owner decision). */
  snippet: string;
}

/** TPE-18c: a playlist row addressable in the narration library. */
export interface NarrationLibraryScope {
  chatId: string;
  branchId: string;
  characterId: string;
  messageId: string;
}

export interface TtsPlaybackActions {
  startNarration(messageId: string, text: string, profile: TtsProfileRecord, meta?: NarrationStartMeta): Promise<void>;
  pause(): void;
  resume(): void;
  skipSegment(): void;
  /** TPE-18b: jump the ruling lane to a cumulative position (seconds). */
  seek(messageId: string, positionSec: number): void;
  stopNarration(): void;
  setRate(rate: number): void;
  /** TPE-18b: global volume — persisted and forwarded to the lane. */
  setVolume(volume: number): void;
  setAutoNarrate(value: boolean): void;
  /** TPE-18a: (re)load one chat's playlist rows from the persisted index. */
  loadPlaylist(chatId: string, libraryScope?: { characterId: string; branchId: string }): Promise<void>;
  /** TPE-18c: reconcile in-library flags against the server (best-effort
   *  per row — one row's failure never clears another's flag). */
  refreshLibraryFlags(chatId: string, scope: { characterId: string; branchId: string }): Promise<void>;
  /** TPE-18c: merge this message's cached segments into ONE ogg, POST it
   *  to the library, evict the hash-cache keys. Rejects (after a visible
   *  toast) when segments are missing or the save fails. */
  saveToLibrary(scope: NarrationLibraryScope): Promise<{ leaf: string }>;
  /** TPE-18c: drop the saved FILE for a library row (the row stays —
   *  replay re-synthesizes fresh). No-op rows never render the button. */
  dropLibraryRow(scope: NarrationLibraryScope): Promise<void>;
  /** TPE-18c: reveal the saved file in the OS file manager. */
  revealLibraryRow(scope: NarrationLibraryScope): Promise<void>;
  /** TPE-18a: drop one chat's rows from state (chat switch / tests). */
  clearPlaylist(chatId: string): void;
  /** TPE-18d: continuous-play pref (persisted local, default OFF). */
  setContinuous(value: boolean): void;
  /** TPE-18d: drop an armed advance (panel consumed it). */
  clearAdvance(): void;
}

export type TtsPlaybackStore = TtsPlaybackState & TtsPlaybackActions;

type SynthesizeFn = (
  text: string,
  profile: TtsProfileRecord,
  voiceId: string,
  options?: SynthesizeOptions,
) => Promise<{ blob: Blob; mime: string }>;
type Orchestrator = ReturnType<typeof createTtsOrchestrator>;

function readSpeed(profile: TtsProfileRecord): number | undefined {
  const raw = profile.config["speed"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return undefined;
}

async function defaultSynthesize(
  text: string,
  profile: TtsProfileRecord,
  voiceId: string,
  options?: SynthesizeOptions,
): Promise<{ blob: Blob; mime: string }> {
  if (profile.backend === "kokoro") {
    const client = await ensureSharedKokoroModel();
    const out = await client.generateChunked(
      chunkNarrationText(text).map((chunk) => ({ text: chunk, voiceId })),
      readSpeed(profile),
    );
    return { blob: out.blob, mime: "audio/wav" };
  }
  // TPE-16: the orchestrator's abort signal rides into the fetch so the
  // stop button cancels the request, not just the UI lane.
  return generateTtsSpeech(
    { profileId: profile.id, text, speed: readSpeed(profile), voiceId },
    options?.signal !== undefined ? { signal: options.signal } : undefined,
  );
}

// ── HTML-audio player singleton (lazy — DOM-free until first play) ──────────

let htmlPlayer: NarrationPlayer | null = null;

function htmlAudioPlayer(): NarrationPlayer {
  if (!htmlPlayer) htmlPlayer = createHtmlAudioNarrationPlayer();
  return htmlPlayer;
}

function writeNarrationState(messageId: string, state: NarrationState): void {
  const previous = useTtsPlaybackStore.getState().narrations[messageId];
  useTtsPlaybackStore.setState((s) => ({ narrations: { ...s.narrations, [messageId]: state } }));
  // TPE-16: narration errors must be VISIBLE — a dead synthesis shows a
  // toast instead of silently returning the button to idle. Once per
  // error transition (repeated writes of the same error don't re-toast).
  if (state.status === "error" && state.error !== undefined && previous?.status !== "error") {
    const notify = notifyNarrationError ?? defaultNotifyNarrationError;
    notify(messageId, state.error);
  }
}

function defaultNotifyNarrationError(_messageId: string, message: string): void {
  try {
    toast.error(message);
  } catch {
    // Toast needs a DOM host; the error is already pinned in store state.
  }
}

/** Test seam for the error toast (happy-dom has its own sonner mock). */
let notifyNarrationError: ((messageId: string, message: string) => void) | null = null;

// ── Orchestrator lane (recreated only when test dep identities change) ──────

let orchestratorOverride: Orchestrator | null = null;
let playerOverride: NarrationPlayer | null = null;
let synthesizeOverride: SynthesizeFn | null = null;
let cacheOverride: NarrationSegmentCache | null = null;
let playlistIndexOverride: NarrationPlaylistIndex | null = null;
/** TPE-18c: narration-library HTTP client + segment merge seams. */
let libraryClientOverride: NarrationLibraryClient | null = null;
let mergeToOggOverride: ((blobs: Blob[]) => Promise<Uint8Array<ArrayBuffer>>) | null = null;
let activeOrchestrator: Orchestrator | null = null;
let activePlayer: NarrationPlayer | null = null;
let activeSynthesize: SynthesizeFn | null = null;
let activeCache: NarrationSegmentCache | null = null;
let sharedCache: NarrationSegmentCache | null = null;
let sharedPlaylistIndex: NarrationPlaylistIndex | null = null;
/** TPE-18a: index meta of the ruling narration start (consumed by the
 *  onNarrated completion report). Cleared on stop. */
let pendingIndexMeta: NarrationStartMeta | null = null;

function narrationCache(): NarrationSegmentCache {
  if (!sharedCache) sharedCache = createNarrationSegmentCache();
  return sharedCache;
}

function narrationLibrary(): NarrationLibraryClient {
  return libraryClientOverride ?? narrationLibraryClient();
}

async function defaultMergeToOgg(blobs: Blob[]): Promise<Uint8Array<ArrayBuffer>> {
  return (await encodeNarrationSegmentsToOgg(blobs)).bytes;
}

function mergeToOgg(): (blobs: Blob[]) => Promise<Uint8Array<ArrayBuffer>> {
  return mergeToOggOverride ?? defaultMergeToOgg;
}

/** TPE-18c: visible library failure — same toast path as synthesis
 *  errors (the row button already flipped to a spinner; silent failure
 *  would strand it). */
function notifyLibraryError(messageId: string, message: string): void {
  const notify = notifyNarrationError ?? defaultNotifyNarrationError;
  notify(messageId, message);
}

function narrationPlaylistIndex(): NarrationPlaylistIndex {
  if (!sharedPlaylistIndex) sharedPlaylistIndex = createNarrationPlaylistIndex();
  return sharedPlaylistIndex;
}

/** TPE-18a: completion report → persisted index row + state refresh.
 *  Best-effort: index failures never surface (the narration already
 *  succeeded — playback state is the source of truth, not the index). */
async function handleNarrated(messageId: string, report: NarratedReport): Promise<void> {
  const meta = pendingIndexMeta;
  pendingIndexMeta = null;
  if (!meta) return;
  const index = playlistIndexOverride ?? narrationPlaylistIndex();
  const prior = (await index.list(meta.chatId)).find((candidate) => candidate.messageId === messageId);
  const entry: NarrationPlaylistEntry = {
    messageId,
    variantId: meta.variantId,
    variantIndex: meta.variantIndex,
    snippet: meta.snippet,
    cacheKeys: report.cacheKeys,
    narratedAt: Date.now(),
  };
  await index.upsert(meta.chatId, entry);
  // TPE-18c: a fresh synthesis invalidates the saved file (the audio may
  // differ — same path for same variant, orphan path on variant switch).
  // Drop it best-effort so stale audio can never replay as "library";
  // re-saving is one tap. Skipped without full library scope.
  if (prior?.inLibrary === true && meta.characterId && meta.branchId) {
    try {
      await narrationLibrary().deleteRecording({
        characterId: meta.characterId,
        chatId: meta.chatId,
        branchId: meta.branchId,
        messageId,
        variantIndex: prior.variantIndex,
      });
    } catch {
      // Best-effort invalidation — the flag below already cleared.
    }
  }
  const rows = await index.list(meta.chatId);
  useTtsPlaybackStore.setState((s) => ({ playlist: { ...s.playlist, [meta.chatId]: rows } }));
  // TPE-18d: continuous play — a NATURAL completion arms the next
  // queue row (the panel effect performs the actual start: the store
  // has no text/profile). stop() never reaches here (epoch-only
  // completion), so an armed advance always means "played to the end".
  // No next row (or the finished id left the queue) ends the chain.
  if (useTtsPlaybackStore.getState().continuous && meta.chainQueue) {
    const at = meta.chainQueue.indexOf(messageId);
    const next = at >= 0 ? meta.chainQueue[at + 1] : undefined;
    if (next !== undefined) {
      useTtsPlaybackStore.setState({ advanceTo: { chatId: meta.chatId, messageId: next } });
    }
  }
}

/** TPE-18c: write fresh playlist rows for one chat (single state write). */
async function refreshPlaylistRows(chatId: string): Promise<void> {
  const index = playlistIndexOverride ?? narrationPlaylistIndex();
  const rows = await index.list(chatId);
  useTtsPlaybackStore.setState((s) => ({ playlist: { ...s.playlist, [chatId]: rows } }));
}

/** TPE-18c: clear a stale in-library flag (the file is gone server-side)
 *  so the next start falls through to synthesis — self-healing, no toast
 *  (the synth that follows either succeeds or toasts on its own). */
async function clearLibraryFlag(chatId: string, messageId: string): Promise<void> {
  const index = playlistIndexOverride ?? narrationPlaylistIndex();
  const rows = await index.list(chatId);
  const row = rows.find((entry) => entry.messageId === messageId);
  if (!row || row.inLibrary !== true) return;
  await index.upsert(chatId, { ...row, inLibrary: false });
  await refreshPlaylistRows(chatId);
}

/** TPE-18c: library-first playback — a saved file for THIS variant plays
 *  the single-file timeline with zero synthesis. Returns true when the
 *  library served the narration (the caller skips synthesis); a stale
 *  flag (file 404s) heals to false so synthesis follows. Transient fetch
 *  failures return false WITHOUT clearing the flag (synthesis will
 *  surface its own error). */
async function tryPlayLibrary(messageId: string, text: string, meta: NarrationStartMeta): Promise<boolean> {
  if (!meta.characterId || !meta.branchId) return false;
  const rows = useTtsPlaybackStore.getState().playlist[meta.chatId] ?? [];
  const row = rows.find((entry) => entry.messageId === messageId);
  if (!row || row.inLibrary !== true || row.variantIndex !== meta.variantIndex) return false;
  const ids: NarrationLibraryIds = {
    characterId: meta.characterId,
    chatId: meta.chatId,
    branchId: meta.branchId,
    messageId,
    variantIndex: meta.variantIndex,
  };
  let blob: Blob | null;
  try {
    blob = await narrationLibrary().fetchRecording(ids);
  } catch {
    return false;
  }
  if (!blob) {
    await clearLibraryFlag(meta.chatId, messageId);
    return false;
  }
  const orchestrator = orchestratorOverride ?? ensureOrchestrator();
  orchestrator.setRate(useTtsPlaybackStore.getState().rate);
  orchestrator.setVolume(useTtsPlaybackStore.getState().volume);
  // No re-index: the row already exists (library replays never report).
  pendingIndexMeta = null;
  useTtsPlaybackStore.setState({ lastStarted: { messageId, text, meta } });
  await orchestrator.playLibrary(messageId, blob);
  return true;
}

/** TPE-18b: progress snapshots land in store state for the seek bar. */
function writeNarrationProgress(messageId: string, progress: NarrationProgress): void {
  useTtsPlaybackStore.setState((s) => ({ progress: { ...s.progress, [messageId]: progress } }));
}

function ensureOrchestrator(): Orchestrator {
  const player = playerOverride ?? htmlAudioPlayer();
  const synthesize = synthesizeOverride ?? defaultSynthesize;
  const cache = cacheOverride ?? narrationCache();
  if (
    activeOrchestrator &&
    activePlayer === player &&
    activeSynthesize === synthesize &&
    activeCache === cache
  ) {
    return activeOrchestrator;
  }
  // Deps changed (test seam swap): stop the abandoned lane cleanly first.
  activeOrchestrator?.stop();
  activeOrchestrator = createTtsOrchestrator({ player, synthesize, onState: writeNarrationState, onProgress: writeNarrationProgress, onNarrated: handleNarrated, cache });
  activePlayer = player;
  activeSynthesize = synthesize;
  activeCache = cache;
  return activeOrchestrator;
}

/** Test seam: replace orchestrator/player/synthesize/cache/playlistIndex/notifyError/libraryClient/mergeToOgg. Pass null to restore defaults. */
export function __setTtsPlaybackDepsForTests(deps: {
  orchestrator?: Orchestrator | null;
  player?: NarrationPlayer | null;
  synthesize?: SynthesizeFn | null;
  cache?: NarrationSegmentCache | null;
  playlistIndex?: NarrationPlaylistIndex | null;
  notifyError?: ((messageId: string, message: string) => void) | null;
  libraryClient?: NarrationLibraryClient | null;
  mergeToOgg?: ((blobs: Blob[]) => Promise<Uint8Array<ArrayBuffer>>) | null;
} | null): void {
  if (!deps) {
    orchestratorOverride = null;
    playerOverride = null;
    synthesizeOverride = null;
    cacheOverride = null;
    playlistIndexOverride = null;
    pendingIndexMeta = null;
    notifyNarrationError = null;
    libraryClientOverride = null;
    mergeToOggOverride = null;
    return;
  }
  if ("orchestrator" in deps) orchestratorOverride = deps.orchestrator ?? null;
  if ("player" in deps) playerOverride = deps.player ?? null;
  if ("synthesize" in deps) synthesizeOverride = deps.synthesize ?? null;
  if ("cache" in deps) cacheOverride = deps.cache ?? null;
  if ("playlistIndex" in deps) playlistIndexOverride = deps.playlistIndex ?? null;
  if ("notifyError" in deps) notifyNarrationError = deps.notifyError ?? null;
  if ("libraryClient" in deps) libraryClientOverride = deps.libraryClient ?? null;
  if ("mergeToOgg" in deps) mergeToOggOverride = deps.mergeToOgg ?? null;
}

export function __resetKokoroClientForTests(): void {
  __resetSharedKokoroClientForTests();
}

// ── Store ──────────────────────────────────────────────────────────────────

export const useTtsPlaybackStore = create<TtsPlaybackStore>()((set, get) => ({
  narrations: {},
  rate: 1,
  autoNarrate: false,
  playlist: {},
  lastStarted: null,
  volume: readNarrationVolume(),
  progress: {},
  continuous: readContinuousPlay(),
  advanceTo: null,

  async startNarration(messageId, text, profile, meta) {
    // TPE-18d: a fresh start replaces the lane — a stale armed advance
    // (e.g. a message-row play between completion and the panel effect)
    // must not fire into the new lane. The panel consumes advanceTo
    // synchronously before starting, so this never eats a live chain.
    if (get().advanceTo !== null) set({ advanceTo: null });
    // TPE-18c: library-first — a saved file for this exact variant plays
    // with zero synthesis (the row already exists, nothing re-indexes).
    if (meta && (await tryPlayLibrary(messageId, text, meta))) return;
    const orchestrator = orchestratorOverride ?? ensureOrchestrator();
    orchestrator.setRate(get().rate);
    // TPE-18b: a recreated lane (or the real player) starts at full
    // volume unless the store says otherwise — apply every start.
    orchestrator.setVolume(get().volume);
    pendingIndexMeta = meta ?? null;
    set({ lastStarted: { messageId, text, meta: meta ?? null } });
    await orchestrator.narrate(messageId, text, profile);
  },

  pause() {
    (orchestratorOverride ?? activeOrchestrator)?.pause();
  },

  resume() {
    (orchestratorOverride ?? activeOrchestrator)?.resume();
  },

  skipSegment() {
    (orchestratorOverride ?? activeOrchestrator)?.skipSegment();
  },

  seek(messageId, positionSec) {
    // The orchestrator is a single global lane — only the ruling
    // narration accepts a seek; anything else is a stale row action.
    if (get().lastStarted?.messageId !== messageId) return;
    (orchestratorOverride ?? activeOrchestrator)?.seekTo(positionSec);
  },

  stopNarration() {
    const stoppedId = get().lastStarted?.messageId;
    pendingIndexMeta = null;
    set((s) => {
      // TPE-18d: every stop breaks the chain (footer stop, message-row
      // stop, message switch) — an armed advance dies with the lane.
      if (stoppedId === undefined || !(stoppedId in s.progress)) return { lastStarted: null, advanceTo: null };
      const progress = { ...s.progress };
      delete progress[stoppedId];
      return { lastStarted: null, progress, advanceTo: null };
    });
    (orchestratorOverride ?? activeOrchestrator)?.stop();
  },

  setRate(rate) {
    set({ rate });
    (orchestratorOverride ?? activeOrchestrator)?.setRate(rate);
  },

  setVolume(volume) {
    const clamped = clampNarrationVolume(volume);
    set({ volume: clamped });
    persistNarrationVolume(clamped);
    (orchestratorOverride ?? activeOrchestrator)?.setVolume(clamped);
  },

  setAutoNarrate(value) {
    set({ autoNarrate: value });
  },

  async loadPlaylist(chatId, libraryScope) {
    const index = playlistIndexOverride ?? narrationPlaylistIndex();
    const rows = await index.list(chatId);
    set((s) => ({
      playlist: { ...s.playlist, [chatId]: rows },
      // TPE-18d: a chat switch mid-chain stops the chain (the armed
      // advance belongs to the old chat). Same-chat reloads keep it.
      advanceTo: s.advanceTo && s.advanceTo.chatId !== chatId ? null : s.advanceTo,
    }));
    // TPE-18c: reconcile in-library flags against the server (the index
    // flag is a hint — files can be dropped outside this browser).
    if (libraryScope) await get().refreshLibraryFlags(chatId, libraryScope);
  },

  async refreshLibraryFlags(chatId, scope) {
    const rows = get().playlist[chatId] ?? [];
    if (rows.length === 0) return;
    const client = narrationLibrary();
    const reconciled = await Promise.all(
      rows.map(async (entry) => {
        const ids: NarrationLibraryIds = {
          characterId: scope.characterId,
          chatId,
          branchId: scope.branchId,
          messageId: entry.messageId,
          variantIndex: entry.variantIndex,
        };
        try {
          return { ...entry, inLibrary: await client.recordingExists(ids) };
        } catch {
          // Best-effort per row: a failed check keeps the index hint.
          return entry;
        }
      }),
    );
    set((s) => ({ playlist: { ...s.playlist, [chatId]: reconciled } }));
  },

  async saveToLibrary(scope) {
    const rows = get().playlist[scope.chatId] ?? [];
    const entry = rows.find((candidate) => candidate.messageId === scope.messageId);
    if (!entry || entry.cacheKeys.length === 0) {
      const message = "nothing saved for this message yet — narrate it first, then save";
      notifyLibraryError(scope.messageId, message);
      throw new Error(message);
    }
    try {
      const cache = cacheOverride ?? narrationCache();
      const blobs: Blob[] = [];
      for (const key of entry.cacheKeys) {
        let blob: Blob | null = null;
        try {
          blob = await cache.get(key);
        } catch {
          blob = null;
        }
        if (!blob) {
          throw new Error("a cached segment expired — re-narrate the message, then save again");
        }
        blobs.push(blob);
      }
      const bytes = await mergeToOgg()(blobs);
      const ids: NarrationLibraryIds = {
        characterId: scope.characterId,
        chatId: scope.chatId,
        branchId: scope.branchId,
        messageId: scope.messageId,
        variantIndex: entry.variantIndex,
      };
      const { leaf } = await narrationLibrary().saveRecording(ids, new Blob([bytes], { type: "audio/ogg" }));
      // Library replaces cache (owner decision): evict the hash keys so
      // later replays can only come from the single file.
      for (const key of entry.cacheKeys) {
        try {
          await cache.delete(key);
        } catch {
          // Best-effort eviction — the library file already won.
        }
      }
      const index = playlistIndexOverride ?? narrationPlaylistIndex();
      await index.upsert(scope.chatId, { ...entry, inLibrary: true });
      await refreshPlaylistRows(scope.chatId);
      return { leaf };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyLibraryError(scope.messageId, message);
      throw error;
    }
  },

  async dropLibraryRow(scope) {
    const rows = get().playlist[scope.chatId] ?? [];
    const entry = rows.find((candidate) => candidate.messageId === scope.messageId);
    if (!entry || entry.inLibrary !== true) {
      const message = "this message has no saved library file to drop";
      notifyLibraryError(scope.messageId, message);
      throw new Error(message);
    }
    try {
      const ids: NarrationLibraryIds = {
        characterId: scope.characterId,
        chatId: scope.chatId,
        branchId: scope.branchId,
        messageId: scope.messageId,
        variantIndex: entry.variantIndex,
      };
      await narrationLibrary().deleteRecording(ids);
      // The row stays (replay re-synthesizes fresh); only the flag drops.
      const index = playlistIndexOverride ?? narrationPlaylistIndex();
      await index.upsert(scope.chatId, { ...entry, inLibrary: false });
      await refreshPlaylistRows(scope.chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyLibraryError(scope.messageId, message);
      throw error;
    }
  },

  async revealLibraryRow(scope) {
    const rows = get().playlist[scope.chatId] ?? [];
    const entry = rows.find((candidate) => candidate.messageId === scope.messageId);
    if (!entry || entry.inLibrary !== true) {
      const message = "this message has no saved library file to reveal";
      notifyLibraryError(scope.messageId, message);
      throw new Error(message);
    }
    try {
      await narrationLibrary().revealRecording({
        characterId: scope.characterId,
        chatId: scope.chatId,
        branchId: scope.branchId,
        messageId: scope.messageId,
        variantIndex: entry.variantIndex,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyLibraryError(scope.messageId, message);
      throw error;
    }
  },

  clearPlaylist(chatId) {
    set((s) => {
      // TPE-18d: dropping the chat's rows drops its armed advance too.
      const advanceTo = s.advanceTo && s.advanceTo.chatId === chatId ? null : s.advanceTo;
      if (!(chatId in s.playlist)) return advanceTo === s.advanceTo ? s : { ...s, advanceTo };
      const playlist = { ...s.playlist };
      delete playlist[chatId];
      return { playlist, advanceTo };
    });
  },

  setContinuous(value) {
    set({ continuous: value });
    persistContinuousPlay(value);
  },

  clearAdvance() {
    set({ advanceTo: null });
  },
}));

if (typeof window !== "undefined") {
  window.__useTtsPlaybackStore = useTtsPlaybackStore;
}

declare global {
  interface Window {
    __useTtsPlaybackStore?: typeof useTtsPlaybackStore;
  }
}
