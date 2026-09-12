import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { useDomEnv } from "../../../../test/dom-env.js";

// Variant persistence pins touch localStorage — happy-dom provides it.
useDomEnv();

import {
  KOKORO_VARIANT_STORAGE_KEY,
  __setWebGpuForTests,
  clearStoredKokoroVariant,
} from "./kokoro-load-options.js";
import type { KokoroWorkerRequest, KokoroWorkerResponse } from "./kokoro-protocol.js";
import {
  __resetSharedKokoroClientForTests,
  __setKokoroWorkerFactoryForTests,
  consumeKokoroFallbackNotice,
  ensureSharedKokoroModel,
  getActiveKokoroVariant,
  loadSharedKokoroModel,
} from "./kokoro-client-instance.js";

/**
 * Scriptable fake worker: answers load requests per a configurable policy
 * (fail webgpu loads to simulate a blocklisted adapter), records every
 * request. Mirrors the fake-worker pattern of kokoro-client.test.ts, plus a
 * constructor/terminate counter so reset behavior is observable.
 */
function makeFakeWorker(
  loadPolicy: (request: KokoroWorkerRequest & { type: "load" }) => "ok" | Error = () => "ok",
): {
  factory: () => {
    postMessage(request: KokoroWorkerRequest): void;
    terminate(): void;
    onmessage: ((event: MessageEvent<KokoroWorkerResponse>) => void) | null;
  };
  requests: KokoroWorkerRequest[];
  created: () => number;
  terminated: () => number;
} {
  const requests: KokoroWorkerRequest[] = [];
  let created = 0;
  let terminated = 0;
  const factory = () => {
    created += 1;
    let handler: ((event: MessageEvent<KokoroWorkerResponse>) => void) | null = null;
    const emit = (response: KokoroWorkerResponse): void => {
      handler?.(new MessageEvent("message", { data: response }));
    };
    return {
      postMessage(request: KokoroWorkerRequest): void {
        requests.push(request);
        if (request.type === "load") {
          const policy = loadPolicy(request);
          queueMicrotask(() => {
            if (policy instanceof Error) {
              emit({ type: "error", name: "KokoroGenerateError", message: policy.message });
            } else {
              emit({ type: "loaded" });
            }
          });
        }
      },
      terminate(): void {
        terminated += 1;
        handler = null;
      },
      set onmessage(h: ((event: MessageEvent<KokoroWorkerResponse>) => void) | null) {
        handler = h;
      },
      get onmessage() {
        return handler;
      },
    };
  };
  return { factory, requests, created: () => created, terminated: () => terminated };
}

function loadRequests(requests: KokoroWorkerRequest[]): { dtype: string; device: string }[] {
  return requests
    .filter((r): r is KokoroWorkerRequest & { type: "load" } => r.type === "load")
    .map((r) => ({ dtype: r.dtype, device: r.device }));
}

beforeEach(() => {
  clearStoredKokoroVariant();
  __setWebGpuForTests(false);
  __setKokoroWorkerFactoryForTests(null);
  __resetSharedKokoroClientForTests();
});

afterEach(() => {
  clearStoredKokoroVariant();
  __setWebGpuForTests(null);
  __setKokoroWorkerFactoryForTests(null);
  __resetSharedKokoroClientForTests();
});

describe("kokoro-client-instance variant orchestration", () => {
  test("ensure with no stored choice and no WebGPU loads q8/wasm (auto = cpu)", async () => {
    const fake = makeFakeWorker();
    __setKokoroWorkerFactoryForTests(fake.factory);

    const client = await ensureSharedKokoroModel();

    expect(client.isLoaded()).toBe(true);
    expect(loadRequests(fake.requests)).toEqual([{ dtype: "q8", device: "wasm" }]);
    expect(getActiveKokoroVariant()).toBe("cpu");
    // No explicit choice was persisted by an auto pick.
    expect(localStorage.getItem(KOKORO_VARIANT_STORAGE_KEY)).toBeNull();
    expect(consumeKokoroFallbackNotice()).toBeNull();
  });

  test("ensure with WebGPU auto-picks gpu (fp32/webgpu)", async () => {
    __setWebGpuForTests(true);
    const fake = makeFakeWorker();
    __setKokoroWorkerFactoryForTests(fake.factory);

    await ensureSharedKokoroModel();

    expect(loadRequests(fake.requests)).toEqual([{ dtype: "fp32", device: "webgpu" }]);
    expect(getActiveKokoroVariant()).toBe("gpu");
  });

  test("stored choice wins over the auto pick", async () => {
    __setWebGpuForTests(true);
    localStorage.setItem(KOKORO_VARIANT_STORAGE_KEY, "cpu"); // small laptop choice
    const fake = makeFakeWorker();
    __setKokoroWorkerFactoryForTests(fake.factory);

    await ensureSharedKokoroModel();

    expect(loadRequests(fake.requests)).toEqual([{ dtype: "q8", device: "wasm" }]);
  });

  test("failed WebGPU load falls back to cpu, persists it, leaves a one-shot notice", async () => {
    __setWebGpuForTests(true);
    const fake = makeFakeWorker((request) =>
      request.device === "webgpu" ? new Error("adapter is blocklisted") : "ok",
    );
    __setKokoroWorkerFactoryForTests(fake.factory);

    const client = await ensureSharedKokoroModel();

    // Attempted webgpu, then loaded the cpu variant.
    expect(loadRequests(fake.requests)).toEqual([
      { dtype: "fp32", device: "webgpu" },
      { dtype: "q8", device: "wasm" },
    ]);
    expect(client.isLoaded()).toBe(true);
    expect(getActiveKokoroVariant()).toBe("cpu");
    // The working choice is persisted so the next boot skips the broken path…
    expect(localStorage.getItem(KOKORO_VARIANT_STORAGE_KEY)).toBe("cpu");
    // …and the panel gets exactly one explanatory notice.
    expect(consumeKokoroFallbackNotice()).toContain("blocklisted");
    expect(consumeKokoroFallbackNotice()).toBeNull();

    // Next ensure joins the already-loaded cpu client (no new requests).
    await ensureSharedKokoroModel();
    expect(loadRequests(fake.requests)).toHaveLength(2);
  });

  test("cpu load failure is NOT masked by any fallback — the error propagates", async () => {
    const fake = makeFakeWorker(() => new Error("huggingface.co unreachable"));
    __setKokoroWorkerFactoryForTests(fake.factory);

    await expect(ensureSharedKokoroModel()).rejects.toThrow("huggingface.co");
    expect(getActiveKokoroVariant()).toBeNull();
  });

  test("loadSharedKokoroModel (panel switch) persists the choice, resets the old client, loads the new one", async () => {
    const fake = makeFakeWorker();
    __setKokoroWorkerFactoryForTests(fake.factory);

    // First load (auto cpu in this environment), then the user switches to gpu.
    await ensureSharedKokoroModel();
    expect(fake.terminated()).toBe(0);
    expect(fake.created()).toBe(1);

    await loadSharedKokoroModel("gpu");

    expect(localStorage.getItem(KOKORO_VARIANT_STORAGE_KEY)).toBe("gpu");
    expect(loadRequests(fake.requests)).toEqual([
      { dtype: "q8", device: "wasm" },
      { dtype: "fp32", device: "webgpu" },
    ]);
    expect(getActiveKokoroVariant()).toBe("gpu");
    // The switch disposed the old worker thread and created a fresh one.
    expect(fake.terminated()).toBe(1);
    expect(fake.created()).toBe(2);
  });

  test("switching to gpu on a broken adapter lands on cpu with a notice", async () => {
    const fake = makeFakeWorker((request) =>
      request.device === "webgpu" ? new Error("webgpu crashed") : "ok",
    );
    __setKokoroWorkerFactoryForTests(fake.factory);

    const client = await loadSharedKokoroModel("gpu");

    expect(client.isLoaded()).toBe(true);
    expect(getActiveKokoroVariant()).toBe("cpu");
    expect(localStorage.getItem(KOKORO_VARIANT_STORAGE_KEY)).toBe("cpu");
    expect(consumeKokoroFallbackNotice()).toContain("webgpu crashed");
  });
});
