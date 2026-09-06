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
import { mapTtsTagsForDialect, ttsTagDialectForProfile } from "./tts-tags.js";
import { buildNarrationCacheKey, type NarrationSegmentCache } from "./narration-cache.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import type { NarrationPlayer } from "./narration-player.js";

/** TE2-14 GPU pacing: max synthesized-but-unplayed segments the generation
 *  loop may hold queued (one more may be actively playing). */
export const GENERATION_LOOKAHEAD_CAP = 3;
/** TE2-14 GPU pacing: pause between consecutive syntheses so the shared GPU
 *  gets compositor breathing room during the initial burst. */
export const INTER_SYNTHESIS_YIELD_MS = 60;
/** TPE-16: one retry per failed segment after this backoff — a single
 *  transient failure (hiccup, abort race) must not kill a narration. */
export const SYNTHESIZE_RETRY_DELAY_MS = 500;

export type NarrationStatus = "generating" | "playing" | "paused" | "complete" | "error";

export interface NarrationState {
  status: NarrationStatus;
  total: number;
  played: number;
  error?: string;
}

export interface SynthesizeOptions {
  /** TPE-16: stop() aborts the in-flight synthesize through this signal —
   *  honest cancellation instead of a blind timeout. */
  signal?: AbortSignal;
}

/** TPE-18a: completion report for one successful narration — the segment
 *  cache keys that back it (replay = cache hits) plus the segment count.
 *  Fired exactly once per genuinely completed narrate(); stop() and error
 *  paths never report. */
export interface NarratedReport {
  cacheKeys: string[];
  segments: number;
}

export interface NarrationDeps {
  synthesize(
    text: string,
    profile: TtsProfileRecord,
    voiceId: string,
    options?: SynthesizeOptions,
  ): Promise<{ blob: Blob; mime: string }>;
  player: NarrationPlayer;
  /** Pre-narration text transform — identity seam, TS-10 wires the real pipeline. */
  preprocess?(text: string): string;
  onState(messageId: string, state: NarrationState): void;
  /** TPE-18a: fired once when a narrate() genuinely completes (all
   *  segments generated and played, no failure). Optional so pure unit
   *  tests can omit it; the store wires the playlist index here. */
  onNarrated?(messageId: string, report: NarratedReport): void;
  /** TPE-16: segment blob cache (resume without re-generation). Optional
   *  so pure unit tests can omit it; the store always wires the shared one. */
  cache?: NarrationSegmentCache;
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
  /** Queue of blobs waiting to be played (FIFO). Each entry carries its
   *  cache key so a blob that fails playback can be evicted (an
   *  undecodable cached blob must not poison every retry forever). */
  let pendingBlobs: Array<{ blob: Blob; cacheKey: string | null }> = [];
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
  /** TPE-16: abort handle for the in-flight synthesize of the ruling epoch.
   *  stop()/new-narrate abort it; the generation loop treats the resulting
   *  rejection as a clean retire, never an error. */
  let synthesisController: AbortController | null = null;
  /** TPE-16: hard-failure message of the ruling epoch. Set on the second
   *  consecutive synthesize failure; already-generated segments stay queued
   *  (resume serves them from the cache) and the terminal state is the
   *  error — never a silent return to idle. */
  let failedMessage: string | null = null;

  /** TPE-18a: segment cache keys of the ruling epoch (cache hits AND
   *  fresh syntheses) — reported once via onNarrated when the narration
   *  genuinely completes, so the playlist index can point at them. */
  let epochKeys: string[] = [];
  /** TPE-18a: the report fired at most once per epoch (completion can be
   *  reached via runPlayback, the narrate tail, or resume — exactly one
   *  of them reports). */
  let epochReported = false;

  function isAbortError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name: unknown }).name === "AbortError"
    );
  }

  function abortError(): Error {
    if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  }

  /** Backoff sleep that an abort cuts short — a stop during the retry wait
   *  retires immediately instead of firing a doomed second attempt. */
  function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      function cleanup(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      function onAbort(): void {
        cleanup();
        reject(abortError());
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

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

  /** TPE-18a: report a genuine completion exactly once per epoch. Only
   *  the success paths call this — stop() emits "complete" directly
   *  (it must NOT index an aborted lane) and error paths never do. */
  function reportNarrated(): void {
    if (!activeMessageId || epochReported) return;
    if (failedMessage !== null || pendingBlobs.length !== 0 || !generationDone) return;
    epochReported = true;
    deps.onNarrated?.(activeMessageId, { cacheKeys: [...epochKeys], segments: totalSegments });
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
      const item = pendingBlobs.shift();
      if (!item) {
        if (generationDone) {
          // TPE-16: a hard failure mid-queue drains the good segments
          // first — the terminal state stays the error, never complete.
          if (failedMessage !== null) emitState("error", failedMessage);
          else {
            emitState("complete");
            reportNarrated();
          }
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
      const result = await deps.player.play(item.blob, currentRate);
      if (myEpoch !== epoch) {
        wakeStaleWaiter();
        return;
      }
      if (result === "error") {
        // TPE-16: evict the undecodable blob so a poisoned cache entry
        // cannot fail every retry forever (v1 has no other eviction).
        // Best-effort: eviction failure never masks the playback error.
        if (item.cacheKey !== null && deps.cache) {
          try {
            await deps.cache.delete(item.cacheKey);
          } catch {
            // Best-effort cache: a storage failure is not a narration failure.
          }
        }
        pendingBlobs = [];
        generationDone = true;
        emitState("error", "Playback failed");
        settlePlayback();
        return;
      }
      // "ended" | "skipped" — both advance the queue position.
      playedCount += 1;
      if (pendingBlobs.length === 0 && generationDone) {
        // TPE-16: see above — drain-then-error on hard failure.
        if (failedMessage !== null) emitState("error", failedMessage);
        else {
          emitState("complete");
          reportNarrated();
        }
        settlePlayback();
        return;
      }
      // TPE-18a: surface per-segment progress — the playlist live row
      // reads played/total as its n/total fetch indicator. Same status,
      // new count; terminal branches above stay the only completions.
      emitState("playing");
    }
    wakeStaleWaiter();
  }

  function abortActiveNarration(): void {
    // Stop any in-flight playback and clear the queue.
    deps.player.skipCurrent();
    // TPE-16: cancel the in-flight synthesize — the lane dies here, not
    // at whatever the upstream would eventually return.
    synthesisController?.abort();
    synthesisController = null;
    pendingBlobs = [];
    generationDone = false;
    failedMessage = null;
    // TPE-18a: a retired epoch must never report (its keys are stale).
    epochKeys = [];
    epochReported = true;
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
      // TPE-1: annotation tags are canonical `[tag]` tokens; the synthesis
      // engine's dialect decides their fate. Mapping happens HERE — the single
      // point where the narration profile (backend + model) is known — before
      // any splitting, so every segment carries the mapped form. Strip
      // dialects never speak a tag word aloud; orpheus gets <tag> inline tags;
      // chatterbox speaks the canonical brackets natively.
      const dialectText = mapTtsTagsForDialect(raw, ttsTagDialectForProfile(profile));
      const hasNarrator = typeof profile.narratorVoiceId === "string" && profile.narratorVoiceId.trim() !== "";
      const segments: Array<{ text: string; voiceId: string }> = hasNarrator
        ? chunkRoleRuns(splitNarrationRoles(dialectText), 400).map((run) => ({
            text: run.text,
            voiceId: run.role === "narrator" ? (profile.narratorVoiceId as string) : profile.voiceId,
          }))
        : splitParagraphs(dialectText).map((paragraph) => ({ text: paragraph, voiceId: profile.voiceId }));

      if (segments.length === 0) {
        emitState("complete");
        return;
      }

      totalSegments = segments.length;
      playedCount = 0;
      generationDone = false;
      failedMessage = null;
      pendingBlobs = [];
      epochKeys = [];
      epochReported = false;
      synthesisController = new AbortController();
      const synthesisSignal = synthesisController.signal;
      // TPE-16: wait-for-full-generation profile flag — progressive
      // playback starts on the first blob by default; heavy models opt
      // into synthesizing everything before the first sound (gapless
      // audio at the cost of a later start). Backend-agnostic: any
      // profile can be slow, so the flag lives in the common config.
      const waitForFullGeneration = profile.config["waitForFullGeneration"] === true;
      const config = profile.config;
      const configString = (value: unknown): string | null => (typeof value === "string" ? value : null);
      const speedRaw = config["speed"];
      const synthesisSpeed = typeof speedRaw === "number" && Number.isFinite(speedRaw) ? speedRaw : null;
      const cacheBase = {
        backend: profile.backend,
        endpoint: configString(config["endpoint"]) ?? configString(config["baseUrl"]),
        model: configString(config["model"]) ?? configString(config["modelId"]),
        responseFormat: configString(config["responseFormat"]),
        speed: synthesisSpeed,
        narrator: hasNarrator,
      };
      emitState("generating");

      function kickPlayback(): void {
        if (!waitForFullGeneration && !playbackRunning && !paused) {
          void runPlayback(myEpoch);
        }
      }

      async function cachedOrSynthesize(segment: { text: string; voiceId: string }): Promise<boolean> {
        const key = buildNarrationCacheKey({ ...cacheBase, voiceId: segment.voiceId, text: segment.text });
        if (deps.cache) {
          let cached: Blob | null = null;
          try {
            cached = await deps.cache.get(key);
          } catch {
            // Best-effort cache: storage failure degrades to synthesis.
            cached = null;
          }
          if (cached) {
            if (myEpoch !== epoch || generationDone) return false;
            pendingBlobs.push({ blob: cached, cacheKey: key });
            epochKeys.push(key);
            kickPlayback();
            return true;
          }
        }
        // One retry after a short backoff: a single transient failure
        // must not kill the narration (the TPE-16 drop).
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (myEpoch !== epoch || generationDone) return false;
          try {
            const result = await deps.synthesize(segment.text, profile, segment.voiceId, { signal: synthesisSignal });
            if (myEpoch !== epoch) return false;
            if (deps.cache) {
              try {
                await deps.cache.put(key, result.blob, result.mime);
              } catch {
                // Best-effort cache: a failed write never fails the narration.
              }
            }
            if (myEpoch !== epoch || generationDone) return false;
            pendingBlobs.push({ blob: result.blob, cacheKey: key });
            epochKeys.push(key);
            kickPlayback();
            return true;
          } catch (error) {
            // Abort/stale-epoch/retired lane: clean retire, never an error.
            if (myEpoch !== epoch || generationDone || isAbortError(error) || synthesisSignal.aborted) return false;
            if (attempt === 0) {
              try {
                await sleepOrAbort(SYNTHESIZE_RETRY_DELAY_MS, synthesisSignal);
              } catch {
                return false;
              }
              continue;
            }
            // Hard failure (second consecutive): keep everything already
            // generated — resume serves it from the cache — stop past
            // this segment, and surface the error (never silent).
            generationDone = true;
            failedMessage = error instanceof Error ? error.message : String(error);
            if (!playbackRunning && (pendingBlobs.length === 0 || paused)) {
              emitState("error", failedMessage);
            } else if (!playbackRunning) {
              // Good segments are queued but playback never started:
              // drain them first; the loop ends in the error state.
              void runPlayback(myEpoch);
            }
            // Active playback keeps draining the good queue; its terminal
            // branch emits the error. Never skipCurrent here — the
            // currently playing segment is innocent.
            return false;
          }
        }
        return false;
      }

      // Generation loop: per-segment cache-or-synthesize, enqueue, and
      // (progressive mode) kick playback on the first blob so it overlaps
      // with the remaining synthesis. TE2-14: wait while the lookahead
      // queue is full — EXCEPT in wait-for-full-generation mode, where
      // playback is deferred and the queue must be allowed to grow (the
      // yield still paces the shared GPU; only the queue ceiling lifts,
      // otherwise >CAP+1 segments would deadlock against a drain that
      // never starts). generationDone is set by the error/stop paths —
      // checked everywhere so we never synthesize into a dead narration.
      const genPromise = (async () => {
        for (const segment of segments) {
          while (
            !waitForFullGeneration &&
            myEpoch === epoch &&
            !generationDone &&
            pendingBlobs.length >= GENERATION_LOOKAHEAD_CAP
          ) {
            await new Promise<void>((resolve) => {
              generationQueueDrained = resolve;
            });
          }
          if (myEpoch !== epoch || generationDone) return;
          const advanced = await cachedOrSynthesize(segment);
          if (!advanced) return;
          // TE2-14: breathe between syntheses. In progressive mode the
          // first audio was already kicked above, so this yield is
          // inaudible; in wait-full mode it paces the whole batch.
          await new Promise<void>((resolve) => setTimeout(resolve, INTER_SYNTHESIS_YIELD_MS));
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
          reportNarrated();
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
        // TPE-16: a failed narration stays failed — resume must never flip
        // an error into a completion.
        if (lastState?.status !== "complete" && lastState?.status !== "error") {
          emitState("complete");
          // TPE-18a: playback finished while parked on pause — genuine.
          reportNarrated();
        }
      }
    },

    skipSegment(): void {
      // Advance the current segment only; the playback loop consumes the
      // "skipped" result and moves to the next queued segment.
      deps.player.skipCurrent();
    },

    stop(): void {
      epoch += 1;
      // TPE-16: honest cancellation — the in-flight synthesize fetch dies
      // here, not at whatever the upstream would eventually return. Its
      // rejection retires on the stale epoch, so no error is ever emitted.
      synthesisController?.abort();
      synthesisController = null;
      failedMessage = null;
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
