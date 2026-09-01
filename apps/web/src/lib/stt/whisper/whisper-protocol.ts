/**
 * Message protocol between the Whisper main-thread client and the Web Worker
 * (STT_PLAN ST-3). Pure types only — shared by `whisper-worker.ts` (worker
 * side), `whisper-client.ts` (main thread) and the client tests (fake
 * worker). No DOM, no imports. Mirrors `tts/kokoro/kokoro-protocol.ts`.
 */

/** Execution device (wasm = CPU, works everywhere; webgpu = optional fast path). */
export type WhisperDevice = "wasm" | "webgpu";

/** transformers.js dtype for the ONNX weights (q8 = small download). */
export type WhisperDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export interface WhisperLoadRequest {
  type: "load";
  /** Full model id from the whisper roster ("onnx-community/whisper-base"). */
  modelId: string;
  dtype: WhisperDtype;
  device: WhisperDevice;
}

export interface WhisperTranscribeRequest {
  type: "transcribe";
  /** Correlation id assigned by the client. */
  id: number;
  /** 16 kHz mono PCM; ownership transfers from the main thread. */
  audio: Float32Array;
  /** BCP-47-ish source language hint; omitted/undefined = auto-detect.
   *  Ignored by the worker for English-only (.en) models. */
  language?: string;
}

export interface WhisperDisposeRequest {
  type: "dispose";
}

export type WhisperWorkerRequest = WhisperLoadRequest | WhisperTranscribeRequest | WhisperDisposeRequest;

// ─── Worker → client ─────────────────────────────────────────────────────────

/** Forwarded transformers.js download progress (opaque payload). */
export interface WhisperLoadProgressResponse {
  type: "load-progress";
  data: unknown;
}

export interface WhisperLoadedResponse {
  type: "loaded";
  modelId: string;
}

export interface WhisperTranscribedResponse {
  type: "transcribed";
  id: number;
  text: string;
}

/** Structured error envelope — typed errors do NOT survive the worker
 *  boundary as class instances, so the client reconstructs them by name. */
export interface WhisperErrorResponse {
  type: "error";
  /** Correlation id when the error belongs to one transcribe call. */
  id?: number;
  /** Error class name (WhisperModelNotLoadedError | WhisperTranscribeError). */
  name: string;
  message: string;
}

export type WhisperWorkerResponse =
  | WhisperLoadProgressResponse
  | WhisperLoadedResponse
  | WhisperTranscribedResponse
  | WhisperErrorResponse;
