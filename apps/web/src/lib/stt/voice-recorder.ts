/**
 * Microphone recording for dictation (STT_PLAN ST-4b): a thin push-to-talk
 * wrapper over getUserMedia + MediaRecorder with typed failure codes, so the
 * UI can show an actionable message instead of a raw DOMException.
 *
 * The platform pieces are injectable (happy-dom has neither getUserMedia nor
 * MediaRecorder — tests pass fakes); the default wiring negotiates a
 * lossy-codec container browsers actually produce (webm/opus, then ogg/opus,
 * then whatever the browser defaults to — all are in AUDIO_MIMES, ST-1).
 */

export type VoiceRecorderErrorCode = "permission" | "unsupported" | "failed";

export class VoiceRecorderError extends Error {
  readonly code: VoiceRecorderErrorCode;
  constructor(code: VoiceRecorderErrorCode, message: string) {
    super(message);
    this.name = "VoiceRecorderError";
    this.code = code;
  }
}

export interface VoiceRecorder {
  /** Begin capturing. Rejects with VoiceRecorderError on denial/failure. */
  start(): Promise<void>;
  /** Stop and resolve the recorded audio Blob. */
  stop(): Promise<Blob>;
  /** Stop and DISCARD (ESC / cancel) — resolves with nothing. */
  cancel(): void;
  /** True between a successful start() and stop()/cancel(). */
  isActive(): boolean;
}

/** MediaRecorder-compatible surface the factory needs (subset). */
export interface RecorderLike {
  start(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  mimeType: string;
}

export type RecorderFactoryDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, mimeType?: string) => RecorderLike;
};

function defaultCreateRecorder(stream: MediaStream, mimeType?: string): RecorderLike {
  const options: MediaRecorderOptions = mimeType !== undefined ? { mimeType } : {};
  return new MediaRecorder(stream, options) as unknown as RecorderLike;
}

/** Negotiate the best supported audio mime (webm/opus > ogg/opus > default). */
export function pickRecorderMime(isTypeSupported: (type: string) => boolean): string | undefined {
  if (isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (isTypeSupported("audio/ogg;codecs=opus")) return "audio/ogg;codecs=opus";
  if (isTypeSupported("audio/webm")) return "audio/webm";
  return undefined;
}

export function createVoiceRecorder(deps?: Partial<RecorderFactoryDeps>): VoiceRecorder {
  const getUserMedia =
    deps?.getUserMedia ??
    (async (constraints: MediaStreamConstraints) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new VoiceRecorderError("unsupported", "Audio recording is not available in this browser.");
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    });
  const createRecorder = deps?.createRecorder ?? defaultCreateRecorder;

  let stream: MediaStream | null = null;
  let recorder: RecorderLike | null = null;
  let chunks: Blob[] = [];
  let stopped = false;

  return {
    async start(): Promise<void> {
      if (recorder !== null) return;
      try {
        stream = await getUserMedia({ audio: true });
      } catch (cause) {
        if (cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError")) {
          throw new VoiceRecorderError("permission", "Microphone access was denied.");
        }
        if (cause instanceof VoiceRecorderError) throw cause;
        throw new VoiceRecorderError("failed", cause instanceof Error ? cause.message : String(cause));
      }
      const mimeType =
        typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
          ? pickRecorderMime((type) => MediaRecorder.isTypeSupported(type))
          : undefined;
      chunks = [];
      stopped = false;
      recorder = createRecorder(stream, mimeType);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        // Surface as a failed stop; stop() then rejects via onstop handling.
      };
      recorder.start();
    },
    stop(): Promise<Blob> {
      return new Promise<Blob>((resolve, reject) => {
        if (recorder === null) {
          reject(new VoiceRecorderError("failed", "Recording was never started."));
          return;
        }
        const active = recorder;
        active.onstop = () => {
          release();
          if (stopped) {
            reject(new VoiceRecorderError("failed", "Recording was cancelled."));
            return;
          }
          const type = active.mimeType !== "" ? active.mimeType : "audio/webm";
          resolve(new Blob(chunks, { type }));
        };
        active.stop();
      });
    },
    cancel(): void {
      stopped = true;
      recorder?.stop();
      release();
    },
    isActive(): boolean {
      return recorder !== null;
    },
  };

  function release(): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    recorder = null;
  }
}
