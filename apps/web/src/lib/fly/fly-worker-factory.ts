/**
 * Real Web Worker factory for Fly Tribunal (FLY_TRIBUNAL_PLAN FT-6).
 *
 * fork #2 of apps/web/src/lib/tts/kokoro/kokoro-worker-factory.ts
 *
 * Lives apart from `fly-client-instance.ts` so tests (which only exercise
 * URL resolution) never construct a real Worker. Two build worlds — the
 * exact Kokoro/Whisper contract:
 * - DEV (Bun HTML dev server): the raw future `fly-worker.ts` source is
 *   served next to this module.
 * - PROD (`scripts/build-web.ts`): Bun.build does NOT emit
 *   `new Worker(new URL(...))` chunks, so FT-7 must add the worker as its own
 *   entrypoint to the fixed `assets/fly-worker.js` asset.
 */

import { APP_VERSION, isProd } from "../../build-config.js";

/** Factory seam for the app-lifetime shared Fly worker. */
export type FlyWorkerFactory = () => Worker;

/** Prod asset to be emitted by the FT-7 worker-entrypoint build. */
const PROD_WORKER_URL = "/assets/fly-worker.js";

export function flyWorkerUrl(prod: boolean = isProd): string {
  if (prod) return `${PROD_WORKER_URL}?v=${APP_VERSION}`;
  return new URL("./fly-worker.ts", import.meta.url).href;
}

export const createFlyWorker: FlyWorkerFactory = () =>
  new Worker(flyWorkerUrl(), { type: "module" });
