/**
 * Pure option-building for the transformers.js ASR pipeline call
 * (STT_PLAN ST-3). Kept free of imports and I/O so the two decisions that
 * matter are unit-testable without the ML stack:
 *
 * 1. English-only (.en) models MUST NOT receive `language`/`task` — the
 *    whisper tokenizer errors out on an explicit language for English-only
 *    checkpoints. The builder drops both for .en ids.
 * 2. Dictation clips can exceed whisper's 30-second window, so chunked
 *    long-audio processing is ALWAYS on (`chunk_length_s` 30 with the
 *    default sixth-of-a-chunk stride) — transformers.js does not window
 *    automatically; without it anything past ~30 s truncates.
 */

export interface WhisperAsrCallOptions {
  task: "transcribe";
  chunk_length_s: number;
  stride_length_s: number;
  language?: string;
}

/** English-only checkpoints (.en suffix) cannot take a language hint. */
export function isEnglishOnlyWhisperModel(modelId: string): boolean {
  return modelId.endsWith(".en");
}

/** Build the pipeline call options for one transcription. Pure. */
export function buildWhisperAsrOptions(modelId: string, language: string | undefined): WhisperAsrCallOptions {
  const options: WhisperAsrCallOptions = {
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  if (language !== undefined && language !== "" && !isEnglishOnlyWhisperModel(modelId)) {
    options.language = language;
  }
  return options;
}
