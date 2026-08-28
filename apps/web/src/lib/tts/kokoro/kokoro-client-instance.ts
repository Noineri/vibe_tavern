/**
 * Shared KokoroTtsClient singleton (TTS_PLAN TS-7d) + the variant-aware load
 * orchestration (owner decision 2026-08-28: the user explicitly picks the
 * download/compute trade-off — see kokoro-load-options.ts).
 *
 * The narration lane (tts-playback-store) and the profile-editor preview
 * (use-tts-preview) must share ONE client: one worker, one model download,
 * app lifetime. Extracted from the store's module-local instance so both
 * consumers reference the same lazy object.
 *
 * Load entry points:
 * - ensureSharedKokoroModel() — narration/preview: never resets; joins an
 *   in-flight load; follows the stored variant or the auto pick (WebGPU).
 * - loadSharedKokoroModel(variant) — the panel's explicit Download/Switch:
 *   persists the choice, disposes the current client (rejects in-flight
 *   synthesis), and loads the chosen variant.
 * A failed WebGPU load falls back to the cpu variant once and leaves a
 * one-shot notice for the panel, so a blocklisted adapter does not turn
 * narration into a permanent error.
 */

import { KokoroTtsClient, type WorkerFactory } from "./kokoro-client.js";
import { createKokoroWorker } from "./kokoro-worker-factory.js";
import {
  autoKokoroVariant,
  detectWebGpu,
  kokoroLoadOptionsFor,
  readStoredKokoroVariant,
  writeStoredKokoroVariant,
  type KokoroModelVariant,
} from "./kokoro-load-options.js";

let instance: KokoroTtsClient | null = null;
let workerFactoryForTests: WorkerFactory | null = null;
let activeVariant: KokoroModelVariant | null = null;
let fallbackNotice: string | null = null;

/** Shared KokoroTtsClient — one worker, one model load, app lifetime. */
export function getSharedKokoroClient(): KokoroTtsClient {
  if (!instance) instance = new KokoroTtsClient(workerFactoryForTests ?? createKokoroWorker);
  return instance;
}

/** Which variant is loaded in the shared client right now (null = none). */
export function getActiveKokoroVariant(): KokoroModelVariant | null {
  return activeVariant;
}

/** One-shot notice: the gpu variant failed to start and the cpu model was
 *  loaded instead (reason inside). Consume-and-clear so it shows once. */
export function consumeKokoroFallbackNotice(): string | null {
  const notice = fallbackNotice;
  fallbackNotice = null;
  return notice;
}

/** Drop the shared client: dispose the worker, forget the variant. In-flight
 *  synthesis is rejected (orchestrator surfaces it) — only switching engines
 *  or tests call this deliberately. */
function resetSharedKokoroClient(): void {
  instance?.dispose();
  instance = null;
  activeVariant = null;
}

/** Test seam: swap the worker factory the shared client is built from (fake
 *  worker instead of a real thread). Reset the shared client afterwards. */
export function __setKokoroWorkerFactoryForTests(factory: WorkerFactory | null): void {
  workerFactoryForTests = factory;
}

/** Test seam. */
export function __resetSharedKokoroClientForTests(): void {
  resetSharedKokoroClient();
}

/** Load `variant` into the shared client (no reset — a loaded client is a
 *  no-op for the same lane, and load() itself shares concurrent promises).
 *  WebGPU failures degrade to the cpu variant and leave a fallback notice. */
async function loadVariant(variant: KokoroModelVariant): Promise<KokoroTtsClient> {
  const client = getSharedKokoroClient();
  const options = kokoroLoadOptionsFor(variant);
  try {
    await client.load(options.dtype, options.device);
    activeVariant = variant;
    return client;
  } catch (error) {
    if (options.device !== "webgpu") throw error;
    // navigator.gpu exists but the adapter is blocklisted/driver-broken —
    // degrade to the lightweight cpu model instead of failing narration.
    const reason = error instanceof Error ? error.message : String(error);
    const cpu = kokoroLoadOptionsFor("cpu");
    await client.load(cpu.dtype, cpu.device);
    activeVariant = "cpu";
    // Persist the working choice: do not re-attempt a broken GPU path on
    // every boot; the panel's picker can re-pick gpu at any time.
    writeStoredKokoroVariant("cpu");
    fallbackNotice = reason;
    return client;
  }
}

/** Resolve + load the shared model for narration/preview (idempotent; joins
 *  an in-flight download). Follows the stored variant, else auto: gpu when
 *  WebGPU is available, cpu otherwise. */
export async function ensureSharedKokoroModel(): Promise<KokoroTtsClient> {
  const existing = getSharedKokoroClient();
  if (existing.isLoaded()) return existing;
  const variant = readStoredKokoroVariant() ?? autoKokoroVariant(detectWebGpu());
  return loadVariant(variant);
}

/** The panel's explicit action: persist the user's choice, drop the current
 *  client (even a loaded one — this is the switch path) and load `variant`.
 *  The old variant's CacheStorage copy stays (browser-managed cache). */
export async function loadSharedKokoroModel(variant: KokoroModelVariant): Promise<KokoroTtsClient> {
  writeStoredKokoroVariant(variant);
  resetSharedKokoroClient();
  return loadVariant(variant);
}
