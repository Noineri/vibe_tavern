/**
 * Real Web Worker factory for the Whisper STT client (STT_PLAN ST-3).
 *
 * Lives apart from `whisper-client.ts` so tests (which inject a fake) never
 * load this module. Two build worlds — the exact Kokoro contract:
 * - DEV (Bun HTML dev server): the worker entry is the raw `.ts` source
 *   served next to this module; `new URL("./whisper-worker.ts", …)` works.
 * - PROD (`scripts/build-web.ts`): Bun.build does NOT emit `new Worker(new
 *   URL(...))` chunks — the worker is compiled as its own entrypoint to
 *   `assets/whisper-worker.js` (fixed name, cache-busted with the app
 *   version), and this factory points there.
 */

import { APP_VERSION, isProd } from "../../../build-config.js";

import type { WorkerFactory } from "./whisper-client.js";

/** Prod asset emitted by `scripts/build-web.ts` (worker entrypoint build). */
const PROD_WORKER_URL = "/assets/whisper-worker.js";

export function whisperWorkerUrl(prod: boolean = isProd): string {
  if (prod) return `${PROD_WORKER_URL}?v=${APP_VERSION}`;
  return new URL("./whisper-worker.ts", import.meta.url).href;
}

export const createWhisperWorker: WorkerFactory = () =>
  new Worker(whisperWorkerUrl(), { type: "module" });
