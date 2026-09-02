/**
 * Shared WhisperSttClient singleton (STT_PLAN ST-4b) — the dictation lane is
 * the whisper-browser engine's app-lifetime consumer, mirroring
 * kokoro-client-instance.ts: one worker, one model download, shared across
 * every dictation turn. The model id comes from the ACTIVE dictation
 * profile's config; loading a different model swaps it (the client chains
 * loads — see whisper-client.ts).
 */

import { WhisperSttClient, type WorkerFactory } from "./whisper/whisper-client.js";
import { createWhisperWorker } from "./whisper/whisper-worker-factory.js";

let instance: WhisperSttClient | null = null;
let workerFactoryForTests: WorkerFactory | null = null;

/** The shared client — lazily constructed (a real `new Worker` throw must
 *  not crash a React tree, the Kokoro lesson). */
export function getSharedWhisperClient(): WhisperSttClient {
  if (instance === null) {
    instance = new WhisperSttClient(workerFactoryForTests ?? createWhisperWorker);
  }
  return instance;
}

/** Ensure the given roster model is loaded (idempotent; joins an in-flight
 *  load of the SAME model; a different model chains after the current one). */
export async function ensureSharedWhisperModel(modelId: string): Promise<WhisperSttClient> {
  const client = getSharedWhisperClient();
  await client.load(modelId);
  return client;
}

/** Test seam: swap the worker factory + drop the shared client. */
export function __setWhisperWorkerFactoryForTests(factory: WorkerFactory | null): void {
  workerFactoryForTests = factory;
  instance?.dispose();
  instance = null;
}
