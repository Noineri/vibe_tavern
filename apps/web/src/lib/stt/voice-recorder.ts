/**
 * Microphone recording for dictation + voice notes (STT_PLAN ST-4b, P13):
 * a thin push-to-talk wrapper over getUserMedia + AudioContext that encodes
 * the take as 16 kHz mono WAV — no MediaRecorder, no codec negotiation, so
 * the recorder can never produce a container the upload allowlist rejects
 * (the old mime-negotiation fallback silently produced video/webm in
 * Chromium, which the server 415s).
 *
 * The platform pieces are injectable (happy-dom has neither getUserMedia nor
 * WebAudio — tests pass fakes); typed failure codes let the UI show an
 * actionable message instead of a raw DOMException.
 */

import { float32ToWavBytes } from "../audio/float32-to-wav.js";

/** Target sample rate for recorded voice (whisper-native, ~1.9 MB/min). */
export const VOICE_RECORD_SAMPLE_RATE = 16000;

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

/** Raw PCM take handed back by a capture pipeline. */
export interface PcmCapture {
  /** Device/context rate the pcm samples were captured at. */
  sampleRate: number;
  /** End capture and hand over the accumulated mono samples. */
  stop(): Promise<{ pcm: Float32Array; sampleRate: number }>;
  /** Abort capture and release graph resources (cancel path). */
  dispose(): void;
}

export type VoiceRecorderDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Created SYNCHRONOUSLY inside start()'s click gesture, BEFORE the
   *  getUserMedia await: Safari only runs a gesture-created AudioContext —
   *  one created after an await starts suspended and cannot be resumed,
   *  silently producing an empty take (the classic getUserMedia+WebAudio
   *  pitfall; Chrome tolerates late creation via sticky activation). */
  createAudioContext: () => AudioContext;
  createCapturePipeline: (audio: AudioContext, stream: MediaStream) => Promise<PcmCapture>;
};

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new VoiceRecorderError("unsupported", "Audio recording is not available in this browser.");
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

function defaultCreateAudioContext(): AudioContext {
  if (typeof AudioContext === "undefined") {
    throw new VoiceRecorderError("unsupported", "Audio recording is not available in this browser.");
  }
  return new AudioContext();
}

/**
 * Downsample mono PCM to 16 kHz with linear interpolation. Pure and total
 * over valid rates: same-rate input returns an equal copy, empty input
 * returns empty, anything else scales by output/input length. A pure
 * resampler (rather than an OfflineAudioContext render) keeps this
 * unit-testable with no DOM; speech at 16 kHz mono needs nothing fancier.
 */
export function resampleMonoTo16k(pcm: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new RangeError(`resampleMonoTo16k: invalid input rate ${String(inputRate)}`);
  }
  if (pcm.length === 0) return new Float32Array(0);
  if (inputRate === VOICE_RECORD_SAMPLE_RATE) return pcm.slice();
  const outLength = Math.floor((pcm.length * VOICE_RECORD_SAMPLE_RATE) / inputRate);
  const out = new Float32Array(outLength);
  const step = inputRate / VOICE_RECORD_SAMPLE_RATE;
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, pcm.length - 1);
    const frac = pos - lo;
    out[i] = pcm[lo] * (1 - frac) + pcm[hi] * frac;
  }
  return out;
}

const CAPTURE_WORKLET_NAME = "vibe-tavern-voice-capture";

/** Inline AudioWorklet module: forwards mic frames over the port (copied)
 *  and emits no audio of its own. Loaded via a blob URL so no extra served
 *  asset is needed. */
const CAPTURE_WORKLET_SOURCE = `
class VibeTavernVoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor("${CAPTURE_WORKLET_NAME}", VibeTavernVoiceCapture);
`;

async function defaultCreateCapturePipeline(audio: AudioContext, stream: MediaStream): Promise<PcmCapture> {
  if (typeof URL.createObjectURL !== "function") {
    void audio.close().catch(() => {
      // Closing a just-created context — the recorder's release path covers
      // the mic track; a close rejection must not mask the real error.
    });
    throw new VoiceRecorderError("unsupported", "Audio recording is not available in this browser.");
  }
  const context = audio;
  const chunks: Float32Array[] = [];
  let settled = false;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;

  const disposeGraph = (): void => {
    settled = true;
    try {
      source?.disconnect();
      node?.disconnect();
      sink?.disconnect();
    } catch {
      // Best-effort teardown on the cancel path — the context close below
      // is what actually releases the hardware.
    }
    source = null;
    node = null;
    sink = null;
    void context.close().catch(() => {
      // The mic track release in the recorder covers the hardware; a close
      // rejection here must not surface as a recording error.
    });
  };

  try {
    await context.audioWorklet.addModule(
      URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" })),
    );
  } catch (cause) {
    disposeGraph();
    throw new VoiceRecorderError(
      "unsupported",
      cause instanceof Error ? `Audio capture unavailable: ${cause.message}` : "Audio capture unavailable.",
    );
  }
  source = context.createMediaStreamSource(stream);
  node = new AudioWorkletNode(context, CAPTURE_WORKLET_NAME);
  node.port.onmessage = (event: MessageEvent) => {
    if (!settled && event.data instanceof Float32Array) chunks.push(event.data);
  };
  // Keep the graph pulled without audible feedback: the worklet emits
  // silence on its outputs, so the zeroed gain stage only drives the pull.
  sink = context.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);
  // Defensive resume (a suspended graph would silently produce an empty
  // take — fail loud instead). With the gesture-created context this is a
  // no-op everywhere except exotic permission-revoked-mid-call cases.
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      // Swallowed on purpose: the state re-check below is the real gate.
    }
    if (context.state === "suspended") {
      disposeGraph();
      throw new VoiceRecorderError("failed", "Audio could not be started (context stayed suspended).");
    }
  }

  return {
    sampleRate: context.sampleRate,
    async stop(): Promise<{ pcm: Float32Array; sampleRate: number }> {
      const rate = context.sampleRate;
      disposeGraph();
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      const pcm = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      return { pcm, sampleRate: rate };
    },
    dispose(): void {
      disposeGraph();
    },
  };
}

export function createVoiceRecorder(deps?: Partial<VoiceRecorderDeps>): VoiceRecorder {
  const getUserMedia = deps?.getUserMedia ?? defaultGetUserMedia;
  const createAudioContext = deps?.createAudioContext ?? defaultCreateAudioContext;
  const createCapturePipeline = deps?.createCapturePipeline ?? defaultCreateCapturePipeline;

  let stream: MediaStream | null = null;
  let capture: PcmCapture | null = null;
  let cancelled = false;

  return {
    async start(): Promise<void> {
      if (capture !== null) return;
      // Gesture-created context FIRST (see VoiceRecorderDeps) — this line
      // runs synchronously inside the click that started the recording.
      let audio: AudioContext;
      try {
        audio = createAudioContext();
      } catch (cause) {
        if (cause instanceof VoiceRecorderError) throw cause;
        throw new VoiceRecorderError("failed", cause instanceof Error ? cause.message : String(cause));
      }
      try {
        stream = await getUserMedia({ audio: true });
      } catch (cause) {
        void audio.close().catch(() => {
          // The mic was never opened; a close rejection is not the story.
        });
        if (cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError")) {
          throw new VoiceRecorderError("permission", "Microphone access was denied.");
        }
        if (cause instanceof VoiceRecorderError) throw cause;
        throw new VoiceRecorderError("failed", cause instanceof Error ? cause.message : String(cause));
      }
      cancelled = false;
      try {
        capture = await createCapturePipeline(audio, stream);
      } catch (cause) {
        release();
        if (cause instanceof VoiceRecorderError) throw cause;
        throw new VoiceRecorderError("failed", cause instanceof Error ? cause.message : String(cause));
      }
    },
    async stop(): Promise<Blob> {
      const active = capture;
      if (active === null) {
        throw new VoiceRecorderError("failed", "Recording was never started.");
      }
      capture = null;
      try {
        const take = await active.stop();
        release();
        if (cancelled) {
          throw new VoiceRecorderError("failed", "Recording was cancelled.");
        }
        const mono16k = resampleMonoTo16k(take.pcm, take.sampleRate);
        return new Blob([float32ToWavBytes(mono16k, VOICE_RECORD_SAMPLE_RATE)], { type: "audio/wav" });
      } catch (cause) {
        release();
        if (cause instanceof VoiceRecorderError) throw cause;
        throw new VoiceRecorderError("failed", cause instanceof Error ? cause.message : String(cause));
      }
    },
    cancel(): void {
      cancelled = true;
      capture?.dispose();
      release();
    },
    isActive(): boolean {
      return capture !== null;
    },
  };

  function release(): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    capture = null;
  }
}
