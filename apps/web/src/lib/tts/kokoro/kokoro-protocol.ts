/**
 * Message protocol between the Kokoro main-thread client and the Web Worker.
 * Pure types only — shared by `kokoro-worker.ts` (worker side), `kokoro-client.ts`
 * (main thread) and the client tests (fake worker). No DOM, no imports.
 */

/** Quantizations kokoro-js accepts for the ONNX model. */
export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

/** Execution device (wasm = CPU, works everywhere; webgpu = optional fast path). */
export type KokoroDevice = "wasm" | "webgpu";

export interface KokoroLoadRequest {
  type: "load";
  dtype: KokoroDtype;
  device: KokoroDevice;
}

export interface KokoroGenerateRequest {
  type: "generate";
  /** Correlation id assigned by the client. */
  id: number;
  text: string;
  voice: string;
  speed?: number;
}

export interface KokoroDisposeRequest {
  type: "dispose";
}

export type KokoroWorkerRequest = KokoroLoadRequest | KokoroGenerateRequest | KokoroDisposeRequest;

// ─── Worker → client ─────────────────────────────────────────────────────────

/** Forwarded transformers.js download progress (opaque payload). */
export interface KokoroLoadProgressResponse {
  type: "load-progress";
  data: unknown;
}

export interface KokoroLoadedResponse {
  type: "loaded";
}

export interface KokoroGeneratedResponse {
  type: "generated";
  id: number;
  /** Monophonic 24 kHz samples; ownership transfers from the worker. */
  audio: Float32Array;
  sampleRate: number;
}

/** Structured error envelope — typed errors do NOT survive the worker
 *  boundary as class instances, so the client reconstructs them by name. */
export interface KokoroErrorResponse {
  type: "error";
  /** Correlation id when the error belongs to one generate call. */
  id?: number;
  /** Error class name (KokoroVoiceNotFoundError | KokoroModelNotLoadedError | KokoroGenerateError). */
  name: string;
  message: string;
  /** Present only for KokoroVoiceNotFoundError. */
  voiceId?: string;
}

export type KokoroWorkerResponse =
  | KokoroLoadProgressResponse
  | KokoroLoadedResponse
  | KokoroGeneratedResponse
  | KokoroErrorResponse;
