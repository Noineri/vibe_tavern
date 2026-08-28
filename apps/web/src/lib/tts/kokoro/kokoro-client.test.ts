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

  test("lazy worker: constructor never spawns, throwing factory rejects load instead of crashing", async () => {
    // The client is constructed while a component RENDERS (shared singleton
    // via getSharedKokoroClient) — a synchronous `new Worker` throw there
    // used to unmount the whole React tree (dev server file:// origin).
    let spawned = 0;
    const client = new KokoroTtsClient(() => {
      spawned++;
      throw new Error("SecurityError: Failed to construct 'Worker'");
    });
    expect(spawned).toBe(0); // constructor must not call the factory
    await expect(client.load()).rejects.toThrow("SecurityError");
    expect(spawned).toBe(1);
    // A later retry goes through the factory again (no cached broken worker).
    await expect(client.load()).rejects.toThrow("SecurityError");
    expect(spawned).toBe(2);
  });

  test("load-progress events reach subscribers and stop after unsubscribe", async () => {
    const { client, emit } = makeClient();
    const seen: unknown[] = [];
    const unsubscribe = client.onLoadProgress((p) => seen.push(p.data));

    // Lazy worker (SecurityError guard): the message handler is wired on
    // first use, so start a load to bring the worker up before emitting.
    void client.load().catch(() => {});

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

  test("generateChunked round-trip: sequential requests per chunk, ONE WAV with concatenated PCM", async () => {
    const { client, requests, emit } = makeClient();
    const loadPromise = client.load();
    emit({ type: "loaded" });
    await loadPromise;

    const outputPromise = client.generateChunked(
      [
        { text: "Hello there.", voiceId: "af_heart" },
        { text: "General Kenobi!", voiceId: "af_heart" },
      ],
      1.0,
    );
    // Two microtask rounds: chunk 1 request flushes, is answered, then chunk 2.
    for (let step = 0; step < 2; step++) {
      await Promise.resolve();
      const pending = requests.filter((r) => r.type === "generate")[step];
      expect(pending).toBeDefined();
      const pcm = step === 0 ? new Float32Array([0, 0.25]) : new Float32Array([-0.5, 0.5, -1]);
      emit({ type: "generated", id: (pending as { id: number }).id, audio: pcm, sampleRate: 24000 });
      await Promise.resolve();
    }
    const output = await outputPromise;

    // One generate request per chunk, in order, carrying the exact texts.
    const gens = requests.filter((r) => r.type === "generate");
    expect(gens.map((r) => (r as { text: string }).text)).toEqual(["Hello there.", "General Kenobi!"]);

    // The blob is a single WAV whose PCM is chunk1 ++ chunk2.
    expect(output.sampleRate).toBe(24000);
    expect(output.blob.type).toBe("audio/wav");
    const bytes = new Uint8Array(await output.blob.arrayBuffer());
    expect(bytes.byteLength).toBe(44 + 5 * 2); // 2 + 3 samples, 16-bit
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    const view = new DataView(bytes.buffer);
    const read = (i: number) => view.getInt16(44 + i * 2, true);
    // float32-to-wav convention: negative samples scale by 0x8000, positive by 0x7fff.
    expect(read(0)).toBe(0);
    expect(read(1)).toBe(Math.round(0.25 * 0x7fff));
    expect(read(2)).toBe(Math.round(-0.5 * 0x8000));
    expect(read(3)).toBe(Math.round(0.5 * 0x7fff));
    expect(read(4)).toBe(-0x8000); // -1 clamps
  });

  test("generateChunked: per-chunk voices are carried into each worker request", async () => {
    const { client, requests, emit } = makeClient();
    const loadPromise = client.load();
    emit({ type: "loaded" });
    await loadPromise;

    const outputPromise = client.generateChunked(
      [
        { text: "hello", voiceId: "af_heart" },
        { text: "world", voiceId: "af_bella" },
      ],
      1.0,
    );
    for (let step = 0; step < 2; step++) {
      await Promise.resolve();
      const pending = requests.filter((r) => r.type === "generate")[step];
      expect(pending).toBeDefined();
      const expectedVoice = step === 0 ? "af_heart" : "af_bella";
      expect((pending as { voice: string }).voice).toBe(expectedVoice);
      emit({ type: "generated", id: (pending as { id: number }).id, audio: new Float32Array([0.1]), sampleRate: 24000 });
      await Promise.resolve();
    }
    const out = await outputPromise;
    expect(out.blob.type).toBe("audio/wav");
  });

  test("generateChunked: a mid-chunk worker failure rejects the whole call", async () => {
    const { client, requests, emit } = makeClient();
    const loadPromise = client.load();
    emit({ type: "loaded" });
    await loadPromise;

    const outputPromise = client.generateChunked(
      [
        { text: "first", voiceId: "af_heart" },
        { text: "second", voiceId: "af_heart" },
      ],
    );
    await Promise.resolve();
    emit({ type: "generated", id: (requests.at(-1) as { id: number }).id, audio: new Float32Array([0.5]), sampleRate: 24000 });
    await Promise.resolve();
    await Promise.resolve();
    const second = requests.at(-1) as { id: number };
    emit({ type: "error", id: second.id, name: "KokoroGenerateError", message: "wasm exploded" });

    await expect(outputPromise).rejects.toBeInstanceOf(KokoroGenerateError);
    await expect(outputPromise).rejects.toThrow("wasm exploded");
  });

  test("generateChunked: empty or all-empty input is a typed error; single chunk behaves like generate", async () => {
    const { client, requests, emit } = makeClient();
    const loadPromise = client.load();
    emit({ type: "loaded" });
    await loadPromise;

    await expect(client.generateChunked([], 1.0)).rejects.toBeInstanceOf(KokoroGenerateError);
    await expect(
      client.generateChunked(
        [
          { text: "", voiceId: "af_heart" },
          { text: "", voiceId: "af_heart" },
        ],
        1.0,
      ),
    ).rejects.toBeInstanceOf(KokoroGenerateError);
    // Also rejects before any round-trip when the voice is not loaded-eligible.
    expect(requests.filter((r) => r.type === "generate")).toHaveLength(0);

    const single = client.generateChunked([{ text: "one liner", voiceId: "af_heart" }]);
    await Promise.resolve();
    const request = requests.at(-1) as { id: number; text: string };
    expect(request.text).toBe("one liner");
    emit({ type: "generated", id: request.id, audio: new Float32Array([0.1, -0.1]), sampleRate: 24000 });
    const out = await single;
    expect(new Uint8Array(await out.blob.arrayBuffer()).byteLength).toBe(44 + 2 * 2);
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

// ─── Load stall watchdog ("Послушать виснет" fix) ────────────────────────────

import { __setKokoroLoadStallMsForTests } from "./kokoro-client.js";

describe("load stall watchdog", () => {
  test("silence beyond the stall window rejects the load with a diagnosable error", async () => {
    __setKokoroLoadStallMsForTests(20);
    try {
      const { client, requests } = makeClient();
      const promise = client.load();
      // No progress, no loaded — a blackholed huggingface.co connection.
      await expect(promise).rejects.toThrow(/stalled.*huggingface\.co/s);
      // The failed load is not cached — a retry re-posts the load request.
      void client.load();
      expect(requests.filter((r) => r.type === "load")).toHaveLength(2);
      // Tear down: the retry's watchdog must not fire into the next test as
      // an unhandled rejection.
      client.dispose();
    } finally {
      __setKokoroLoadStallMsForTests(null);
    }
  });

  test("progress events push the window out — a slow-but-alive download never trips", async () => {
    __setKokoroLoadStallMsForTests(120);
    try {
      const { client, emit } = makeClient();
      const promise = client.load();
      // Two progress ticks straddling the stall window: still alive.
      await new Promise((r) => setTimeout(r, 80));
      emit({ type: "load-progress", data: { status: "progress", progress: 10 } });
      await new Promise((r) => setTimeout(r, 80));
      emit({ type: "load-progress", data: { status: "progress", progress: 60 } });
      await new Promise((r) => setTimeout(r, 40));
      expect(client.isLoaded()).toBe(false); // still loading, NOT rejected
      emit({ type: "loaded" });
      await promise; // resolves normally
      expect(client.isLoaded()).toBe(true);
    } finally {
      __setKokoroLoadStallMsForTests(null);
    }
  });

  test("dispose clears the watchdog — no late rejection after teardown", async () => {
    __setKokoroLoadStallMsForTests(15);
    try {
      const { client } = makeClient();
      let rejected = false;
      client.load().catch(() => {
        rejected = true;
      });
      client.dispose();
      // Wait PAST the stall window: the timer was cleared by dispose, so the
      // load promise must stay pending (no late rejection firing into a torn
      // down client).
      await new Promise((r) => setTimeout(r, 40));
      expect(rejected).toBe(false);
    } finally {
      __setKokoroLoadStallMsForTests(null);
    }
  });
});
