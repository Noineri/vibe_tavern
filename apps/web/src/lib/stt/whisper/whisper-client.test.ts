/**
 * WhisperSttClient tests (STT_PLAN ST-3): protocol round-trips against a
 * FAKE worker (no threads, no network) and a stubbed audio decoder (happy-dom
 * has no Web Audio). Mirrors the Kokoro client-test shape.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  WhisperSttClient,
  __setWhisperLoadStallMsForTests,
  type WorkerLike,
  type WorkerFactory,
} from "./whisper-client.js";
import { WhisperModelNotLoadedError, WhisperTranscribeError } from "./whisper-errors.js";
import type { WhisperWorkerRequest, WhisperWorkerResponse } from "./whisper-protocol.js";

/** Fake worker: records outbound requests; lets each test push responses. */
class FakeWorker implements WorkerLike {
  sent: WhisperWorkerRequest[] = [];
  #handlers: ((request: WhisperWorkerRequest) => void)[] = [];
  onmessage: ((event: MessageEvent<WhisperWorkerResponse>) => void) | null = null;

  postMessage(request: WhisperWorkerRequest): void {
    this.sent.push(request);
    for (const handler of [...this.#handlers]) handler(request);
  }
  terminate(): void {}

  /** Respond programmatically (as the real worker would). */
  respond(response: WhisperWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WhisperWorkerResponse>);
  }

  /** Auto-answer the next (or a matching) request; queue for later ones. */
  auto(handler: (request: WhisperWorkerRequest) => void): void {
    this.#handlers.push(handler);
  }
}

function makeClient(): { client: WhisperSttClient; worker: FakeWorker } {
  const worker = new FakeWorker();
  const factory: WorkerFactory = () => worker;
  const client = new WhisperSttClient(factory, {
    decodeAudio: async () => new Float32Array([0, 0.5, -0.5, 1]),
  });
  return { client, worker };
}

/** Drive load() to completion by answering the worker handshake. */
async function finishLoad(worker: FakeWorker, modelId = "onnx-community/whisper-base"): Promise<void> {
  await Bun.sleep(0);
  worker.respond({ type: "loaded", modelId });
}

afterEach(() => {
  __setWhisperLoadStallMsForTests(null);
});

describe("WhisperSttClient.load", () => {
  test("sends the load request with defaults (q8, wasm) and resolves on loaded", async () => {
    const { client, worker } = makeClient();
    const promise = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await promise;
    expect(client.isLoaded()).toBe(true);
    expect(client.getLoadedModelId()).toBe("onnx-community/whisper-base");
    const load = worker.sent.find((m) => m.type === "load");
    expect(load).toBeDefined();
    if (load?.type !== "load") return;
    expect(load.modelId).toBe("onnx-community/whisper-base");
    expect(load.dtype).toBe("q8");
    expect(load.device).toBe("wasm");
  });

  test("load error (worker error envelope, no id) rejects and clears the cached promise", async () => {
    const { client, worker } = makeClient();
    const promise = client.load("onnx-community/whisper-base");
    await Bun.sleep(0);
    worker.respond({
      type: "error",
      name: "WhisperTranscribeError",
      message: "Model load failed: network",
    });
    await expect(promise).rejects.toBeInstanceOf(WhisperTranscribeError);
    expect(client.isLoaded()).toBe(false);
    // A retry goes through the worker again (not a cached rejection).
    const retry = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await retry;
    expect(client.isLoaded()).toBe(true);
  });

  test("stall watchdog: no progress and no loaded within the window rejects", async () => {
    __setWhisperLoadStallMsForTests(20);
    const { client } = makeClient();
    const promise = client.load("onnx-community/whisper-base");
    await expect(promise).rejects.toBeInstanceOf(WhisperTranscribeError);
  });

  test("progress events re-arm the watchdog and reach subscribers", async () => {
    __setWhisperLoadStallMsForTests(30);
    const { client, worker } = makeClient();
    const seen: unknown[] = [];
    client.onLoadProgress((p) => seen.push(p.data));
    const promise = client.load("onnx-community/whisper-base");
    await Bun.sleep(0);
    worker.respond({ type: "load-progress", data: { file: "model.onnx", progress: 10 } });
    await Bun.sleep(25); // past the original window — progress re-armed it
    worker.respond({ type: "load-progress", data: { file: "model.onnx", progress: 80 } });
    worker.respond({ type: "loaded", modelId: "onnx-community/whisper-base" });
    await promise;
    expect(seen.length).toBe(2);
  });

  test("load of a DIFFERENT model while one is in flight chains (never resolves the wrong model)", async () => {
    const { client, worker } = makeClient();
    const first = client.load("onnx-community/whisper-base");
    const second = client.load("onnx-community/whisper-small");
    await Bun.sleep(0);
    // First handshake completes → the chained second load starts.
    worker.respond({ type: "loaded", modelId: "onnx-community/whisper-base" });
    await first;
    await Bun.sleep(0);
    worker.respond({ type: "loaded", modelId: "onnx-community/whisper-small" });
    await second;
    expect(client.getLoadedModelId()).toBe("onnx-community/whisper-small");
    const loads = worker.sent.filter((m): m is Extract<WhisperWorkerRequest, { type: "load" }> => m.type === "load");
    expect(loads.map((m) => m.modelId)).toEqual([
      "onnx-community/whisper-base",
      "onnx-community/whisper-small",
    ]);
  });

  test("dispose during an in-flight load: no resolve, no reject, a late loaded is a no-op", async () => {
    const { client, worker } = makeClient();
    const promise = client.load("onnx-community/whisper-base");
    client.dispose();
    worker.respond({ type: "loaded", modelId: "onnx-community/whisper-base" });
    // Neither resolves nor rejects after dispose; use a race-with-timeout probe.
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Bun.sleep(20);
    expect(settled).toBe(false);
    expect(client.isLoaded()).toBe(false);
  });
});

describe("WhisperSttClient.transcribeBlob", () => {
  test("without a load: typed not-loaded error, no worker round-trip", async () => {
    const { client, worker } = makeClient();
    await expect(client.transcribeBlob(new Blob(["x"]))).rejects.toBeInstanceOf(
      WhisperModelNotLoadedError,
    );
    expect(worker.sent.length).toBe(0);
  });

  test("round-trip: decodes, posts PCM + language, resolves the text", async () => {
    const { client, worker } = makeClient();
    const load = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await load;

    const blob = new Blob(["fake-webm-bytes"], { type: "audio/webm" });
    worker.auto((request) => {
      if (request.type === "transcribe") {
        worker.respond({ type: "transcribed", id: request.id, text: "привет мир" });
      }
    });
    const text = await client.transcribeBlob(blob, { language: "ru" });
    expect(text).toBe("привет мир");
    const transcribe = worker.sent.find((m) => m.type === "transcribe");
    expect(transcribe).toBeDefined();
    if (transcribe?.type !== "transcribe") return;
    expect(transcribe.language).toBe("ru");
    expect(transcribe.audio).toBeInstanceOf(Float32Array);
    expect(transcribe.audio.length).toBe(4);
  });

  test("empty language string is omitted from the request", async () => {
    const { client, worker } = makeClient();
    const load = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await load;
    worker.auto((request) => {
      if (request.type === "transcribe") {
        worker.respond({ type: "transcribed", id: request.id, text: "hi" });
      }
    });
    await client.transcribeBlob(new Blob(["x"]), { language: "" });
    const transcribe = worker.sent.find((m) => m.type === "transcribe");
    if (transcribe?.type !== "transcribe") throw new Error("no transcribe request");
    expect("language" in transcribe && transcribe.language !== undefined).toBe(false);
  });

  test("decoder failure wraps into WhisperTranscribeError", async () => {
    const worker = new FakeWorker();
    const client = new WhisperSttClient(() => worker, {
      decodeAudio: async () => {
        throw new Error("boom");
      },
    });
    const load = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await load;
    await expect(client.transcribeBlob(new Blob(["x"]))).rejects.toBeInstanceOf(
      WhisperTranscribeError,
    );
  });

  test("worker transcribe error rejects by correlation id and reconstructs the type", async () => {
    const { client, worker } = makeClient();
    const load = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await load;
    worker.auto((request) => {
      if (request.type === "transcribe") {
        worker.respond({
          type: "error",
          id: request.id,
          name: "WhisperTranscribeError",
          message: "pipeline blew up",
        });
      }
    });
    await expect(client.transcribeBlob(new Blob(["x"]))).rejects.toThrow("pipeline blew up");
  });
});

describe("WhisperSttClient.dispose", () => {
  test("dispose posts dispose, terminates, rejects pending transcriptions", async () => {
    const { client, worker } = makeClient();
    const load = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await load;

    let terminated = false;
    worker.terminate = () => {
      terminated = true;
    };
    const pending = client.transcribeBlob(new Blob(["x"]));
    client.dispose();
    await expect(pending).rejects.toThrow("Client disposed.");
    expect(terminated).toBe(true);
    expect(worker.sent.some((m) => m.type === "dispose")).toBe(true);
    expect(client.isLoaded()).toBe(false);
  });

  test("dispose racing the decode: the late-posted request rejects instead of hanging", async () => {
    const worker = new FakeWorker();
    const client = new WhisperSttClient(() => worker, {
      decodeAudio: async () => {
        await Bun.sleep(5);
        return new Float32Array([0, 1]);
      },
    });
    const load = client.load("onnx-community/whisper-base");
    await finishLoad(worker);
    await load;
    const pending = client.transcribeBlob(new Blob(["x"]));
    client.dispose(); // before the decoder resolves
    await expect(pending).rejects.toThrow("Client disposed.");
  });
});
