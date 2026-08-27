import { describe, expect, test } from "bun:test";

import {
  KokoroGenerateError,
  KokoroModelNotLoadedError,
  KokoroVoiceNotFoundError,
} from "./kokoro-errors.js";
import { float32ToWavBytes } from "./float32-to-wav.js";
import { KokoroTtsClient, type WorkerFactory, type WorkerLike } from "./kokoro-client.js";
import type { KokoroWorkerRequest, KokoroWorkerResponse } from "./kokoro-protocol.js";

// ─── Fake worker ─────────────────────────────────────────────────────────────

/** Scriptable fake: records posted requests, lets tests emit responses. */
function makeFakeWorker(): { worker: WorkerLike; requests: KokoroWorkerRequest[]; emit: (r: KokoroWorkerResponse) => void } {
  const requests: KokoroWorkerRequest[] = [];
  let handler: ((event: MessageEvent<KokoroWorkerResponse>) => void) | null = null;
  const worker: WorkerLike = {
    postMessage(request) {
      requests.push(request);
    },
    terminate() {
      handler = null;
    },
    set onmessage(h) {
      handler = h;
    },
    get onmessage() {
      return handler;
    },
  };
  const emit = (response: KokoroWorkerResponse) => {
    handler?.(new MessageEvent("message", { data: response }));
  };
  return { worker, requests, emit };
}

function makeClient(): { client: KokoroTtsClient; requests: KokoroWorkerRequest[]; emit: (r: KokoroWorkerResponse) => void } {
  const fake = makeFakeWorker();
  const factory: WorkerFactory = () => fake.worker;
  const client = new KokoroTtsClient(factory);
  return { client, requests: fake.requests, emit: fake.emit };
}

// ─── float32ToWavBytes ────────────────────────────────────────────────────────

describe("float32ToWavBytes", () => {
  test("emits a 44-byte RIFF/WAVE header with mono/16-bit/sample-rate fields", () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = float32ToWavBytes(pcm, 24000);

    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    // Sample rate (LE at offset 24) and channels (offset 22) / bits (offset 34).
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
  });

  test("clamps to [-1,1] and maps non-finite samples to silence", () => {
    const pcm = new Float32Array([2, -2, Number.NaN, Number.POSITIVE_INFINITY]);
    const wav = float32ToWavBytes(pcm, 16000);
    const view = new DataView(wav.buffer);
    const read = (i: number) => view.getInt16(44 + i * 2, true);
    expect(read(0)).toBe(0x7fff); // +1 clamped, positive full-scale
    expect(read(1)).toBe(-0x8000); // -1 clamped, negative full-scale
    expect(read(2)).toBe(0); // NaN -> silence
    expect(read(3)).toBe(0); // +Inf -> silence
  });
});

// ─── KokoroTtsClient (fake worker — no threads, no network) ──────────────────

describe("KokoroTtsClient", () => {
  test("load posts the load request and resolves on loaded; idempotent", async () => {
    const { client, requests, emit } = makeClient();

    const first = client.load("q8", "wasm");
    const second = client.load("q8", "wasm"); // concurrent — shares one promise
    expect(requests).toEqual([{ type: "load", dtype: "q8", device: "wasm" }]);

    emit({ type: "loaded" });
    await Promise.all([first, second]);
    expect(client.isLoaded()).toBe(true);

    await client.load(); // after loaded — no new request
    expect(requests).toHaveLength(1);
  });

  test("load failure clears the shared promise so a retry re-posts", async () => {
    const { client, requests, emit } = makeClient();

    const first = client.load();
    emit({ type: "error", name: "KokoroGenerateError", message: "boom" });
    await expect(first).rejects.toBeInstanceOf(KokoroGenerateError);
    expect(client.isLoaded()).toBe(false);

    const retry = client.load();
    emit({ type: "loaded" });
    await retry;
    expect(requests).toHaveLength(2);
  });

  test("load-progress events reach subscribers and stop after unsubscribe", async () => {
    const { client, emit } = makeClient();
    const seen: unknown[] = [];
    const unsubscribe = client.onLoadProgress((p) => seen.push(p.data));

    emit({ type: "load-progress", data: { file: "model.onnx", progress: 42 } });
    expect(seen).toEqual([{ file: "model.onnx", progress: 42 }]);

    unsubscribe();
    emit({ type: "load-progress", data: { progress: 100 } });
    expect(seen).toHaveLength(1);
  });

  test("generate validates eagerly: unknown voice, non-English voice, not-loaded", async () => {
    const { client } = makeClient();

    await expect(client.generate("hi", "af_nope")).rejects.toBeInstanceOf(KokoroVoiceNotFoundError);
    // Japanese voice exists in the manifest but not in the in-browser engine.
    await expect(client.generate("hi", "jf_alpha")).rejects.toBeInstanceOf(KokoroGenerateError);
    // Known English voice, but the model is not loaded yet.
    await expect(client.generate("hi", "af_heart")).rejects.toBeInstanceOf(KokoroModelNotLoadedError);
  });

  test("generate round-trip: posts request, resolves with a WAV blob", async () => {
    const { client, requests, emit } = makeClient();
    const loadPromise = client.load();
    emit({ type: "loaded" });
    await loadPromise;

    const outputPromise = client.generate("Hello", "af_bella", 1.2);
    await Promise.resolve(); // let the request flush into the fake
    const request = requests.at(-1);
    expect(request).toMatchObject({ type: "generate", text: "Hello", voice: "af_bella", speed: 1.2 });

    emit({ type: "generated", id: (request as { id: number }).id, audio: new Float32Array([0, 0.5]), sampleRate: 24000 });
    const output = await outputPromise;

    expect(output.sampleRate).toBe(24000);
    expect(output.blob.type).toBe("audio/wav");
    const bytes = new Uint8Array(await output.blob.arrayBuffer());
    expect(bytes.byteLength).toBe(44 + 4);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
  });

  test("worker error envelope reconstructs the typed error class", async () => {
    const { client, emit } = makeClient();
    const loadPromise = client.load();
    emit({ type: "loaded" });
    await loadPromise;

    const outputPromise = client.generate("Hello", "af_heart");
    await Promise.resolve();
    emit({ type: "error", id: 1, name: "KokoroModelNotLoadedError", message: "gone" });
    await expect(outputPromise).rejects.toBeInstanceOf(KokoroModelNotLoadedError);
    await expect(outputPromise).rejects.toThrow("gone");
  });

  test("dispose rejects pending generates and terminates", async () => {
    const { client, emit } = makeClient();
    const loadPromise = client.load();
    emit({ type: "loaded" });
    await loadPromise;

    const outputPromise = client.generate("Hello", "af_heart");
    const observed = outputPromise.then(
      () => undefined,
      () => undefined,
    );
    client.dispose();
    await observed;
    await expect(outputPromise).rejects.toBeInstanceOf(KokoroGenerateError);
  });
});
