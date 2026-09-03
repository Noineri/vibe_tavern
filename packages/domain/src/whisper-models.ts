/**
 * Whisper in-browser roster (STT_PLAN ST-3): the model ids the browser engine
 * offers, with picker metadata (label, approximate size, English-only flag).
 *
 * Lives in `domain` because BOTH sides consume it: the web worker's roster
 * picker (ST-4a) renders it, and the server-side whisper mirror
 * (`services/api/src/domain/stt/whisper-mirror.ts`) uses it as its repository
 * ALLOWLIST — the mirror serves exactly these repos, never an arbitrary one.
 * Same placement rationale as `tts-server-discovery.ts`. Zero deps, pure data.
 *
 * Sizes are the q8 ONNX weights as served by the onnx-community repos
 * (approximate by design — the download UI reports live exact bytes; same
 * convention as the Kokoro variants). English-only (.en) models cannot take
 * a language option — see the worker's ASR-options builder.
 */

export interface WhisperModelInfo {
  /** Full transformers.js model id (also the HF repo name). */
  id: string;
  /** Human label for the picker ("Whisper Base (multilingual)"). */
  label: string;
  /** Approximate q8 onnx-weights download size in MB, rounded (CPU lane:
   *  wasm + q8 — the universal fallback). */
  approxMb: number;
  /** Approximate fp16 weights download size in MB, rounded (GPU lane:
   *  WebGPU runs fp16 — owner decision 2026-09-05; real fp16 sums of
   *  encoder+decoder plus the tokenizer/config overhead). */
  approxMbGpu: number;
  /** True for English-only (.en) models — the language hint is not accepted. */
  englishOnly: boolean;
  /** One-line hint under the picker row. */
  hint: string;
}

export const WHISPER_MODELS: readonly WhisperModelInfo[] = [
  {
    id: "onnx-community/whisper-tiny.en",
    label: "Whisper Tiny (English)",
    approxMb: 42,
    approxMbGpu: 76,
    englishOnly: true,
    hint: "Smallest download, fastest, English only.",
  },
  {
    id: "onnx-community/whisper-base",
    label: "Whisper Base (multilingual)",
    approxMb: 80,
    approxMbGpu: 146,
    englishOnly: false,
    hint: "The default — auto-detects the language.",
  },
  {
    id: "onnx-community/whisper-small",
    label: "Whisper Small (multilingual)",
    approxMb: 250,
    approxMbGpu: 475,
    englishOnly: false,
    hint: "Most accurate of the three, largest download.",
  },
];

/** Resolve a roster entry by id (null = unknown id — the free-text config
 *  field may hold anything; callers decide whether to allow it). */
export function findWhisperModel(id: string): WhisperModelInfo | null {
  return WHISPER_MODELS.find((model) => model.id === id) ?? null;
}

/** The zero-config default (STT_DESIGN tier 0). */
export const DEFAULT_WHISPER_MODEL_ID = "onnx-community/whisper-base";

/** Repos the server-side whisper mirror is allowed to serve. The roster IS
 *  the allowlist — the mirror never becomes an open HF proxy. */
export function whisperMirrorRepos(): readonly string[] {
  return WHISPER_MODELS.map((model) => model.id);
}
