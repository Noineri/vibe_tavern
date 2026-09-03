/**
 * Shared WhisperSttClient singleton (STT_PLAN ST-4b) — the dictation lane is
 * the whisper-browser engine's app-lifetime consumer, mirroring
 * kokoro-client-instance.ts: one worker, one model download, shared across
 * every dictation turn. The model id comes from the ACTIVE dictation
 * profile's config; loading a different model swaps it (the client chains
 * loads — see whisper-client.ts).
 *
 * GPU lane (owner decision 2026-09-05, "конечно добавить" — the video card
 * is faster): when WebGPU is available the model loads as fp16 on the GPU
 * (dtype fp16 is the transformers.js WebGPU path; q8 quantized weights are
 * the wasm path). Any GPU-lane failure (missing adapter, blocklisted
 * driver, fp16/shader error) falls back to the CPU lane wasm/q8 — the same
 * gpu→cpu fallback contract the Kokoro side ships. Both lanes flow through
 * this ONE seam: the settings panel download, the dictation mic press and
 * mid-download joins all call ensureSharedWhisperModel().
 */

import { WhisperSttClient, type WorkerFactory } from "./whisper/whisper-client.js";
import { createWhisperWorker } from "./whisper/whisper-worker-factory.js";

/** Which weights/device pair a load uses: webgpu = fp16 on the GPU,
 *  wasm = q8 on the CPU (the universal fallback). */
export type WhisperLane = "webgpu" | "wasm";

let instance: WhisperSttClient | null = null;
let workerFactoryForTests: WorkerFactory | null = null;
let laneProbeForTests: (() => WhisperLane) | null = null;
/** Per-model memo: concurrent callers join ONE ensure (the same contract the
 *  client-level load chaining provided — lifted here so the GPU→CPU fallback
 *  also runs exactly once per model, not once per racing caller). */
let ensureEntry: { modelId: string; promise: Promise<WhisperSttClient> } | null = null;

/** The browser's WebGPU availability (env fact, stable for the session). */
export function whisperPreferredLane(): WhisperLane {
  return typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu != null ? "webgpu" : "wasm";
}

/** The lane the UI should ASSUME (size hints, lane badge): the probe seam in
 *  tests, the real browser fact in production. */
export function currentWhisperLane(): WhisperLane {
  return (laneProbeForTests ?? whisperPreferredLane)();
}

/** The shared client — lazily constructed (a real `new Worker` throw must
 *  not crash a React tree, the Kokoro lesson). */
export function getSharedWhisperClient(): WhisperSttClient {
  if (instance === null) {
    instance = new WhisperSttClient(workerFactoryForTests ?? createWhisperWorker);
  }
  return instance;
}

/** Ensure the given roster model is loaded on the best available lane
 *  (idempotent; joins an in-flight ensure of the SAME model; a different
 *  model chains after the current load). GPU lane failure falls back to
 *  wasm/q8 once per ensure — the cached fp16 bytes stay on disk and a later
 *  retry re-runs the lane selection from the top. */
export async function ensureSharedWhisperModel(modelId: string): Promise<WhisperSttClient> {
  if (ensureEntry?.modelId === modelId) return ensureEntry.promise;
  const client = getSharedWhisperClient();
  const lane = currentWhisperLane();
  const promise = (async () => {
    if (lane === "webgpu") {
      try {
        await client.load(modelId, "webgpu", "fp16");
        return client;
      } catch {
        // GPU lane failed — fall back to the CPU lane (fp16 files that
        // already landed in the browser/server caches are not wasted: a
        // future session with a healthy adapter reuses them).
      }
    }
    await client.load(modelId, "wasm", "q8");
    return client;
  })();
  ensureEntry = { modelId, promise };
  // A fully failed ensure (both lanes) must not pin a dead memo entry —
  // otherwise a retry would forever re-reject without touching the client.
  promise.catch(() => {
    if (ensureEntry?.promise === promise) ensureEntry = null;
  });
  return promise;
}

/** Test seam: swap the worker factory + drop the shared client + memo. */
export function __setWhisperWorkerFactoryForTests(factory: WorkerFactory | null): void {
  workerFactoryForTests = factory;
  instance?.dispose();
  instance = null;
  ensureEntry = null;
}

/** Test seam: force the lane selection (panel badge / size hints and the
 *  ensure path both read it via currentWhisperLane()). */
export function __setWhisperLaneProbeForTests(probe: (() => WhisperLane) | null): void {
  laneProbeForTests = probe;
}
