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
import type { TtsProfileRecord } from "../api/tts-api.js";
import { generateTtsSpeech } from "../api/tts-api.js";
import { KokoroTtsClient } from "../lib/tts/kokoro/kokoro-client.js";
import { createKokoroWorker } from "../lib/tts/kokoro/kokoro-worker-factory.js";
import { createHtmlAudioNarrationPlayer } from "../lib/tts/narration-player.js";
import type { NarrationPlayer } from "../lib/tts/narration-player.js";
import { createTtsOrchestrator } from "../lib/tts/tts-orchestrator.js";
import type { NarrationState } from "../lib/tts/tts-orchestrator.js";

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

type SynthesizeFn = (text: string, profile: TtsProfileRecord) => Promise<{ blob: Blob; mime: string }>;
type Orchestrator = ReturnType<typeof createTtsOrchestrator>;

// ── Kokoro client singleton (lazy — no worker until first kokoro narrate) ───

let kokoroClient: KokoroTtsClient | null = null;

function getKokoroClient(): KokoroTtsClient {
  if (!kokoroClient) {
    kokoroClient = new KokoroTtsClient(createKokoroWorker);
  }
  return kokoroClient;
}

function readSpeed(profile: TtsProfileRecord): number | undefined {
  const raw = profile.config["speed"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return undefined;
}

async function defaultSynthesize(text: string, profile: TtsProfileRecord): Promise<{ blob: Blob; mime: string }> {
  if (profile.backend === "kokoro") {
    const client = getKokoroClient();
    if (!client.isLoaded()) await client.load();
    const out = await client.generate(text, profile.voiceId, readSpeed(profile));
    return { blob: out.blob, mime: "audio/wav" };
  }
  return generateTtsSpeech({ profileId: profile.id, text, speed: readSpeed(profile) });
}

// ── HTML-audio player singleton (lazy — DOM-free until first play) ──────────

let htmlPlayer: NarrationPlayer | null = null;

function htmlAudioPlayer(): NarrationPlayer {
  if (!htmlPlayer) htmlPlayer = createHtmlAudioNarrationPlayer();
  return htmlPlayer;
}

function writeNarrationState(messageId: string, state: NarrationState): void {
  useTtsPlaybackStore.setState((s) => ({ narrations: { ...s.narrations, [messageId]: state } }));
}

// ── Orchestrator lane (recreated only when test dep identities change) ──────

let orchestratorOverride: Orchestrator | null = null;
let playerOverride: NarrationPlayer | null = null;
let synthesizeOverride: SynthesizeFn | null = null;
let activeOrchestrator: Orchestrator | null = null;
let activePlayer: NarrationPlayer | null = null;
let activeSynthesize: SynthesizeFn | null = null;

function ensureOrchestrator(): Orchestrator {
  const player = playerOverride ?? htmlAudioPlayer();
  const synthesize = synthesizeOverride ?? defaultSynthesize;
  if (activeOrchestrator && activePlayer === player && activeSynthesize === synthesize) {
    return activeOrchestrator;
  }
  // Deps changed (test seam swap): stop the abandoned lane cleanly first.
  activeOrchestrator?.stop();
  activeOrchestrator = createTtsOrchestrator({ player, synthesize, onState: writeNarrationState });
  activePlayer = player;
  activeSynthesize = synthesize;
  return activeOrchestrator;
}

/** Test seam: replace orchestrator/player/synthesize. Pass null to restore defaults. */
export function __setTtsPlaybackDepsForTests(deps: {
  orchestrator?: Orchestrator | null;
  player?: NarrationPlayer | null;
  synthesize?: SynthesizeFn | null;
} | null): void {
  if (!deps) {
    orchestratorOverride = null;
    playerOverride = null;
    synthesizeOverride = null;
    return;
  }
  if ("orchestrator" in deps) orchestratorOverride = deps.orchestrator ?? null;
  if ("player" in deps) playerOverride = deps.player ?? null;
  if ("synthesize" in deps) synthesizeOverride = deps.synthesize ?? null;
}

export function __resetKokoroClientForTests(): void {
  kokoroClient = null;
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
