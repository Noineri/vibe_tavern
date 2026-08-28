/**
 * Shared KokoroTtsClient singleton (TTS_PLAN TS-7d).
 *
 * The narration lane (tts-playback-store) and the profile-editor preview
 * (use-tts-preview) must share ONE client: one worker, one model download,
 * app lifetime. Extracted from the store's module-local instance so both
 * consumers reference the same lazy object.
 */

import { KokoroTtsClient, type WorkerFactory } from "./kokoro-client.js";
import { createKokoroWorker } from "./kokoro-worker-factory.js";

let instance: KokoroTtsClient | null = null;
let workerFactoryForTests: WorkerFactory | null = null;

/** Shared KokoroTtsClient — one worker, one model load, app lifetime. */
export function getSharedKokoroClient(): KokoroTtsClient {
  if (!instance) instance = new KokoroTtsClient(workerFactoryForTests ?? createKokoroWorker);
  return instance;
}

/** Test seam. */
export function __resetSharedKokoroClientForTests(): void {
  instance?.dispose();
  instance = null;
}

/** Test seam: swap the worker factory the shared client is built from (fake
 *  worker instead of a real thread). Reset the shared client afterwards. */
export function __setKokoroWorkerFactoryForTests(factory: WorkerFactory | null): void {
  workerFactoryForTests = factory;
}
