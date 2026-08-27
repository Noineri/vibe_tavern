/**
 * TTS narration orchestrator — paragraph-serial generation + playback.
 * Pure, dependency-injected; no DOM or store imports.
 *
 * Pipeline: preprocess → splitParagraphs → sequential synthesize (one in
 * flight) pushing blobs into a FIFO, while a serial playback loop starts as
 * soon as the FIRST blob is ready (audio starts on paragraph 1 while later
 * paragraphs still generate — acceptance requirement). One narration lane:
 * a new narrate() stops whatever was active (epoch guard makes late synthesize
 * resolves from the abandoned epoch a no-op).
 */

import { splitParagraphs } from "./kokoro/kokoro-text.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import type { NarrationPlayer } from "./narration-player.js";

export type NarrationStatus = "generating" | "playing" | "paused" | "complete" | "error";

export interface NarrationState {
  status: NarrationStatus;
  total: number;
  played: number;
  error?: string;
}

export interface NarrationDeps {
  synthesize(text: string, profile: TtsProfileRecord): Promise<{ blob: Blob; mime: string }>;
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
  }

  /** Wake the waiter WITHOUT touching the running flag — used when the loop
   *  returns due to an epoch change: stop()/narrate() already reset the flag,
   *  and a NEW loop may already be running under the new epoch. */
  function wakeStaleWaiter(): void {
    const settle = playbackSettled;
    playbackSettled = null;
    settle?.();
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
  }

  return {
    async narrate(messageId: string, text: string, profile: TtsProfileRecord): Promise<void> {
      epoch += 1;
      const myEpoch = epoch;
      abortActiveNarration();
      activeMessageId = messageId;

      const raw = deps.preprocess ? deps.preprocess(text) : text;
      const paragraphs = splitParagraphs(raw);

      if (paragraphs.length === 0) {
        emitState("complete");
        return;
      }

      totalSegments = paragraphs.length;
      playedCount = 0;
      generationDone = false;
      pendingBlobs = [];
      emitState("generating");

      // Generation loop: synthesize sequentially, enqueue, kick playback on
      // first blob so it overlaps with the remaining synthesis.
      const genPromise = (async () => {
        for (const paragraph of paragraphs) {
          if (myEpoch !== epoch) return;
          try {
            const result = await deps.synthesize(paragraph, profile);
            if (myEpoch !== epoch) return;
            pendingBlobs.push(result.blob);
            if (!playbackRunning && !paused) {
              void runPlayback(myEpoch);
            }
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
