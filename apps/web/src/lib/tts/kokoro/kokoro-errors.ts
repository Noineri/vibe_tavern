/**
 * Typed error surface for the Kokoro in-browser TTS pure layer.
 *
 * TS-3b's Web Worker will throw these across the worker boundary so the
 * orchestrator can discriminate voice-not-found vs model-not-loaded vs
 * generic generation failures without string parsing.
 */

export class KokoroError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "KokoroError";
  }
}

export class KokoroVoiceNotFoundError extends KokoroError {
  readonly voiceId: string;

  constructor(voiceId: string) {
    super(`Kokoro voice not found: ${voiceId}`);
    this.name = "KokoroVoiceNotFoundError";
    this.voiceId = voiceId;
  }
}

export class KokoroModelNotLoadedError extends KokoroError {
  constructor(message = "Kokoro model not loaded") {
    super(message);
    this.name = "KokoroModelNotLoadedError";
  }
}

export class KokoroGenerateError extends KokoroError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "KokoroGenerateError";
  }
}
