import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { useDomEnv } from "../../../../test/dom-env.js";

// Storage round-trip needs a real localStorage — happy-dom provides it (the
// repo's single DOM-env mechanism; per-file runner isolates the process).
useDomEnv();

import {
  KOKORO_VARIANTS,
  KOKORO_VARIANT_STORAGE_KEY,
  __setWebGpuForTests,
  autoKokoroVariant,
  clearStoredKokoroVariant,
  detectWebGpu,
  isKokoroModelVariant,
  kokoroLoadOptionsFor,
  readStoredKokoroVariant,
  writeStoredKokoroVariant,
} from "./kokoro-load-options.js";

beforeEach(() => {
  __setWebGpuForTests(null);
  clearStoredKokoroVariant();
});

afterEach(() => {
  __setWebGpuForTests(null);
  clearStoredKokoroVariant();
});

describe("kokoro-load-options (pure)", () => {
  test("two variants map to the official dtype/device guidance", () => {
    // kokoro-js README: webgpu → dtype fp32; wasm → q8.
    expect(kokoroLoadOptionsFor("gpu")).toEqual({ dtype: "fp32", device: "webgpu" });
    expect(kokoroLoadOptionsFor("cpu")).toEqual({ dtype: "q8", device: "wasm" });
    expect(KOKORO_VARIANTS.gpu.approxMb).toBeGreaterThan(KOKORO_VARIANTS.cpu.approxMb);
  });

  test("auto pick: gpu when WebGPU, cpu otherwise", () => {
    expect(autoKokoroVariant(true)).toBe("gpu");
    expect(autoKokoroVariant(false)).toBe("cpu");
  });

  test("variant guard accepts only the two ids", () => {
    expect(isKokoroModelVariant("gpu")).toBe(true);
    expect(isKokoroModelVariant("cpu")).toBe(true);
    expect(isKokoroModelVariant("fp16")).toBe(false);
    expect(isKokoroModelVariant(null)).toBe(false);
  });

  test("stored variant round-trips; garbage reads as null (auto)", () => {
    expect(readStoredKokoroVariant()).toBeNull();
    writeStoredKokoroVariant("gpu");
    expect(localStorage.getItem(KOKORO_VARIANT_STORAGE_KEY)).toBe("gpu");
    expect(readStoredKokoroVariant()).toBe("gpu");
    localStorage.setItem(KOKORO_VARIANT_STORAGE_KEY, "bogus");
    expect(readStoredKokoroVariant()).toBeNull();
    clearStoredKokoroVariant();
    expect(readStoredKokoroVariant()).toBeNull();
  });

  test("detectWebGpu honors the test seam and falls back to navigator", () => {
    __setWebGpuForTests(true);
    expect(detectWebGpu()).toBe(true);
    __setWebGpuForTests(false);
    expect(detectWebGpu()).toBe(false);
    __setWebGpuForTests(null);
    // Bun's navigator has no WebGPU — the honest main-process answer is false.
    expect(detectWebGpu()).toBe(false);
  });
});
