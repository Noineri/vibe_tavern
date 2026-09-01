/**
 * Main-thread client for the Whisper STT Web Worker (STT_PLAN ST-3).
 *
 * Wraps the worker in a promise API: `load()` (one-time model download with
 * progress), `transcribeBlob(blob, { language })` (audio Blob → decoded to
 * 16 kHz mono PCM on THIS thread — AudioContext is main-thread-only — then
 * transcribed in the worker → text), `dispose()`. Errors cross the worker
 * boundary as plain envelopes (`whisper-protocol.ts`) and are reconstructed
 * into the typed hierarchy here (`whisper-errors.ts`).
 *
 * The worker factory and the audio decoder are injectable so tests run
 * against fakes without threads, network, or Web Audio (mirrors the Kokoro
 * client's injectable-worker pattern; happy-dom has no decodeAudioData).
 */

import { WhisperModelNotLoadedError, WhisperTranscribeError } from "./whisper-errors.js";
import type {
  WhisperDevice,
  WhisperDtype,
  WhisperWorkerRequest,
  WhisperWorkerResponse,
} from "./whisper-protocol.js";

export interface WhisperLoadProgress {
  /** Opaque transformers.js progress payload (file, progress, loaded…). */
  data: unknown;
}

export type WorkerLike = {
  postMessage(request: WhisperWorkerRequest): void;
  terminate(): void;
  set onmessage(handler: ((event: MessageEvent<WhisperWorkerResponse>) => void) | null);
};

export type WorkerFactory = () => WorkerLike;

/** Decode an audio Blob to 16 kHz MONO Float32Array PCM (whisper's required
 *  input). Injectable for tests; the default uses Web Audio. */
export type AudioDecoder = (blob: Blob) => Promise<Float32Array>;

/** Stall watchdog: max silence (no progress event, no completion) during a
 *  model download before giving up with an actionable error — the downloads
 *  come through the server mirror, but a blackholed connection would
 *  otherwise hang the load promise FOREVER with zero feedback (the exact
 *  Kokoro "Послушать виснет" defect class). Progress events reset the timer. */
export const WHISPER_LOAD_STALL_MS = 30_000;

let stallMsForTests: number | null = null;

/** Test seam: shrink the watchdog so the stall path is testable in ms. */
export function __setWhisperLoadStallMsForTests(ms: number | null): void {
  stallMsForTests = ms;
}

/** Default decoder: OfflineAudioContext-free path — a regular AudioContext
 *  constructed AT 16 kHz resamples `decodeAudioData` output to exactly the
 *  rate whisper wants (the browser resamples during decode). Multi-channel
 *  input is downmixed with the sqrt(2) energy-preserving merge (the same
 *  recipe as the transformers.js audio-processing guide). */
const defaultDecodeAudio: AudioDecoder = async (blob) => {
  const AudioContextCtor =
    typeof AudioContext !== "undefined" ? AudioContext : undefined;
  if (!AudioContextCtor) {
    throw new WhisperTranscribeError("Web Audio is unavailable — cannot decode the recording.");
  }
  const context = new AudioContextCtor({ sampleRate: 16_000 });
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = buffer.numberOfChannels;
    if (channels <= 1) {
      return new Float32Array(buffer.getChannelData(0));
    }
    // Downmix to mono (energy-preserving, mirrors the transformers.js guide).
    const scaling = Math.sqrt(2);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i += 1) {
      mono[i] = (scaling * (left[i] + right[i])) / 2;
    }
    return mono;
  } finally {
    void context.close();
  }
};

export class WhisperSttClient {
  private worker: WorkerLike | null = null;
  private nextId = 0;
  private loadedModelId: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly pendingTranscribe = new Map<
    number,
    { resolve: (text: string) => void; reject: (error: Error) => void }
  >();
  private progressListeners = new Set<(progress: WhisperLoadProgress) => void>();

  private readonly workerFactory: WorkerFactory;
  private readonly decodeAudio: AudioDecoder;
  private disposed = false;

  /** Both deps injectable; the worker is created LAZILY (first use), not
   *  here — `new Worker(...)` can throw synchronously (file:// dev origins)
   *  and a constructor throw would crash the React tree that merely renders
   *  a holder of this client (the Kokoro lesson). */
  constructor(
    workerFactory: WorkerFactory,
    options?: { decodeAudio?: AudioDecoder },
  ) {
    this.workerFactory = workerFactory;
    this.decodeAudio = options?.decodeAudio ?? defaultDecodeAudio;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker === null) {
      const worker = this.workerFactory();
      worker.onmessage = (event) => this.handleResponse(event.data);
      this.worker = worker;
    }
    return this.worker;
  }

  /** Model id loaded in the worker right now (null = none). */
  getLoadedModelId(): string | null {
    return this.loadedModelId;
  }

  isLoaded(): boolean {
    return this.loadedModelId !== null;
  }

  onLoadProgress(listener: (progress: WhisperLoadProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Download + initialize a model (idempotent for the SAME model;
   *  concurrent same-model calls share one promise). A load of a DIFFERENT
   *  model while one is in flight CHAINS after it (the worker swaps models
   *  sequentially) — a concurrent caller must never receive a promise that
   *  resolves with the wrong model. */
  load(modelId: string, device: WhisperDevice = "wasm", dtype: WhisperDtype = "q8"): Promise<void> {
    if (this.loadedModelId === modelId && this.loadPromise === null) return Promise.resolve();
    if (this.loadPromise !== null) {
      const current = this.loadPromise;
      return current.catch(() => {}).then(() => this.load(modelId, device, dtype));
    }
    return this.startLoad(modelId, device, dtype);
  }

  private startLoad(modelId: string, device: WhisperDevice, dtype: WhisperDtype): Promise<void> {
    this.loadPromise = new Promise<void>((resolve, reject) => {
      this.loadResolve = () => {
        this.clearStallWatchdog();
        this.loadedModelId = modelId;
        this.loadResolve = null;
        this.loadReject = null;
        this.loadPromise = null;
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
        this.ensureWorker().postMessage({ type: "load", modelId, dtype, device });
      } catch (err) {
        this.clearStallWatchdog();
        this.loadResolve = null;
        this.loadReject = null;
        this.loadPromise = null;
        reject(toError(err));
      }
    });
    return this.loadPromise;
  }

  private loadResolve: (() => void) | null = null;
  private loadReject: ((error: Error) => void) | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  private armStallWatchdog(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer);
    const ms = stallMsForTests ?? WHISPER_LOAD_STALL_MS;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const error = new WhisperTranscribeError(
        `Model download stalled (${Math.round(ms / 1000)}s without progress) — the mirror or the network may be down. Retry the download.`,
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

  /** Decode + transcribe one audio clip. `language` is a hint; the worker
   *  drops it for English-only models. */
  async transcribeBlob(
    blob: Blob,
    options?: { language?: string },
  ): Promise<string> {
    if (!this.isLoaded()) {
      throw new WhisperModelNotLoadedError();
    }
    let audio: Float32Array;
    try {
      audio = await this.decodeAudio(blob);
    } catch (err) {
      throw err instanceof WhisperTranscribeError ? err : new WhisperTranscribeError(
        `Failed to decode the recording: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // dispose() may have raced the decode above; a request posted to a
    // terminated worker would hang forever — reject instead.
    if (this.disposed) {
      throw new WhisperTranscribeError("Client disposed.");
    }
    const id = ++this.nextId;
    const request: WhisperWorkerRequest = { type: "transcribe", id, audio };
    const language = options?.language;
    if (language !== undefined && language !== "") request.language = language;
    return new Promise<string>((resolve, reject) => {
      this.pendingTranscribe.set(id, { resolve, reject });
      try {
        this.ensureWorker().postMessage(request);
      } catch (err) {
        this.pendingTranscribe.delete(id);
        reject(toError(err));
      }
    });
  }

  /** Drop the worker and its model reference. The client is unusable after.
   *  An in-flight load is abandoned: its watchdog is cleared and a late
   *  `loaded` response becomes a no-op (no resolve/reject left wired). */
  dispose(): void {
    this.disposed = true;
    this.clearStallWatchdog();
    if (this.worker !== null) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
    }
    this.loadedModelId = null;
    this.loadResolve = null;
    this.loadReject = null;
    this.loadPromise = null;
    this.rejectAllPending(new WhisperTranscribeError("Client disposed."));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private handleResponse(response: WhisperWorkerResponse): void {
    switch (response.type) {
      case "load-progress": {
        if (this.loadReject !== null) this.armStallWatchdog();
        const progress = { data: response.data };
        for (const listener of this.progressListeners) listener(progress);
        return;
      }
      case "loaded": {
        this.loadResolve?.();
        return;
      }
      case "transcribed": {
        const pending = this.pendingTranscribe.get(response.id);
        if (!pending) return;
        this.pendingTranscribe.delete(response.id);
        pending.resolve(response.text);
        return;
      }
      case "error": {
        const error = reconstructError(response.name, response.message);
        if (response.id !== undefined) {
          const pending = this.pendingTranscribe.get(response.id);
          if (!pending) return;
          this.pendingTranscribe.delete(response.id);
          pending.reject(error);
          return;
        }
        this.loadReject?.(error);
        this.loadReject = null;
        this.loadResolve = null;
        this.loadPromise = null;
        return;
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingTranscribe.values()) pending.reject(error);
    this.pendingTranscribe.clear();
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new WhisperTranscribeError(String(err));
}

function reconstructError(name: string, message: string): Error {
  if (name === "WhisperModelNotLoadedError") {
    return new WhisperModelNotLoadedError(message);
  }
  return new WhisperTranscribeError(message);
}
