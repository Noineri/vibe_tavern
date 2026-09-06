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
 *
 * TPE-18b: the generation loop is cursor-driven (fillCursor) so a seek can
 * retarget it mid-flight — the loop adopts the new cursor instead of a
 * second loop starting (single fill owner, no enqueue races). The playback
 * queue carries per-entry segment indexes + start offsets, durations fill
 * in via background probes, and progress (position/total) flows out through
 * the optional onProgress callback for the playlist seek bar.
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
  /** TPE-21: segments RECEIVED from the provider (synthesized or cache-
   * hit), independent of playback. With waitForFullGeneration the playback
   * loop is held until the batch completes, so `played` stays 0 for the
   * whole synthesis — this counter is what progress UI must show. */
  received: number;
  error?: string;
}

export interface SynthesizeOptions {
  /** TPE-16: stop() aborts the in-flight synthesize through this signal —
   *  honest cancellation instead of a blind timeout. */
  signal?: AbortSignal;
}

/** TPE-18b: live playback progress for the playlist seek bar. Position is
 *  best-effort while durations are still loading (unknown earlier segments
 *  count as 0); total is null until EVERY segment duration is known — the
 *  bar renders unknown segments as fixed slivers instead of estimates. */
export interface NarrationProgress {
  positionSec: number;
  totalSec: number | null;
  currentIndex: number;
  segmentCount: number;
  durations: Array<number | null>;
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
  /** TPE-18b: progress snapshots (position/total/durations) for the seek
   *  bar — fired on segment starts, time updates, duration learns, seeks.
   *  Optional like onNarrated; the store wires playlist progress here. */
  onProgress?(messageId: string, progress: NarrationProgress): void;
  /** TPE-18a: fired once when a narrate() genuinely completes (all
   *  segments generated and played, no failure). Optional so pure unit
   *  tests can omit it; the store wires the playlist index here. */
  onNarrated?(messageId: string, report: NarratedReport): void;
  /** TPE-16: segment blob cache (resume without re-generation). Optional
   *  so pure unit tests can omit it; the store always wires the shared one. */
  cache?: NarrationSegmentCache;
}

/** TPE-18b: per-narrate lane inputs the fill loop and seek share. Reset by
 *  every narrate(); seek only moves the cursor inside them. */
interface LaneCacheBase {
  backend: string;
  endpoint: string | null;
  model: string | null;
  responseFormat: string | null;
  speed: number | null;
  narrator: boolean;
}

export function createTtsOrchestrator(deps: NarrationDeps): {
  narrate(messageId: string, text: string, profile: TtsProfileRecord): Promise<void>;
  /** TPE-18c: replay a saved library file (single-file timeline, zero synthesis). */
  playLibrary(messageId: string, blob: Blob): Promise<void>;
  pause(): void;
  resume(): void;
  skipSegment(): void;
  /** TPE-18b: jump to a cumulative position (seconds) — maps to
   *  (segment, offset) over the known durations and rebuilds the queue.
   *  No-op unless the lane is generating/playing/paused. */
  seekTo(positionSec: number): void;
  /** TPE-18b: forward the store-level volume to the player. */
  setVolume(volume: number): void;
  stop(): void;
  setRate(rate: number): void;
} {
  let epoch = 0;
  let activeMessageId: string | null = null;
  let currentRate = 1;
  let paused = false;
  /** Queue of blobs waiting to be played (FIFO). Each entry carries its
   *  cache key so a blob that fails playback can be evicted (an
   *  undecodable cached blob must not poison every retry forever), its
   *  segment index (TPE-18b seek mapping), and its start offset (TPE-18b
   *  seek landings inside a segment). */
  let pendingBlobs: Array<{ blob: Blob; cacheKey: string | null; index: number; startAt: number }> = [];
  let generationDone = false;
  let totalSegments = 0;
  let playedCount = 0;
  // TPE-21: received-from-provider counter (see NarrationState.received).
  // Advances in the fill loop; survives seek retargets (unlike playedCount,
  // which a seek presets); resets only with the lane.
  let receivedCount = 0;
  /** TPE-18b: index of the segment currently loaded in the player (set at
   *  shift time — playedCount keeps counting COMPLETED segments exactly
   *  as before, so TPE-16/18a pins are untouched). */
  let currentIndex = 0;
  /** TPE-18b: live clock inside the current segment (timeupdate + seeks). */
  let livePosition = 0;
  let lastState: NarrationState | null = null;
  let playbackRunning = false;
  /** Resolved when the current playback loop exits, so narrate() can await
   *  completion without polling. Single slot: only one loop runs at a time. */
  let playbackSettled: (() => void) | null = null;
  /** Resolved when the fill loop exits, so narrate() can await synthesis
   *  without polling. Single slot: only one fill loop runs at a time. */
  let fillSettled: (() => void) | null = null;
  /** Resolved when the playback queue shrinks / playback exits, so the paced
   *  fill loop can re-check the lookahead cap. Single slot: only one
   *  fill loop exists per orchestrator. */
  let generationQueueDrained: (() => void) | null = null;
  /** TPE-16: abort handle for the in-flight synthesize of the ruling epoch.
   *  stop()/new-narrate abort it; the fill loop treats the resulting
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
  /** TPE-18b: per-narrate lane inputs (segments + cache base + profile +
   *  flags) shared by the fill loop and seek. */
  let laneSegments: Array<{ text: string; voiceId: string }> = [];
  /** TPE-18c: the single library file when the lane replays a saved
   *  recording instead of synthesizing (null on synth lanes). Seek loads
   *  serve it directly; retarget keeps forward completion closed. */
  let laneLibraryBlob: Blob | null = null;
  let laneCacheBase: LaneCacheBase = { backend: "", endpoint: null, model: null, responseFormat: null, speed: null, narrator: false };
  let laneProfile: TtsProfileRecord | null = null;
  let laneWaitForFull = false;
  /** TPE-18b: next segment index the fill loop will process. Seek moves it;
   *  the loop re-reads it every iteration (single fill owner — no races). */
  let fillCursor = 0;
  /** TPE-18b: bumped by every seek; an in-flight fill iteration that
   *  notices the mismatch ADOPTS the new cursor (drops its stale result,
   *  continues) instead of a second loop starting. */
  let fillToken = 0;
  /** TPE-18b: exactly one fill loop per epoch (narrate starts it; seek
   *  never starts a second one — the running loop adopts). */
  let fillActive = false;
  /** TPE-18b: per-segment durations (null = unknown yet); reset per narrate. */
  let durations: Array<number | null> = [];
  /** TPE-18b: a seek target is loading — the empty-queue branches must not
   *  mistake the momentary gap for completion. */
  let seekPending = false;
  /** TPE-18b: the next loop continuation was seek-induced — it must not
   *  count the abandoned segment as played (retarget presets playedCount). */
  let suppressAdvanceCount = false;

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
      received: receivedCount,
      ...(error !== undefined ? { error } : {}),
    };
    lastState = state;
    deps.onState(activeMessageId, state);
  }

  /** TPE-18b: progress snapshot for the seek bar (position best-effort,
   *  total null until every duration is known). */
  function emitProgress(): void {
    if (!activeMessageId) return;
    let position = livePosition;
    let total = 0;
    let allKnown = laneSegments.length > 0;
    for (let i = 0; i < laneSegments.length; i += 1) {
      const d = durations[i] ?? null;
      if (i < currentIndex) position += d ?? 0;
      if (d === null) allKnown = false;
      else total += d;
    }
    deps.onProgress?.(activeMessageId, {
      positionSec: position,
      totalSec: allKnown ? total : null,
      currentIndex,
      segmentCount: laneSegments.length,
      durations: [...durations],
    });
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
    // Playback exited — the paced fill loop must re-check its wait.
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

  /** Wake a stale narrate-tail fill waiter (stop()/new narrate retired it). */
  function wakeStaleFillWaiter(): void {
    fillWaiterEpoch = -1;
    const settle = fillSettled;
    fillSettled = null;
    settle?.();
  }

  function kickPlayback(myEpoch: number): void {
    if (myEpoch !== epoch) return;
    if (!laneWaitForFull && !playbackRunning && !paused) {
      void runPlayback(myEpoch);
    }
  }

  /** Epoch the pending fill waiter belongs to (-1 = none). Guards the
   *  single fillSettled slot against a retired loop settling its
   *  successor's narrate tail early. */
  let fillWaiterEpoch = -1;

  function ensureFill(myEpoch: number): void {
    if (fillActive) return;
    fillActive = true;
    const epochAtStart = myEpoch;
    void runFill(myEpoch, fillToken).finally(() => {
      // Only the ruling epoch owns the flag and the waiter — a retired
      // loop must not clear its successor's flag or settle its tail
      // (narrate always bumps the epoch, so same-epoch loops are always
      // the same lane).
      if (epochAtStart !== epoch) return;
      fillActive = false;
      if (fillWaiterEpoch === epoch) {
        fillWaiterEpoch = -1;
        const settle = fillSettled;
        fillSettled = null;
        settle?.();
      }
    });
  }

  /** TPE-18b: background duration probe for one enqueued blob — refines the
   *  seek bar as metadata arrives. Unknown stays unknown (sliver). */
  function probeSegment(index: number, blob: Blob): void {
    const probe = deps.player.probeDuration;
    if (!probe) return;
    const myEpoch = epoch;
    probe.call(deps.player, blob).then(
      (d) => {
        if (myEpoch !== epoch || index >= durations.length) return;
        if (typeof d === "number" && Number.isFinite(d) && d > 0) {
          durations[index] = d;
          emitProgress();
        }
      },
      () => {
        // Unknown stays unknown — the bar keeps the sliver.
      },
    );
  }

  function keyForSegment(index: number): string {
    const segment = laneSegments[index];
    return buildNarrationCacheKey({
      backend: laneCacheBase.backend,
      endpoint: laneCacheBase.endpoint,
      model: laneCacheBase.model,
      responseFormat: laneCacheBase.responseFormat,
      speed: laneCacheBase.speed,
      narrator: laneCacheBase.narrator,
      voiceId: segment.voiceId,
      text: segment.text,
    });
  }

  /** TPE-16 cache-or-synthesize for ONE segment (retry-once discipline
   *  preserved verbatim) — returns the blob WITHOUT enqueueing, so both
   *  the fill loop and seek can share it. A seek load (forSeek) bypasses
   *  the generationDone retire checks: done means "stop synthesizing
   *  forward", but a targeted seek load is not forward synthesis (the
   *  fill already finished — without the bypass every post-fill seek
   *  would wedge the lane). Epoch checks always apply. */
  async function loadSegmentBlob(
    index: number,
    myEpoch: number,
    forSeek = false,
  ): Promise<{ blob: Blob; key: string | null } | null> {
    // TPE-18c: library lanes serve the saved file (no cache, no synth —
    // the file IS the audio). forSeek bypasses the generationDone retire
    // checks like any targeted seek load; the epoch check always applies.
    if (laneLibraryBlob !== null && index === 0) {
      if (myEpoch !== epoch) return null;
      return { blob: laneLibraryBlob, key: null };
    }
    const segment = laneSegments[index];
    const profile = laneProfile;
    if (!segment || !profile) return null;
    const signal = synthesisController?.signal;
    const key = keyForSegment(index);
    if (deps.cache) {
      let cached: Blob | null = null;
      try {
        cached = await deps.cache.get(key);
      } catch {
        // Best-effort cache: storage failure degrades to synthesis.
        cached = null;
      }
      if (cached) {
        if (myEpoch !== epoch || (!forSeek && generationDone)) return null;
        epochKeys.push(key);
        return { blob: cached, key };
      }
    }
    // One retry after a short backoff: a single transient failure
    // must not kill the narration (the TPE-16 drop).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (myEpoch !== epoch || (!forSeek && generationDone)) return null;
      try {
        const result = await deps.synthesize(segment.text, profile, segment.voiceId, { signal });
        if (myEpoch !== epoch) return null;
        if (deps.cache) {
          try {
            await deps.cache.put(key, result.blob, result.mime);
          } catch {
            // Best-effort cache: a failed write never fails the narration.
          }
        }
        if (myEpoch !== epoch || (!forSeek && generationDone)) return null;
        epochKeys.push(key);
        return { blob: result.blob, key };
      } catch (error) {
        // Abort/stale-epoch/retired lane: clean retire, never an error.
        if (myEpoch !== epoch || generationDone || isAbortError(error) || signal?.aborted === true) return null;
        if (attempt === 0) {
          try {
            await sleepOrAbort(SYNTHESIZE_RETRY_DELAY_MS, signal ?? undefined);
          } catch {
            return null;
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
        return null;
      }
    }
    return null;
  }

  /** TPE-18b cursor-driven fill loop (the old inline generation loop,
   *  extracted so seek can retarget it). Reads fillCursor every iteration
   *  and ADOPTS a seek-moved cursor (drops the stale result, continues)
   *  — one fill owner, no enqueue races. */
  async function runFill(myEpoch: number, myToken: number): Promise<void> {
    while (fillCursor < laneSegments.length) {
      if (myEpoch !== epoch) return;
      if (myToken !== fillToken) {
        myToken = fillToken;
        continue;
      }
      const i = fillCursor;
      while (
        !laneWaitForFull &&
        myEpoch === epoch &&
        myToken === fillToken &&
        !generationDone &&
        pendingBlobs.length >= GENERATION_LOOKAHEAD_CAP
      ) {
        await new Promise<void>((resolve) => {
          generationQueueDrained = resolve;
        });
      }
      if (myEpoch !== epoch) return;
      if (myToken !== fillToken) continue;
      if (generationDone) return;
      const loaded = await loadSegmentBlob(i, myEpoch);
      if (myEpoch !== epoch) return;
      if (myToken !== fillToken) continue;
      if (!loaded) return;
      pendingBlobs.push({ blob: loaded.blob, cacheKey: loaded.key, index: i, startAt: 0 });
      fillCursor = i + 1;
      // TPE-21: a segment landed — publish the honest fetch progress even
      // while playback is held (wait-full mode). The STATUS is derived from
      // the live lane (never claim "generating" while audio plays — seekTo's
      // same-segment branch and the store UI read the status machine).
      receivedCount += 1;
      emitState(playbackRunning ? "playing" : paused ? "paused" : "generating");
      probeSegment(i, loaded.blob);
      kickPlayback(myEpoch);
      // TE2-14: breathe between syntheses. In progressive mode the
      // first audio was already kicked above, so this yield is
      // inaudible; in wait-full mode it paces the whole batch.
      await new Promise<void>((resolve) => setTimeout(resolve, INTER_SYNTHESIS_YIELD_MS));
      if (myEpoch !== epoch) return;
      if (myToken !== fillToken) continue;
    }
    // A retired EPOCH touches nothing (a new lane owns the flags). A mere
    // token change (a seek landed while this loop drained) still closes
    // forward completion: cursor >= len means every index was processed,
    // so the fill has no more work for this epoch — the seek's own load
    // covers its target, and the seekPending guard shelters the gap.
    if (myEpoch !== epoch) return;
    generationDone = true;
    if (!playbackRunning && !paused && pendingBlobs.length > 0) {
      void runPlayback(myEpoch);
    }
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
          // TPE-18b: a seek target is still loading — the momentary gap
          // is not completion.
          if (seekPending) {
            settlePlayback();
            return;
          }
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
      currentIndex = item.index;
      livePosition = item.startAt;
      emitState("playing");
      emitProgress();
      const result = await deps.player.play(item.blob, currentRate, {
        ...(item.startAt > 0 ? { startAt: item.startAt } : {}),
        onTime: (pos) => {
          livePosition = pos;
          // Learn the duration from the live element when the player
          // reports one (fakes that stub durations skip this).
          const snap = deps.player.getPosition?.();
          if (snap?.duration !== null && snap?.duration !== undefined && currentIndex < durations.length) {
            if (durations[currentIndex] === null) durations[currentIndex] = snap.duration;
          }
          emitProgress();
        },
      });
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
      // TPE-18b: a seek-induced skip does not count the abandoned segment
      // (retarget presets playedCount); plain skips keep TPE-16 semantics.
      if (suppressAdvanceCount) suppressAdvanceCount = false;
      else playedCount += 1;
      if (pendingBlobs.length === 0 && generationDone) {
        // TPE-18b: seek target still loading — not completion (see above).
        if (seekPending) {
          settlePlayback();
          return;
        }
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
      emitProgress();
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
    // TPE-18b: retire the fill loop and the lane inputs with it.
    fillToken += 1;
    fillActive = false;
    fillCursor = 0;
    laneSegments = [];
    laneLibraryBlob = null;
    durations = [];
    seekPending = false;
    suppressAdvanceCount = false;
    livePosition = 0;
    currentIndex = 0;
    playbackRunning = false;
    paused = false;
    playedCount = 0;
    receivedCount = 0;
    totalSegments = 0;
    lastState = null;
    wakeStaleFillWaiter();
    // A previous fill loop may be parked on the lookahead cap — wake it
    // so its epoch check can retire it (otherwise narrate() would leak a
    // pending promise).
    wakeGeneration();
  }

  /** TPE-18b: rebuild the queue around one target segment (full retarget).
   *  The running fill loop adopts the moved cursor; the stale playback
   *  continuation reaps into the new queue (shift-time index assignment
   *  keeps currentIndex exact). */
  function retarget(index: number, offset: number): void {
    const myEpoch = epoch;
    fillToken += 1;
    fillCursor = index + 1;
    // The lane continues past the seek point — reopen forward completion
    // (a restarted/adopted fill must load ahead again; the terminal
    // branches re-decide). failedMessage is deliberately kept: a lane
    // draining toward an error still ends in the error after the refill.
    // TPE-18c: library lanes never reopen forward completion — the file
    // is whole; a seek just re-lands inside it (the seek's own load
    // covers the target via laneLibraryBlob above).
    if (laneLibraryBlob === null) generationDone = false;
    suppressAdvanceCount = true;
    deps.player.skipCurrent();
    pendingBlobs = [];
    playedCount = index;
    currentIndex = index;
    livePosition = offset;
    seekPending = true;
    // The parked fill loop (if any) waits on the cap — the cleared queue
    // unblocks it; its cursor check adopts the retarget.
    wakeGeneration();
    void (async () => {
      const myToken = fillToken;
      const loaded = await loadSegmentBlob(index, myEpoch, true);
      if (myEpoch !== epoch || myToken !== fillToken) return;
      seekPending = false;
      if (!loaded) {
        // The lane retired inside the load or the segment hard-failed
        // (the error path already surfaced it) — wake the narrate tail
        // parked on the gap instead of hanging it.
        wakeStaleWaiter();
        return;
      }
      pendingBlobs.unshift({ blob: loaded.blob, cacheKey: loaded.key, index, startAt: offset });
      probeSegment(index, loaded.blob);
      if (paused) {
        emitState("paused");
        emitProgress();
      } else {
        kickPlayback(myEpoch);
      }
      ensureFill(myEpoch);
    })();
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
      receivedCount = 0;
      currentIndex = 0;
      livePosition = 0;
      generationDone = false;
      failedMessage = null;
      pendingBlobs = [];
      epochKeys = [];
      epochReported = false;
      // TPE-18b: publish the lane inputs, then start the cursor fill.
      laneSegments = segments;
      durations = segments.map(() => null);
      laneProfile = profile;
      // TPE-16: wait-for-full-generation profile flag — progressive
      // playback starts on the first blob by default; heavy models opt
      // into synthesizing everything before the first sound (gapless
      // audio at the cost of a later start). Backend-agnostic: any
      // profile can be slow, so the flag lives in the common config.
      laneWaitForFull = profile.config["waitForFullGeneration"] === true;
      const config = profile.config;
      const configString = (value: unknown): string | null => (typeof value === "string" ? value : null);
      const speedRaw = config["speed"];
      const synthesisSpeed = typeof speedRaw === "number" && Number.isFinite(speedRaw) ? speedRaw : null;
      laneCacheBase = {
        backend: profile.backend,
        endpoint: configString(config["endpoint"]) ?? configString(config["baseUrl"]),
        model: configString(config["model"]) ?? configString(config["modelId"]),
        responseFormat: configString(config["responseFormat"]),
        speed: synthesisSpeed,
        narrator: hasNarrator,
      };
      fillCursor = 0;
      fillToken += 1;
      seekPending = false;
      suppressAdvanceCount = false;
      synthesisController = new AbortController();
      emitState("generating");
      emitProgress();
      ensureFill(myEpoch);

      await new Promise<void>((resolve) => {
        fillWaiterEpoch = myEpoch;
        fillSettled = resolve;
      });
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
      // TPE-18b: a seek may land while the tail is parked above — the
      // stale continuation wakes it over a momentary queue gap that is
      // not completion. Park until the landing settles instead of
      // emitting a spurious complete→playing churn.
      while (seekPending && !paused && myEpoch === epoch) {
        await new Promise<void>((resolve) => {
          playbackSettled = resolve;
        });
      }
      if (myEpoch !== epoch) return;
      if (paused) return;
      if (!playbackRunning && pendingBlobs.length === 0 && generationDone) {
        // Everything already played (or nothing was playable); ensure the
        // terminal state is emitted exactly once.
        if (lastState?.status !== "complete" && lastState?.status !== "error") {
          emitState("complete");
          reportNarrated();
        }
      }
    },

    /** TPE-18c: replay a saved library file — the single-file timeline
     *  (one-segment queue; the existing SeekBar rides durations/progress
     *  unchanged). Zero synthesis: the fill loop never starts (cursor is
     *  parked past the only segment), the cache is untouched, and the
     *  completion is never re-indexed (epochReported stays true — the row
     *  already exists). Pause/resume/seek/stop ride the normal lane. */
    async playLibrary(messageId: string, blob: Blob): Promise<void> {
      epoch += 1;
      const myEpoch = epoch;
      abortActiveNarration();
      activeMessageId = messageId;

      laneSegments = [{ text: "", voiceId: "" }];
      laneLibraryBlob = blob;
      durations = [null];
      laneProfile = null;
      laneWaitForFull = false;
      totalSegments = 1;
      playedCount = 0;
      receivedCount = 1;
      currentIndex = 0;
      livePosition = 0;
      generationDone = true;
      failedMessage = null;
      pendingBlobs = [{ blob, cacheKey: null, index: 0, startAt: 0 }];
      epochKeys = [];
      epochReported = true;
      fillCursor = 1;
      fillToken += 1;
      seekPending = false;
      suppressAdvanceCount = false;
      synthesisController = new AbortController();
      emitState("generating");
      probeSegment(0, blob);
      emitProgress();
      await runPlayback(myEpoch);
      if (myEpoch !== epoch) return;
      if (paused) return;
      // Parked-terminal tail (narrate's own): playback already drained —
      // ensure exactly one terminal state (reportNarrated is epoch-blocked
      // above, so library replays never touch the index).
      if (!playbackRunning && pendingBlobs.length === 0 && generationDone) {
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
      emitProgress();
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      deps.player.resume();
      if (activeMessageId) emitState("playing");
      emitProgress();
      if (!playbackRunning && (pendingBlobs.length > 0 || !generationDone)) {
        void runPlayback(epoch);
      } else if (!playbackRunning && pendingBlobs.length === 0 && generationDone) {
        // TPE-18b: a seek target may still be loading — its landing kicks
        // playback; emitting completion here would freeze the bar mid-air.
        if (seekPending) return;
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

    seekTo(positionSec: number): void {
      const status = lastState?.status;
      if (!activeMessageId || laneSegments.length === 0) return;
      if (status !== "generating" && status !== "playing" && status !== "paused") return;
      if (typeof positionSec !== "number" || !Number.isFinite(positionSec)) return;
      const clamped = Math.max(0, positionSec);
      // Map the cumulative position to (segment, offset) over the known
      // durations. Unknown segments have no width: a position inside one
      // lands at its start (offset 0) — honest slivers, never estimates.
      let acc = 0;
      let target = laneSegments.length - 1;
      let offset = 0;
      for (let i = 0; i < laneSegments.length; i += 1) {
        const d = durations[i] ?? null;
        if (d === null || clamped <= acc) {
          target = i;
          offset = 0;
          break;
        }
        if (clamped < acc + d) {
          target = i;
          offset = Math.min(clamped - acc, d);
          break;
        }
        acc += d;
      }
      // Same-segment landing with a live element: seamless clock jump,
      // no queue rebuild. Everything else goes through the full retarget.
      if (
        target === currentIndex &&
        offset !== livePosition &&
        (status === "playing" || status === "paused") &&
        deps.player.seekTo &&
        deps.player.getPosition?.() !== null
      ) {
        deps.player.seekTo(offset);
        livePosition = offset;
        emitProgress();
        return;
      }
      if (target === currentIndex && offset === livePosition) return;
      retarget(target, offset);
    },

    setVolume(volume: number): void {
      deps.player.setVolume?.(volume);
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
      // TPE-18b: retire the fill loop with the lane.
      fillToken += 1;
      fillActive = false;
      seekPending = false;
      suppressAdvanceCount = false;
      deps.player.skipCurrent();
      wakeStaleWaiter();
      wakeStaleFillWaiter();
      if (activeMessageId) emitState("complete");
    },

    setRate(rate: number): void {
      currentRate = rate;
      deps.player.setRate(rate);
    },
  };
}
