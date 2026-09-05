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
import { createNarrationSegmentCache, type NarrationSegmentCache } from "../lib/tts/narration-cache.js";

export type { NarrationState };

export interface TtsPlaybackState {
  narrations: Record<string, NarrationState>;
  rate: number;
  autoNarrate: boolean;
}

export interface TtsPlaybackActions {
  startNarration(messageId: string, text: string, profile: TtsProfileRecord): Promise<void>;
  pause(): void;
  resume(): void;
  skipSegment(): void;
  stopNarration(): void;
  setRate(rate: number): void;
  setAutoNarrate(value: boolean): void;
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
let activeOrchestrator: Orchestrator | null = null;
let activePlayer: NarrationPlayer | null = null;
let activeSynthesize: SynthesizeFn | null = null;
let activeCache: NarrationSegmentCache | null = null;
let sharedCache: NarrationSegmentCache | null = null;

function narrationCache(): NarrationSegmentCache {
  if (!sharedCache) sharedCache = createNarrationSegmentCache();
  return sharedCache;
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
  activeOrchestrator = createTtsOrchestrator({ player, synthesize, onState: writeNarrationState, cache });
  activePlayer = player;
  activeSynthesize = synthesize;
  activeCache = cache;
  return activeOrchestrator;
}

/** Test seam: replace orchestrator/player/synthesize/cache/notifyError. Pass null to restore defaults. */
export function __setTtsPlaybackDepsForTests(deps: {
  orchestrator?: Orchestrator | null;
  player?: NarrationPlayer | null;
  synthesize?: SynthesizeFn | null;
  cache?: NarrationSegmentCache | null;
  notifyError?: ((messageId: string, message: string) => void) | null;
} | null): void {
  if (!deps) {
    orchestratorOverride = null;
    playerOverride = null;
    synthesizeOverride = null;
    cacheOverride = null;
    notifyNarrationError = null;
    return;
  }
  if ("orchestrator" in deps) orchestratorOverride = deps.orchestrator ?? null;
  if ("player" in deps) playerOverride = deps.player ?? null;
  if ("synthesize" in deps) synthesizeOverride = deps.synthesize ?? null;
  if ("cache" in deps) cacheOverride = deps.cache ?? null;
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

  async startNarration(messageId, text, profile) {
    const orchestrator = orchestratorOverride ?? ensureOrchestrator();
    orchestrator.setRate(get().rate);
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
    (orchestratorOverride ?? activeOrchestrator)?.stop();
  },

  setRate(rate) {
    set({ rate });
    (orchestratorOverride ?? activeOrchestrator)?.setRate(rate);
  },

  setAutoNarrate(value) {
    set({ autoNarrate: value });
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
