/**
 * Kokoro model variant selection (owner decision 2026-08-28): the user picks
 * the download/compute trade-off explicitly instead of a silent default.
 *
 * Two variants, worded for humans (not dtype jargon):
 * - "gpu": full model on WebGPU — fp32, ~310 MB one-time, the fast path.
 * - "cpu": lightweight model on wasm/CPU — q8, ~90 MB, slower but small.
 *
 * Sizes are the onnx weights as served by onnx-community/Kokoro-82M-v1.0-ONNX
 * (verified 2026-08-28: model.onnx 310.5 MB, model_quantized.onnx 88.1 MB);
 * config/tokenizer/voice files add a few MB on top. Approximate by design —
 * the download UI reports live exact bytes.
 *
 * The choice is per-browser BY DESIGN: the model cache lives in this
 * browser's CacheStorage, so a desktop that downloaded fp32 must not force a
 * laptop to reuse it. Stored under one localStorage key; no stored choice
 * means "auto": gpu when navigator.gpu exists, else cpu. A failed WebGPU load
 * (blocklisted adapter, driver) falls back to cpu — see kokoro-client-instance.
 */

import type { KokoroDevice, KokoroDtype } from "./kokoro-protocol.js";

export const KOKORO_VARIANT_STORAGE_KEY = "vibe-tavern.tts.kokoro-variant";

export type KokoroModelVariant = "gpu" | "cpu";

export interface KokoroVariantInfo {
  id: KokoroModelVariant;
  dtype: KokoroDtype;
  device: KokoroDevice;
  /** Approximate onnx-weights download size in MB, rounded. */
  approxMb: number;
}

export const KOKORO_VARIANTS: Record<KokoroModelVariant, KokoroVariantInfo> = {
  gpu: { id: "gpu", dtype: "fp32", device: "webgpu", approxMb: 310 },
  cpu: { id: "cpu", dtype: "q8", device: "wasm", approxMb: 90 },
};

export function isKokoroModelVariant(value: string | null): value is KokoroModelVariant {
  return value === "gpu" || value === "cpu";
}

/** Auto-pick when the user has not chosen yet: WebGPU when the browser has it. */
export function autoKokoroVariant(hasWebGpu: boolean): KokoroModelVariant {
  return hasWebGpu ? "gpu" : "cpu";
}

let webgpuForTests: boolean | null = null;

/** Test seam: force the WebGPU availability answer (null = real navigator). */
export function __setWebGpuForTests(value: boolean | null): void {
  webgpuForTests = value;
}

/** navigator.gpu presence. Chrome exposes it on window and dedicated workers
 *  alike, so the main-thread answer matches what the worker will see. */
export function detectWebGpu(): boolean {
  if (webgpuForTests !== null) return webgpuForTests;
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/** Effective load options for a variant (pure mapping). */
export function kokoroLoadOptionsFor(
  variant: KokoroModelVariant,
): { dtype: KokoroDtype; device: KokoroDevice } {
  const info = KOKORO_VARIANTS[variant];
  return { dtype: info.dtype, device: info.device };
}

// ─── localStorage edges (guarded: storage throws in some private modes) ─────

export function readStoredKokoroVariant(): KokoroModelVariant | null {
  try {
    const raw =
      typeof localStorage === "undefined" ? null : localStorage.getItem(KOKORO_VARIANT_STORAGE_KEY);
    return isKokoroModelVariant(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredKokoroVariant(variant: KokoroModelVariant): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KOKORO_VARIANT_STORAGE_KEY, variant);
  } catch {
    // Private-mode storage failures are non-fatal: this browser falls back to auto.
  }
}

export function clearStoredKokoroVariant(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(KOKORO_VARIANT_STORAGE_KEY);
  } catch {
    // See writeStoredKokoroVariant.
  }
}
