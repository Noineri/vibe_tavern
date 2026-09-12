/**
 * Typed error hierarchy for the in-browser Whisper engine (STT_PLAN ST-3).
 * Mirrors `tts/kokoro/kokoro-errors.ts`: the WORKER posts these as plain
 * envelopes (class instances do not survive the worker boundary) and the
 * CLIENT reconstructs them by name.
 */

/** transcribe/load called before a successful model load. */
export class WhisperModelNotLoadedError extends Error {
  constructor(message = "Whisper model is not loaded — call load() first.") {
    super(message);
    this.name = "WhisperModelNotLoadedError";
  }
}

/** Any transcription or download failure (load stall, pipeline error,
 *  decode failure). */
export class WhisperTranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperTranscribeError";
  }
}
