/**
 * Whisper STT Web Worker (STT_PLAN ST-3).
 *
 * Owns the transformers.js ASR pipeline off the main thread. The full
 * @huggingface/transformers stack (~WASM/ONNX runtime + weights) is loaded
 * ONLY as a worker entry and never imported from app code — the bundler
 * keeps it out of the main chunk (same rule as the Kokoro worker).
 *
 * Every huggingface.co download is rerouted to the server-side mirror
 * (ST-3 proxy rule: browser fetch cannot use the app proxy, the mirror can —
 * see whisper-mirror.ts). Audio arrives ALREADY DECODED from the client as
 * 16 kHz mono Float32Array PCM: AudioContext lives on the main thread only,
 * so decoding happens there (whisper-client.ts), not here.
 */

/// <reference lib="webworker" />
import { pipeline } from "@huggingface/transformers";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

import { buildWhisperAsrOptions } from "./whisper-asr-options.js";
import { rewriteWhisperHfUrl } from "./whisper-mirror.js";
import type { WhisperWorkerRequest, WhisperWorkerResponse } from "./whisper-protocol.js";

// Mirror reroute (F4 pattern — see whisper-mirror.ts module doc).
const directFetch = globalThis.fetch.bind(globalThis);
const mirroredFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const mirrored = rewriteWhisperHfUrl(url);
  if (mirrored !== null) {
    return directFetch(mirrored, init);
  }
  return directFetch(input, init);
};
// Keep the fetch namespace shape assignable to `typeof fetch` (same pattern
// as the Kokoro worker and the server-side proxied fetch).
mirroredFetch.preconnect = () => {};
globalThis.fetch = mirroredFetch;

interface LoadedModel {
  modelId: string;
  asr: AutomaticSpeechRecognitionPipeline;
}

let loaded: LoadedModel | null = null;
let loading: Promise<LoadedModel> | null = null;

async function ensureModel(
  modelId: string,
  dtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16",
  device: "wasm" | "webgpu",
  onProgress: (data: unknown) => void,
): Promise<LoadedModel> {
  if (loaded && loaded.modelId === modelId) return loaded;
  if (!loading) {
    loading = pipeline("automatic-speech-recognition", modelId, {
      dtype,
      device,
      progress_callback: (info: unknown) => onProgress(info),
    })
      .then((asr) => {
        const model: LoadedModel = { modelId, asr };
        loaded = model;
        return model;
      })
      .catch((cause: unknown) => {
        // Do not cache a failed load — the next request retries cleanly.
        loading = null;
        throw cause;
      });
  }
  return loading;
}

function post(response: WhisperWorkerResponse): void {
  self.postMessage(response);
}

function postError(requestId: number | undefined, name: string, message: string): void {
  post({ type: "error", id: requestId, name, message });
}

self.onmessage = async (event: MessageEvent<WhisperWorkerRequest>): Promise<void> => {
  const message = event.data;
  switch (message.type) {
    case "load": {
      try {
        await ensureModel(
          message.modelId,
          message.dtype,
          message.device,
          (data) => post({ type: "load-progress", data }),
        );
        post({ type: "loaded", modelId: message.modelId });
      } catch (error) {
        postError(
          undefined,
          "WhisperTranscribeError",
          `Model load failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    case "transcribe": {
      try {
        if (!loaded) {
          postError(message.id, "WhisperModelNotLoadedError", "Whisper model is not loaded — send a load request first.");
          return;
        }
        const options = buildWhisperAsrOptions(loaded.modelId, message.language);
        const output = await loaded.asr(message.audio, options);
        // Pipeline output is `{ text }` (timestamps off); the narrow check
        // keeps malformed outputs from crashing the worker.
        const text =
          typeof output === "object" && output !== null && "text" in output
            ? String(output.text)
            : String(output);
        post({ type: "transcribed", id: message.id, text });
      } catch (error) {
        postError(message.id, "WhisperTranscribeError", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    case "dispose": {
      // Drop references; the model cache lives in CacheStorage (browser-managed).
      loaded = null;
      loading = null;
      return;
    }
  }
};
