/**
 * Real Web Worker factory for the Kokoro TTS client (TTS_PLAN TS-3b).
 *
 * Lives apart from `kokoro-client.ts` so tests (which inject a fake) never
 * load this module.
 *
 * Worker URL resolution — two build worlds:
 * - DEV (Bun HTML dev server): the worker entry is the raw `.ts` source
 *   served next to this module; `new URL("./kokoro-worker.ts", …)` works.
 * - PROD (`scripts/build-web.ts`): Bun.build does NOT emit `new Worker(new
 *   URL(...))` chunks (that is a Vite feature) — the worker would 404 and the
 *   download would stall forever. The prod build therefore compiles the
 *   worker as its own entrypoint to `assets/kokoro-worker.js` (fixed name;
 *   cache-busted with the app version), and this factory points there.
 */

import { APP_VERSION, isProd } from "../../../build-config.js";

import type { WorkerFactory } from "./kokoro-client.js";

/** Prod asset emitted by `scripts/build-web.ts` (worker entrypoint build). */
const PROD_WORKER_URL = "/assets/kokoro-worker.js";

export function kokoroWorkerUrl(prod: boolean = isProd): string {
	if (prod) return `${PROD_WORKER_URL}?v=${APP_VERSION}`;
	return new URL("./kokoro-worker.ts", import.meta.url).href;
}

export const createKokoroWorker: WorkerFactory = () =>
	new Worker(kokoroWorkerUrl(), { type: "module" });
