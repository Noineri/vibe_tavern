/**
 * Main-thread client for the Kokoro TTS Web Worker (TTS_PLAN TS-3b).
 *
 * Wraps the worker in a promise API: `load()` (one-time model download with
 * progress), `generate(text, voice)` (Float32 PCM → WAV Blob), `dispose()`.
 * Errors cross the worker boundary as plain envelopes (`kokoro-protocol.ts`)
 * and are reconstructed into the typed `KokoroError` hierarchy here.
 *
 * The worker factory is injectable so tests run against a fake worker without
 * spawning real threads or network. `KokoroVoiceNotFoundError` for unknown ids
 * is raised eagerly on the main thread (manifest lookup) before any worker
 * round-trip; non-English voices of the 54-voice roster are rejected here too
 * (the in-browser engine synthesizes English only — see kokoro-worker.ts).
 */

import {
  KokoroGenerateError,
  KokoroModelNotLoadedError,
  KokoroVoiceNotFoundError,
} from "./kokoro-errors.js";
import { float32ToWavBytes } from "./float32-to-wav.js";
import { resolveKokoroVoice } from "../kokoro-voices.js";
import type {
  KokoroDevice,
  KokoroDtype,
  KokoroWorkerRequest,
  KokoroWorkerResponse,
} from "./kokoro-protocol.js";

export interface KokoroLoadProgress {
  /** Opaque transformers.js progress payload (file, progress, loaded…). */
  data: unknown;
}

export type WorkerLike = {
  postMessage(request: KokoroWorkerRequest): void;
  terminate(): void;
  set onmessage(handler: ((event: MessageEvent<KokoroWorkerResponse>) => void) | null);
};

export type WorkerFactory = () => WorkerLike;

/** Stall watchdog: max silence (no progress event, no completion) during a
 *  model load before we give up with an actionable error. The model comes
 *  from huggingface.co — a blackholed connection otherwise hangs the load
 *  promise FOREVER with zero feedback ("Послушать виснет"). Progress events
 *  reset the timer, so a slow-but-alive download never trips it. */
export const KOKORO_LOAD_STALL_MS = 30_000;

let stallMsForTests: number | null = null;

/** Test seam: shrink the watchdog so the stall path is testable in ms. */
export function __setKokoroLoadStallMsForTests(ms: number | null): void {
  stallMsForTests = ms;
}

/** Default factory — real Web Worker from the Vite `?worker` import at the call
 *  site in app code; kept indirect so this module stays DOM-optional for tests. */
export type { KokoroWorkerRequest, KokoroWorkerResponse };

export interface KokoroGenerateOutput {
  /** WAV-encoded audio, ready for <audio>/queue playback. */
  blob: Blob;
  sampleRate: number;
}

export class KokoroTtsClient {
  private worker: WorkerLike | null = null;
  private nextId = 0;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly pendingGenerate = new Map<
    number,
    {
      resolve: (out: { audio: Float32Array; sampleRate: number }) => void;
      reject: (error: Error) => void;
    }
  >();
  private progressListeners = new Set<(progress: KokoroLoadProgress) => void>();

  private readonly workerFactory: WorkerFactory;

  /** The worker is created LAZILY (first load/generate/dispose), not here:
   * `new Worker(...)` can throw synchronously (dev server serves modules
   * from a file:// origin — a SecurityError from an http page), and a throw
   * from the constructor would crash the whole React tree that merely
   * RENDERS a component holding a client. Deferred creation turns the same
   * failure into a rejected load/generate promise the UI can show. */
  constructor(workerFactory: WorkerFactory) {
    this.workerFactory = workerFactory;
  }

  /** Create the worker on first use and wire its message handler once. */
  private ensureWorker(): WorkerLike {
    if (this.worker === null) {
      const worker = this.workerFactory();
      worker.onmessage = (event) => this.handleResponse(event.data);
      this.worker = worker;
    }
    return this.worker;
  }

  /** True after a successful `load()` round-trip. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Subscribe to model-download progress. Returns an unsubscribe fn. */
  onLoadProgress(listener: (progress: KokoroLoadProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Download + initialize the model (idempotent; concurrent calls share one
   *  promise). Resolves when the worker reports `loaded`; a load failure
   *  clears the shared promise so the next call retries. */
  load(dtype: KokoroDtype = "q8", device: KokoroDevice = "wasm"): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = new Promise<void>((resolve, reject) => {
        this.loadResolve = () => {
          this.clearStallWatchdog();
          this.loaded = true;
          this.loadResolve = null;
          this.loadReject = null;
          resolve();
        };
        this.loadReject = (error: Error) => {
          this.clearStallWatchdog();
          this.loadResolve = null;
          this.loadReject = null;
          this.loadPromise = null;
          reject(error);
        };
        try {
          this.armStallWatchdog();
          this.ensureWorker().postMessage({ type: "load", dtype, device });
        } catch (err) {
          // Worker construction failed (e.g. dev file:// origin) — surface it
          // as a load failure instead of crashing the caller.
          this.clearStallWatchdog();
          this.loadResolve = null;
          this.loadReject = null;
          reject(toError(err));
        }
      });
      // The executor runs BEFORE `this.loadPromise =` is assigned, so a
      // synchronous rejection cannot null the cache from inside — clear it
      // from a rejection handler so a retry goes through the factory again.
      const pending = this.loadPromise;
      pending.catch(() => {
        if (this.loadPromise === pending && !this.loaded) this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private loadResolve: (() => void) | null = null;
  private loadReject: ((error: Error) => void) | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  /** (Re)arm the silence watchdog — called on load start and every progress
   *  event. Fires → reject the load with a diagnosable error. */
  private armStallWatchdog(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    const ms = stallMsForTests ?? KOKORO_LOAD_STALL_MS;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const error = new KokoroGenerateError(
        `Model download stalled (${Math.round(ms / 1000)}s without progress) — huggingface.co may be unreachable. Check the connection and retry.`,
      );
      this.loadReject?.(error);
      this.loadReject = null;
      this.loadResolve = null;
      this.loadPromise = null;
    }, ms);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /** Synthesize text to a WAV Blob. Rejects with the typed Kokoro errors. */
  async generate(text: string, voice: string, speed?: number): Promise<KokoroGenerateOutput> {
    const raw = await this.generateRaw(text, voice, speed);
    const wav = float32ToWavBytes(raw.audio, raw.sampleRate);
    return { blob: new Blob([wav], { type: "audio/wav" }), sampleRate: raw.sampleRate };
  }

  /** Synthesize PRE-SPLIT chunks sequentially and return ONE WAV whose PCM is
   *  the concatenation of the per-chunk waveforms (D10: kokoro-js caps its
   *  internal generation length, so over-long narration text must arrive in
   *  model-safe pieces — the chunk POLICY lives in kokoro-text.ts; this method
   *  is transport only). Each chunk carries its own voiceId so a dual-voice
   *  profile can assign narrator vs character voices per segment (TE2-6);
   *  single-voice callers pass the same voiceId in every chunk (byte-identical
   *  to the pre-TE2-6 single-voice path). Chunks run one at a time (the wasm
   *  engine is not concurrent-friendly); all-or-nothing: a mid-chunk failure
   *  rejects and discards the partial audio. */
  async generateChunked(
    chunks: readonly { text: string; voiceId: string }[],
    speed?: number,
  ): Promise<KokoroGenerateOutput> {
    const parts = chunks.filter((chunk) => chunk.text.length > 0);
    if (parts.length === 0) {
      throw new KokoroGenerateError("Nothing to synthesize — the chunk list is empty.");
    }
    const waveforms: Float32Array[] = [];
    let sampleRate = 0;
    for (const chunk of parts) {
      const raw = await this.generateRaw(chunk.text, chunk.voiceId, speed);
      waveforms.push(raw.audio);
      sampleRate = raw.sampleRate;
    }
    const total = waveforms.reduce((sum, waveform) => sum + waveform.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const waveform of waveforms) {
      audio.set(waveform, offset);
      offset += waveform.length;
    }
    const wav = float32ToWavBytes(audio, sampleRate);
    return { blob: new Blob([wav], { type: "audio/wav" }), sampleRate };
  }

  /** One worker round-trip returning raw PCM (shared by generate and
   *  generateChunked so both paths validate voices identically). */
  private async generateRaw(
    text: string,
    voice: string,
    speed?: number,
  ): Promise<{ audio: Float32Array; sampleRate: number }> {
    // Eager manifest validation (typed errors before any worker round-trip).
    const info = resolveKokoroVoice(voice);
    if (info.lang !== "a" && info.lang !== "b") {
      throw new KokoroGenerateError(
        `Voice "${voice}" (${info.lang}) is not available in the in-browser engine (English only).`,
      );
    }
    if (!this.loaded) {
      throw new KokoroModelNotLoadedError("Model is not loaded — call load() first.");
    }
    const id = ++this.nextId;
    const request: KokoroWorkerRequest = { type: "generate", id, text, voice, speed };
    return new Promise<{ audio: Float32Array; sampleRate: number }>((resolve, reject) => {
      this.pendingGenerate.set(id, { resolve, reject });
      try {
        this.ensureWorker().postMessage(request);
      } catch (err) {
        this.pendingGenerate.delete(id);
        reject(toError(err));
      }
    });
  }

  /** Drop the worker and its model reference. The client is unusable after. */
  dispose(): void {
    this.clearStallWatchdog();
    if (this.worker !== null) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
    }
    this.rejectAllPending(new KokoroGenerateError("Client disposed."));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private handleResponse(response: KokoroWorkerResponse): void {
    switch (response.type) {
      case "load-progress": {
        // Alive download — push the silence window out (only while a load is
        // actually pending; after `loaded` the resolved promise stays behind
        // and stale events must not re-arm the watchdog).
        if (this.loadReject !== null) this.armStallWatchdog();
        const progress = { data: response.data };
        for (const listener of this.progressListeners) listener(progress);
        return;
      }
      case "loaded": {
        this.loadResolve?.();
        this.loadResolve = null;
        this.loadReject = null;
        return;
      }
      case "generated": {
        const pending = this.pendingGenerate.get(response.id);
        if (!pending) return;
        this.pendingGenerate.delete(response.id);
        pending.resolve({ audio: response.audio, sampleRate: response.sampleRate });
        return;
      }
      case "error": {
        const error = reconstructError(response.name, response.message, response.voiceId);
        if (response.id !== undefined) {
          const pending = this.pendingGenerate.get(response.id);
          if (!pending) return;
          this.pendingGenerate.delete(response.id);
          pending.reject(error);
          return;
        }
        // Load-phase error (no correlation id).
        this.loadReject?.(error);
        this.loadReject = null;
        this.loadResolve = null;
        this.loadPromise = null;
        return;
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingGenerate.values()) pending.reject(error);
    this.pendingGenerate.clear();
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new KokoroGenerateError(String(err));
}

function reconstructError(name: string, message: string, voiceId?: string): Error {
  if (name === "KokoroVoiceNotFoundError" && voiceId !== undefined) {
    return new KokoroVoiceNotFoundError(voiceId);
  }
  if (name === "KokoroModelNotLoadedError") {
    return new KokoroModelNotLoadedError(message);
  }
  return new KokoroGenerateError(message);
}
