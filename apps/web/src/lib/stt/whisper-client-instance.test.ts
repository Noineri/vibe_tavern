/**
 * whisper-client-instance tests — the GPU lane (owner decision 2026-09-05):
 * lane selection (WebGPU available → webgpu/fp16; absent → wasm/q8 direct),
 * the gpu→cpu fallback (a failed fp16 load retries as wasm/q8, once per
 * ensure), same-model join (concurrent callers share ONE load chain, the
 * fallback runs once), and the failed-ensure memo reset (a retry after both
 * lanes died re-issues a load instead of re-rejecting). Mirrors the fake-
 * worker pattern of kokoro-client-instance.test.ts; no DOM beyond
 * MessageEvent.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import type { WorkerLike } from "./whisper/whisper-client.js";
import type { WhisperLoadRequest, WhisperWorkerResponse } from "./whisper/whisper-protocol.js";
import {
  __setWhisperLaneProbeForTests,
  __setWhisperWorkerFactoryForTests,
  currentWhisperLane,
  ensureSharedWhisperModel,
} from "./whisper-client-instance.js";

/** Scriptable fake worker: records every load request; per-request policy
 *  resolves ("ok") or rejects with a worker error envelope (a failed GPU
 *  lane, a dead CPU lane). */
interface FakeWorkerHandle {
  factory: () => WorkerLike;
  requests: WhisperLoadRequest[];
}

function makeFakeWorker(
  policy: (request: WhisperLoadRequest) => "ok" | { message: string },
): FakeWorkerHandle {
  const requests: WhisperLoadRequest[] = [];
  return {
    requests,
    factory: () => {
      const worker: WorkerLike = {
        postMessage(request) {
          if (request.type !== "load") return;
          requests.push(request);
          const verdict = policy(request);
          queueMicrotask(() => {
            if (worker.onmessage === null) return;
            const response: WhisperWorkerResponse =
              verdict === "ok"
                ? { type: "loaded", modelId: request.modelId }
                : { type: "error", name: "WhisperTranscribeError", message: verdict.message };
            worker.onmessage(new MessageEvent("message", { data: response }));
          });
        },
        terminate() {},
        set onmessage(handler) {
          this._handler = handler;
        },
        get onmessage() {
          return this._handler;
        },
        _handler: null,
      } as WorkerLike & { _handler: ((event: MessageEvent<WhisperWorkerResponse>) => void) | null };
      return worker;
    },
  };
}

const BASE = "onnx-community/whisper-base";

describe("whisper GPU lane (ensureSharedWhisperModel)", () => {
  beforeEach(() => {
    __setWhisperLaneProbeForTests(null);
  });

  afterEach(() => {
    __setWhisperWorkerFactoryForTests(null);
    __setWhisperLaneProbeForTests(null);
  });

  test("lane probe: currentWhisperLane reads the probe, then the browser fact", () => {
    expect(currentWhisperLane()).toBe("wasm"); // happy-dom has no navigator.gpu
    __setWhisperLaneProbeForTests(() => "webgpu");
    expect(currentWhisperLane()).toBe("webgpu");
  });

  test("WebGPU available: loads fp16 on webgpu — no wasm request", async () => {
    const fake = makeFakeWorker(() => "ok");
    __setWhisperWorkerFactoryForTests(fake.factory);
    __setWhisperLaneProbeForTests(() => "webgpu");
    await ensureSharedWhisperModel(BASE);
    expect(fake.requests.length).toBe(1);
    expect(fake.requests[0]).toMatchObject({ modelId: BASE, device: "webgpu", dtype: "fp16" });
  });

  test("GPU lane fails → falls back to wasm/q8 exactly once", async () => {
    const fake = makeFakeWorker((request) => (request.device === "webgpu" ? { message: "adapter blocklisted" } : "ok"));
    __setWhisperWorkerFactoryForTests(fake.factory);
    __setWhisperLaneProbeForTests(() => "webgpu");
    await ensureSharedWhisperModel(BASE);
    expect(fake.requests.map((r) => r.device)).toEqual(["webgpu", "wasm"]);
    expect(fake.requests[1]).toMatchObject({ modelId: BASE, dtype: "q8" });
  });

  test("no WebGPU: goes straight to wasm/q8", async () => {
    const fake = makeFakeWorker(() => "ok");
    __setWhisperWorkerFactoryForTests(fake.factory);
    __setWhisperLaneProbeForTests(() => "wasm");
    await ensureSharedWhisperModel(BASE);
    expect(fake.requests.length).toBe(1);
    expect(fake.requests[0]).toMatchObject({ device: "wasm", dtype: "q8" });
  });

  test("concurrent same-model ensures join ONE chain — the fallback runs once, not per caller", async () => {
    const fake = makeFakeWorker((request) => (request.device === "webgpu" ? { message: "boom" } : "ok"));
    __setWhisperWorkerFactoryForTests(fake.factory);
    __setWhisperLaneProbeForTests(() => "webgpu");
    const [a, b] = await Promise.all([ensureSharedWhisperModel(BASE), ensureSharedWhisperModel(BASE)]);
    expect(a).toBe(b);
    expect(fake.requests.map((r) => r.device)).toEqual(["webgpu", "wasm"]);
  });

  test("both lanes fail → ensure rejects; a retry re-issues loads (memo reset)", async () => {
    const fake = makeFakeWorker(() => ({ message: "network down" }));
    __setWhisperWorkerFactoryForTests(fake.factory);
    await expect(ensureSharedWhisperModel(BASE)).rejects.toThrow("network down");
    const fake2 = makeFakeWorker(() => "ok");
    __setWhisperWorkerFactoryForTests(fake2.factory);
    await expect(ensureSharedWhisperModel(BASE)).resolves.toBeTruthy();
    expect(fake2.requests.length).toBe(1);
  });
});
