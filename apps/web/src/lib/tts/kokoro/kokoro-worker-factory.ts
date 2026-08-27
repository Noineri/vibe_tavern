/**
 * Real Web Worker factory for the Kokoro TTS client (TTS_PLAN TS-3b).
 *
 * Lives apart from `kokoro-client.ts` so tests (which inject a fake) never
 * load this module: the `new URL(...)` pattern makes Vite emit the worker —
 * and the whole kokoro-js/@huggingface/transformers stack — as a separate
 * chunk that the main bundle only references lazily.
 */

import type { WorkerFactory } from "./kokoro-client.js";

export const createKokoroWorker: WorkerFactory = () =>
  new Worker(new URL("./kokoro-worker.ts", import.meta.url), { type: "module" });
