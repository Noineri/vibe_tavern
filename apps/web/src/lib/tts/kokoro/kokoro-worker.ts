/**
 * Kokoro TTS Web Worker (TTS_PLAN TS-3b).
 *
 * Owns the kokoro-js model instance off the main thread. kokoro-js pulls the
 * full @huggingface/transformers stack (~WASM runtime + ONNX weights), so this
 * module is loaded ONLY as a classic worker entry and never imported from app
 * code — the bundler keeps the whole stack out of the main chunk. The client
 * (`kokoro-client.ts`) talks to this worker via `kokoro-protocol.ts` messages.
 *
 * Voice scope: the npm kokoro-js 1.2.1 dist hard-validates against its 28
 * ENGLISH voices (`_validate_voice` throws otherwise; the phonemizer is
 * en-us/en only), so only ids from the English subset of the manifest are
 * accepted here — matching the owner's English-only narration decision. The
 * full 54-voice roster stays available through server-side kokoro-fastapi.
 */

/// <reference lib="webworker" />
import { KokoroTTS } from "kokoro-js";
import type { GenerateOptions } from "kokoro-js";

import { tryResolveKokoroVoice } from "../kokoro-voices.js";
import { KokoroGenerateError, KokoroModelNotLoadedError } from "./kokoro-errors.js";
import { rewriteHfUrl } from "./kokoro-mirror.js";
import type {
  KokoroDevice,
  KokoroDtype,
  KokoroWorkerRequest,
  KokoroWorkerResponse,
} from "./kokoro-protocol.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// F4: every huggingface.co download (transformers.js model files AND the
// voice blobs kokoro-js fetches from a hardcoded dist URL) is rerouted to the
// server-side mirror, which uses the app's proxy. Browser fetch cannot use
// the env/app proxy at all, so the direct HF path silently stalls in
// geo-blocked regions. See ./kokoro-mirror.ts for why this is a fetch wrap.
const directFetch = globalThis.fetch.bind(globalThis);
const mirroredFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const mirrored = rewriteHfUrl(url);
  if (mirrored !== null) {
    return directFetch(mirrored, init);
  }
  return directFetch(input, init);
};
// Keep the fetch namespace shape assignable to `typeof fetch` (same pattern
// as the server-side proxied fetch in provider-fetch-factory.ts).
mirroredFetch.preconnect = () => {};
globalThis.fetch = mirroredFetch;

let tts: KokoroTTS | null = null;
let loading: Promise<KokoroTTS> | null = null;

/** English-only ids the dist can actually synthesize (see module doc). */
function isSynthesizableVoice(id: string): boolean {
  const voice = tryResolveKokoroVoice(id);
  return voice !== null && (voice.lang === "a" || voice.lang === "b");
}

async function ensureModel(
  dtype: KokoroDtype,
  device: KokoroDevice,
  onProgress: (data: unknown) => void,
): Promise<KokoroTTS> {
  if (tts) return tts;
  if (!loading) {
    loading = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype,
      device,
      progress_callback: (info: unknown) => onProgress(info),
    })
      .then((instance) => {
        tts = instance;
        return instance;
      })
      .catch((cause: unknown) => {
        // Do not cache a failed load — the next request retries cleanly.
        loading = null;
        throw cause;
      });
  }
  return loading;
}

// Request/response unions come from the shared protocol module (type-only —
// erased at build; the worker stays a standalone Vite chunk).

function post(response: KokoroWorkerResponse): void {
  self.postMessage(response);
}

function postError(requestId: number | undefined, name: string, message: string, voiceId?: string): void {
  post({ type: "error", id: requestId, name, message, ...(voiceId !== undefined ? { voiceId } : {}) });
}

self.onmessage = async (event: MessageEvent<KokoroWorkerRequest>): Promise<void> => {
  const message = event.data;
  switch (message.type) {
    case "load": {
      try {
        await ensureModel(message.dtype, message.device, (data) => post({ type: "load-progress", data }));
        post({ type: "loaded" });
      } catch (error) {
        postError(
          undefined,
          "KokoroGenerateError",
          `Model load failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    case "generate": {
      try {
        if (!tts) {
          throw new KokoroModelNotLoadedError("Model is not loaded — send a load request first.");
        }
        if (!isSynthesizableVoice(message.voice)) {
          throw new KokoroGenerateError(
            `Voice "${message.voice}" is not available in the in-browser engine (English voices only).`,
          );
        }
        // Boundary cast (justified): kokoro-js types voice as its internal
        // 28-English-id union; our manifest's English subset is the same set
        // of literal strings, but TS cannot see that across the manifest.
        const options = {
          voice: message.voice as GenerateOptions["voice"],
          speed: message.speed,
        };
        const raw = await tts.generate(message.text, options);
        // RawAudio: Float32 waveform + sampling_rate. Transfer ownership.
        post({ type: "generated", id: message.id, audio: raw.audio, sampleRate: raw.sampling_rate });
      } catch (error) {
        if (error instanceof KokoroModelNotLoadedError) {
          postError(message.id, error.name, error.message);
          return;
        }
        postError(
          message.id,
          "KokoroGenerateError",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    case "dispose": {
      // Drop references; the model cache lives in CacheStorage (browser-managed).
      tts = null;
      loading = null;
      return;
    }
  }
};
