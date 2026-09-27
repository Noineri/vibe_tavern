/**
 * Shared Fly Tribunal worker singleton (FLY_TRIBUNAL_PLAN FT-6).
 *
 * The worker protocol and simulation operations land in FT-7; this unit owns
 * the app-lifetime worker identity so the settings download lane and later
 * verdict/training consumers cannot accidentally create competing brains.
 *
 * Structural precedent: `kokoro-client-instance.ts` and
 * `whisper-client-instance.ts`. Those clients already own mature protocols;
 * Fly starts with the raw worker because its protocol does not exist until
 * FT-7. Consumers use this one accessor rather than constructing Workers.
 */

import { createFlyWorker, type FlyWorkerFactory } from "./fly-worker-factory.js";

let instance: Worker | null = null;
let workerFactoryForTests: FlyWorkerFactory | null = null;

/** One Fly worker for the browser app lifetime. */
export function getSharedFlyWorker(): Worker {
  if (instance === null) instance = (workerFactoryForTests ?? createFlyWorker)();
  return instance;
}

/** Dispose the app-lifetime worker before deliberately replacing its brain. */
export function disposeSharedFlyWorker(): void {
  instance?.terminate();
  instance = null;
}

/** Test seam for FT-7+ client protocol tests. */
export function __setFlyWorkerFactoryForTests(factory: FlyWorkerFactory | null): void {
  workerFactoryForTests = factory;
  disposeSharedFlyWorker();
}
