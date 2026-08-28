/**
 * TTS narration orchestrator — paragraph-serial generation + playback.
 * Pure, dependency-injected; no DOM or store imports.
 *
 * Pipeline: preprocess → splitParagraphs → sequential synthesize (one in
 * flight) pushing blobs into a FIFO, while a serial playback loop starts as
 * soon as the FIRST blob is ready (audio starts on paragraph 1 while later
 * paragraphs still generate — acceptance requirement). Generation is PACED
 * (TE2-14): it never runs more than GENERATION_LOOKAHEAD_CAP segments ahead
 * of playback and yields INTER_SYNTHESIS_YIELD_MS between syntheses — the
 * browser GPU is shared between WebGPU inference and page compositing, and
 * unpaced generation saturates it for the whole message (owner-visible UI
 * jank). First-audio latency is unaffected: the cap only bites once audio is
 * already playing. One narration lane: a new narrate() stops whatever was
 * active (epoch guard makes late synthesize resolves from the abandoned
 * epoch a no-op).
 */

import { splitParagraphs } from "./kokoro/kokoro-text.js";
import { chunkRoleRuns, splitNarrationRoles } from "./narration-text.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import type { NarrationPlayer } from "./narration-player.js";

/** TE2-14 GPU pacing: max synthesized-but-unplayed segments the generation
 *  loop may hold queued (one more may be actively playing). */
export const GENERATION_LOOKAHEAD_CAP = 3;
/** TE2-14 GPU pacing: pause between consecutive syntheses so the shared GPU
 *  gets compositor breathing room during the initial burst. */
export const INTER_SYNTHESIS_YIELD_MS = 60;

export type NarrationStatus = "generating" | "playing" | "paused" | "complete" | "error";

export interface NarrationState {
  status: NarrationStatus;
  total: number;
  played: number;
  error?: string;
}

export interface NarrationDeps {
  synthesize(text: string, profile: TtsProfileRecord, voiceId: string): Promise<{ blob: Blob; mime: string }>;
  player: NarrationPlayer;
  /** Pre-narration text transform — identity seam, TS-10 wires the real pipeline. */
  preprocess?(text: string): string;
  onState(messageId: string, state: NarrationState): void;
}

export function createTtsOrchestrator(deps: NarrationDeps): {
  narrate(messageId: string, text: string, profile: TtsProfileRecord): Promise<void>;
  pause(): void;
  resume(): void;
  skipSegment(): void;
  stop(): void;
  setRate(rate: number): void;
} {
  let epoch = 0;
  let activeMessageId: string | null = null;
  let currentRate = 1;
  let paused = false;
  /** Queue of blobs waiting to be played (FIFO). */
  let pendingBlobs: Blob[] = [];
  let generationDone = false;
  let totalSegments = 0;
  let playedCount = 0;
  let lastState: NarrationState | null = null;
  let playbackRunning = false;
  /** Resolved when the current playback loop exits, so narrate() can await
   *  completion without polling. Single slot: only one loop runs at a time. */
  let playbackSettled: (() => void) | null = null;
  /** Resolved when the playback queue shrinks / playback exits, so the paced
   *  generation loop can re-check the lookahead cap. Single slot: only one
   *  generation loop exists per orchestrator. */
  let generationQueueDrained: (() => void) | null = null;

  function wakeGeneration(): void {
    const wake = generationQueueDrained;
    generationQueueDrained = null;
    wake?.();
  }

  function emitState(status: NarrationStatus, error?: string): void {
    if (!activeMessageId) return;
    const state: NarrationState = {
      status,
      total: totalSegments,
      played: playedCount,
      ...(error !== undefined ? { error } : {}),
    };
    lastState = state;
    deps.onState(activeMessageId, state);
  }

  /** Mark the playback loop as exited and wake whoever awaits its completion.
   *  Called only from the loop itself (its epoch is still the ruling one —
   *  stop()/reset paths clear the flag on their own before the loop unwinds). */
  function settlePlayback(): void {
    playbackRunning = false;
    const settle = playbackSettled;
    playbackSettled = null;
    settle?.();
    // Playback exited — the paced generation loop must re-check its wait.
    wakeGeneration();
  }

  /** Wake the waiter WITHOUT touching the running flag — used when the loop
   *  returns due to an epoch change: stop()/narrate() already reset the flag,
   *  and a NEW loop may already be running under the new epoch. */
  function wakeStaleWaiter(): void {
    const settle = playbackSettled;
    playbackSettled = null;
    settle?.();
    wakeGeneration();
  }

  async function runPlayback(myEpoch: number): Promise<void> {
    if (playbackRunning) return;
    playbackRunning = true;
    while (myEpoch === epoch) {
      if (paused) {
        // Parked between segments while paused; resume() re-kicks.
        settlePlayback();
        return;
      }
      const blob = pendingBlobs.shift();
      if (!blob) {
        if (generationDone) {
          emitState("complete");
          settlePlayback();
          return;
        }
        // Generation still owes blobs; its enqueue re-kicks playback.
        settlePlayback();
        return;
      }
      // The queue just shrank — paced generation may resume (TE2-14).
      wakeGeneration();
      emitState("playing");
      const result = await deps.player.play(blob, currentRate);
      if (myEpoch !== epoch) {
        wakeStaleWaiter();
        return;
      }
      if (result === "error") {
        pendingBlobs = [];
        generationDone = true;
        emitState("error", "Playback failed");
        settlePlayback();
        return;
      }
      // "ended" | "skipped" — both advance the queue position.
      playedCount += 1;
      if (pendingBlobs.length === 0 && generationDone) {
        emitState("complete");
        settlePlayback();
        return;
      }
    }
    wakeStaleWaiter();
  }

  function abortActiveNarration(): void {
    // Stop any in-flight playback and clear the queue.
    deps.player.skipCurrent();
    pendingBlobs = [];
    generationDone = false;
    playbackRunning = false;
    paused = false;
    playedCount = 0;
    totalSegments = 0;
    lastState = null;
    // A previous generation loop may be parked on the lookahead cap — wake it
    // so its epoch check can retire it (otherwise narrate() would leak a
    // pending promise).
    wakeGeneration();
  }

  return {
    async narrate(messageId: string, text: string, profile: TtsProfileRecord): Promise<void> {
      epoch += 1;
      const myEpoch = epoch;
      abortActiveNarration();
      activeMessageId = messageId;

      const raw = deps.preprocess ? deps.preprocess(text) : text;
      const hasNarrator = typeof profile.narratorVoiceId === "string" && profile.narratorVoiceId.trim() !== "";
      const segments: Array<{ text: string; voiceId: string }> = hasNarrator
        ? chunkRoleRuns(splitNarrationRoles(raw), 400).map((run) => ({
            text: run.text,
            voiceId: run.role === "narrator" ? (profile.narratorVoiceId as string) : profile.voiceId,
          }))
        : splitParagraphs(raw).map((paragraph) => ({ text: paragraph, voiceId: profile.voiceId }));

      if (segments.length === 0) {
        emitState("complete");
        return;
      }

      totalSegments = segments.length;
      playedCount = 0;
      generationDone = false;
      pendingBlobs = [];
      emitState("generating");

      // Generation loop: synthesize sequentially, enqueue, kick playback on
      // first blob so it overlaps with the remaining synthesis. TE2-14: wait
      // while the lookahead queue is full (generationDone is set by the
      // error/stop paths — checked here so we never synthesize into a dead
      // narration), and yield between syntheses to pace the shared GPU.
      const genPromise = (async () => {
        for (const segment of segments) {
          while (
            myEpoch === epoch &&
            !generationDone &&
            pendingBlobs.length >= GENERATION_LOOKAHEAD_CAP
          ) {
            await new Promise<void>((resolve) => {
              generationQueueDrained = resolve;
            });
          }
          if (myEpoch !== epoch || generationDone) return;
          try {
            const result = await deps.synthesize(segment.text, profile, segment.voiceId);
            if (myEpoch !== epoch) return;
            pendingBlobs.push(result.blob);
            if (!playbackRunning && !paused) {
              void runPlayback(myEpoch);
            }
            // TE2-14: breathe between syntheses. First audio was already
            // kicked above, so this yield is inaudible to the listener.
            await new Promise<void>((resolve) => setTimeout(resolve, INTER_SYNTHESIS_YIELD_MS));
          } catch (error) {
            if (myEpoch !== epoch) return;
            const message = error instanceof Error ? error.message : String(error);
            generationDone = true;
            pendingBlobs = [];
            deps.player.skipCurrent();
            emitState("error", message);
            return;
          }
        }
        generationDone = true;
        if (!playbackRunning && !paused && pendingBlobs.length > 0) {
          void runPlayback(myEpoch);
        }
      })();

      await genPromise;
      if (myEpoch !== epoch) return;
      if (paused) return;

      if (playbackRunning) {
        // Playback is draining (parked inside player.play or between
        // segments); await its exit via the settle callback — no polling.
        await new Promise<void>((resolve) => {
          playbackSettled = resolve;
        });
        if (myEpoch !== epoch) return;
        if (paused) return;
        // Parked between segments after a pause/resume race — re-kick.
        if (!playbackRunning && pendingBlobs.length > 0) {
          await runPlayback(myEpoch);
        }
      }
      if (!playbackRunning && pendingBlobs.length === 0 && generationDone) {
        // Everything already played (or nothing was playable); ensure the
        // terminal state is emitted exactly once.
        if (lastState?.status !== "complete" && lastState?.status !== "error") {
          emitState("complete");
        }
      }
    },

    pause(): void {
      if (paused) return;
      paused = true;
      deps.player.pause();
      if (activeMessageId) emitState("paused");
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      deps.player.resume();
      if (activeMessageId) emitState("playing");
      if (!playbackRunning && (pendingBlobs.length > 0 || !generationDone)) {
        void runPlayback(epoch);
      } else if (!playbackRunning && pendingBlobs.length === 0 && generationDone) {
        if (lastState?.status !== "complete") emitState("complete");
      }
    },

    skipSegment(): void {
      // Advance the current segment only; the playback loop consumes the
      // "skipped" result and moves to the next queued segment.
      deps.player.skipCurrent();
    },

    stop(): void {
      epoch += 1;
      pendingBlobs = [];
      generationDone = true;
      playbackRunning = false;
      paused = false;
      deps.player.skipCurrent();
      wakeStaleWaiter();
      if (activeMessageId) emitState("complete");
    },

    setRate(rate: number): void {
      currentRate = rate;
      deps.player.setRate(rate);
    },
  };
}
