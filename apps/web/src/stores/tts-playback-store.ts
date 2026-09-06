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
import type { NarratedReport } from "../lib/tts/tts-orchestrator.js";

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
}

/** TPE-18a: index metadata for one narration start — identifies the chat
 *  and variant the playlist row belongs to. */
export interface NarrationStartMeta {
  chatId: string;
  variantId: string;
  variantIndex: number;
  /** First two lines of the voiced variant text (owner decision). */
  snippet: string;
}

export interface TtsPlaybackActions {
  startNarration(messageId: string, text: string, profile: TtsProfileRecord, meta?: NarrationStartMeta): Promise<void>;
  pause(): void;
  resume(): void;
  skipSegment(): void;
  stopNarration(): void;
  setRate(rate: number): void;
  setAutoNarrate(value: boolean): void;
  /** TPE-18a: (re)load one chat's playlist rows from the persisted index. */
  loadPlaylist(chatId: string): Promise<void>;
  /** TPE-18a: drop one chat's rows from state (chat switch / tests). */
  clearPlaylist(chatId: string): void;
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
  const entry: NarrationPlaylistEntry = {
    messageId,
    variantId: meta.variantId,
    variantIndex: meta.variantIndex,
    snippet: meta.snippet,
    cacheKeys: report.cacheKeys,
    narratedAt: Date.now(),
  };
  await index.upsert(meta.chatId, entry);
  const rows = await index.list(meta.chatId);
  useTtsPlaybackStore.setState((s) => ({ playlist: { ...s.playlist, [meta.chatId]: rows } }));
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
  activeOrchestrator = createTtsOrchestrator({ player, synthesize, onState: writeNarrationState, onNarrated: handleNarrated, cache });
  activePlayer = player;
  activeSynthesize = synthesize;
  activeCache = cache;
  return activeOrchestrator;
}

/** Test seam: replace orchestrator/player/synthesize/cache/playlistIndex/notifyError. Pass null to restore defaults. */
export function __setTtsPlaybackDepsForTests(deps: {
  orchestrator?: Orchestrator | null;
  player?: NarrationPlayer | null;
  synthesize?: SynthesizeFn | null;
  cache?: NarrationSegmentCache | null;
  playlistIndex?: NarrationPlaylistIndex | null;
  notifyError?: ((messageId: string, message: string) => void) | null;
} | null): void {
  if (!deps) {
    orchestratorOverride = null;
    playerOverride = null;
    synthesizeOverride = null;
    cacheOverride = null;
    playlistIndexOverride = null;
    pendingIndexMeta = null;
    notifyNarrationError = null;
    return;
  }
  if ("orchestrator" in deps) orchestratorOverride = deps.orchestrator ?? null;
  if ("player" in deps) playerOverride = deps.player ?? null;
  if ("synthesize" in deps) synthesizeOverride = deps.synthesize ?? null;
  if ("cache" in deps) cacheOverride = deps.cache ?? null;
  if ("playlistIndex" in deps) playlistIndexOverride = deps.playlistIndex ?? null;
  if ("notifyError" in deps) notifyNarrationError = deps.notifyError ?? null;
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

  async startNarration(messageId, text, profile, meta) {
    const orchestrator = orchestratorOverride ?? ensureOrchestrator();
    orchestrator.setRate(get().rate);
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

  stopNarration() {
    pendingIndexMeta = null;
    set({ lastStarted: null });
    (orchestratorOverride ?? activeOrchestrator)?.stop();
  },

  setRate(rate) {
    set({ rate });
    (orchestratorOverride ?? activeOrchestrator)?.setRate(rate);
  },

  setAutoNarrate(value) {
    set({ autoNarrate: value });
  },

  async loadPlaylist(chatId) {
    const index = playlistIndexOverride ?? narrationPlaylistIndex();
    const rows = await index.list(chatId);
    set((s) => ({ playlist: { ...s.playlist, [chatId]: rows } }));
  },

  clearPlaylist(chatId) {
    set((s) => {
      if (!(chatId in s.playlist)) return s;
      const playlist = { ...s.playlist };
      delete playlist[chatId];
      return { playlist };
    });
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
