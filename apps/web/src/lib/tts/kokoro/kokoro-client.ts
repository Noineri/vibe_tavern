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

/** Default factory — real Web Worker from the Vite `?worker` import at the call
 *  site in app code; kept indirect so this module stays DOM-optional for tests. */
export type { KokoroWorkerRequest, KokoroWorkerResponse };

export interface KokoroGenerateOutput {
  /** WAV-encoded audio, ready for <audio>/queue playback. */
  blob: Blob;
  sampleRate: number;
}

export class KokoroTtsClient {
  private readonly worker: WorkerLike;
  private nextId = 0;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly pendingGenerate = new Map<
    number,
    { resolve: (out: KokoroGenerateOutput) => void; reject: (error: Error) => void }
  >();
  private progressListeners = new Set<(progress: KokoroLoadProgress) => void>();

  constructor(workerFactory: WorkerFactory) {
    this.worker = workerFactory();
    this.worker.onmessage = (event) => this.handleResponse(event.data);
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
          this.loaded = true;
          this.loadResolve = null;
          this.loadReject = null;
          resolve();
        };
        this.loadReject = (error: Error) => {
          this.loadResolve = null;
          this.loadReject = null;
          this.loadPromise = null;
          reject(error);
        };
      });
      this.worker.postMessage({ type: "load", dtype, device });
    }
    return this.loadPromise;
  }

  private loadResolve: (() => void) | null = null;
  private loadReject: ((error: Error) => void) | null = null;

  /** Synthesize text to a WAV Blob. Rejects with the typed Kokoro errors. */
  async generate(text: string, voice: string, speed?: number): Promise<KokoroGenerateOutput> {
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
    return new Promise<KokoroGenerateOutput>((resolve, reject) => {
      this.pendingGenerate.set(id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  /** Drop the worker and its model reference. The client is unusable after. */
  dispose(): void {
    this.worker.postMessage({ type: "dispose" });
    this.worker.terminate();
    this.rejectAllPending(new KokoroGenerateError("Client disposed."));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private handleResponse(response: KokoroWorkerResponse): void {
    switch (response.type) {
      case "load-progress": {
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
        const wav = float32ToWavBytes(response.audio, response.sampleRate);
        pending.resolve({ blob: new Blob([wav], { type: "audio/wav" }), sampleRate: response.sampleRate });
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

function reconstructError(name: string, message: string, voiceId?: string): Error {
  if (name === "KokoroVoiceNotFoundError" && voiceId !== undefined) {
    return new KokoroVoiceNotFoundError(voiceId);
  }
  if (name === "KokoroModelNotLoadedError") {
    return new KokoroModelNotLoadedError(message);
  }
  return new KokoroGenerateError(message);
}
