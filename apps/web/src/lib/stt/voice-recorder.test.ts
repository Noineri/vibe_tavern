/**
 * Voice recorder tests (STT_PLAN ST-4b, P13 WAV path): the push-to-talk
 * wrapper over injectable { getUserMedia, createAudioContext,
 * createCapturePipeline } fakes (happy-dom has neither getUserMedia nor
 * WebAudio).
 *
 * The boundary is unchanged from the MediaRecorder era — start → samples →
 * stop → Blob, plus permission/cancel/lifecycle — but the pins now assert
 * the WAV contract: blob.type, RIFF header fields, and the 16 kHz mono
 * resample ratio. The deleted pickRecorderMime describes died with the
 * deleted negotiation (P13 removes the MediaRecorder layer entirely).
 *
 * Verifier addition (owner-side review): the AudioContext is created
 * SYNCHRONOUSLY inside start()'s click gesture BEFORE the getUserMedia
 * await — Safari only runs gesture-created contexts; one created after the
 * await starts suspended and silently records an empty take. Pinned below
 * by the ordering check + the close-on-permission-denial check.
 */

import { describe, expect, test } from "bun:test";

import {
  createVoiceRecorder,
  resampleMonoTo16k,
  VoiceRecorderError,
  type PcmCapture,
} from "./voice-recorder.js";

/** Member-for-member MediaStream double (step 8b): a real EventTarget base
 *  carries the listener surface, `getTracks → stop` is the live member the
 *  recorder drives at teardown (voice-recorder.ts:286), every other member of
 *  the interface is an inert default. */
function fakeMic(): { stream: MediaStream; trackStopped: () => boolean } {
  let stopped = false;
  const track: MediaStreamTrack = Object.assign(new EventTarget(), {
    contentHint: "",
    enabled: true,
    id: "mic-track",
    kind: "audio" as const,
    label: "fake-mic",
    muted: false,
    readyState: "live" as const,
    onended: null,
    onmute: null,
    onunmute: null,
    applyConstraints: () => Promise.resolve(),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop() {
      stopped = true;
    },
    clone: () => track,
  });
  const stream: MediaStream = Object.assign(new EventTarget(), {
    active: true,
    id: "mic-stream",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: (_track: MediaStreamTrack) => {},
    removeTrack: (_track: MediaStreamTrack) => {},
    clone: () => stream,
    getAudioTracks: () => [track],
    getTrackById: (trackId: string) => (trackId === "mic-track" ? track : null),
    getTracks: () => [track],
    getVideoTracks: () => [],
  });
  return { stream, trackStopped: () => stopped };
}

function fakePipeline(opts?: {
  sampleRate?: number;
  pcm?: Float32Array;
  stopError?: unknown;
}): { capture: PcmCapture; disposed: () => boolean } {
  let disposed = false;
  const sampleRate = opts?.sampleRate ?? 48000;
  return {
    disposed: () => disposed,
    capture: {
      sampleRate,
      async stop() {
        if (disposed) throw new Error("pipeline disposed before stop");
        if (opts?.stopError !== undefined) throw opts.stopError;
        return { pcm: opts?.pcm ?? new Float32Array(0), sampleRate };
      },
      dispose() {
        disposed = true;
      },
    },
  };
}

// ── Member-for-member Web Audio doubles (step 8b) ──────────────────────────
// The recorder only CONSTRUCTS the context inside the gesture and CLOSES it
// at teardown (voice-recorder.ts:229/:237 — `audio.close().catch(…)`), so
// every graph member below is inert. The member sets are complete: real
// happy-dom instances where a DOM type exists (MessagePort via MessageChannel,
// an <audio> element for the media-element node), EventTarget-based literals
// for the audio graph, one `audioParam`/`audioNode` factory shared by the
// node set (each node's return type is checked against the interface here).

function audioParam(value = 0): AudioParam {
  const param: AudioParam = {
    value,
    automationRate: "a-rate",
    defaultValue: value,
    minValue: value,
    maxValue: value,
    cancelScheduledValues: () => param,
    cancelAndHoldAtTime: () => param,
    exponentialRampToValueAtTime: () => param,
    linearRampToValueAtTime: () => param,
    setTargetAtTime: () => param,
    setValueAtTime: () => param,
    setValueCurveAtTime: () => param,
  };
  return param;
}

function audioBuffer(seconds = 0): AudioBuffer {
  const channel = new Float32Array(0);
  return {
    duration: seconds,
    length: 0,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => channel,
    copyFromChannel: () => {},
    copyToChannel: () => {},
  };
}

/** The shared inert AudioNode — a real EventTarget base for the listener
 *  surface; `connect`/`disconnect` carry their overload sets as declared
 *  overloads (the node- and param-target variants return different types). */
class InertAudioNode extends EventTarget {
  context: BaseAudioContext;
  numberOfInputs = 0;
  numberOfOutputs = 0;
  channelCount = 2;
  channelCountMode: "clamped-max" | "explicit" = "clamped-max";
  channelInterpretation: "speakers" | "discrete" = "speakers";
  constructor(context: BaseAudioContext) {
    super();
    this.context = context;
  }
  connect(destination: AudioNode, _output?: number, _input?: number): AudioNode;
  connect(destination: AudioParam, _output?: number): AudioParam;
  connect(destination: AudioNode | AudioParam, _output?: number, _input?: number): AudioNode | AudioParam {
    return destination;
  }
  disconnect(): void;
  disconnect(_output: number): void;
  disconnect(_output: number, _input: number): void;
  disconnect(_destination: AudioNode, _output?: number, _input?: number): void;
  disconnect(_destination: AudioParam, _output?: number): void;
  disconnect(_a?: number | AudioNode | AudioParam, _b?: number, _c?: number): void {}
}

/** The context's endpoint node — AudioNode plus `maxChannelCount`. */
class InertDestinationNode extends InertAudioNode {
  override numberOfInputs = 1;
  override numberOfOutputs = 0;
  override channelCountMode: "explicit" = "explicit";
  maxChannelCount = 2;
}

/** A getter member must carry the literal-type union exactly; helpers used by
 *  the context literal below. */
function inertListener(): AudioListener {
  return Object.assign(new EventTarget(), {
    positionX: audioParam(), positionY: audioParam(), positionZ: audioParam(),
    forwardX: audioParam(), forwardY: audioParam(), forwardZ: audioParam(),
    upX: audioParam(), upY: audioParam(), upZ: audioParam(),
    setPosition: () => {}, setOrientation: () => {},
  });
}

type ScheduledSourceExtras = { onended: null; start: (when?: number) => void; stop: (when?: number) => void };
const scheduledSource: ScheduledSourceExtras = { onended: null, start: () => {}, stop: () => {} };

function fakeAudio(): { ctor: () => AudioContext; closed: () => boolean } {
  let closed = false;
  let context!: AudioContext;
  // `context` is read lazily through the InertAudioNode members below — the
  // nodes resolve it after the assignment, never during this construction.
  const destination: AudioDestinationNode = new InertDestinationNode(context);
  context = Object.assign(new EventTarget(), {
    audioWorklet: { port: new MessageChannel().port1, addModule: () => Promise.resolve() },
    currentTime: 0,
    listener: inertListener(),
    onstatechange: null,
    sampleRate: 48000,
    state: "running" as const,
    baseLatency: 0,
    outputLatency: 0,
    close() {
      closed = true;
      return Promise.resolve();
    },
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    destination,
    decodeAudioData: (_data: ArrayBuffer) => Promise.resolve(audioBuffer()),
    createBuffer: (_channels: number, _length: number, _sampleRate: number) => audioBuffer(),
    createPeriodicWave: (_real: number[] | Float32Array, _imag: number[] | Float32Array, _constraints?: PeriodicWaveConstraints) => new EventTarget(),
    createAnalyser: () => Object.assign(audioNodeFor(), {
      frequency: audioParam(), detune: audioParam(), fftSize: 2048, frequencyBinCount: 1024,
      minDecibels: -100, maxDecibels: -30, smoothingTimeConstant: 0.8,
      getByteFrequencyData: (_array: Uint8Array) => {}, getByteTimeDomainData: (_array: Uint8Array) => {},
      getFloatFrequencyData: (_array: Float32Array) => {}, getFloatTimeDomainData: (_array: Float32Array) => {},
    }),
    createBiquadFilter: () => Object.assign(audioNodeFor(), {
      detune: audioParam(), frequency: audioParam(), gain: audioParam(), Q: audioParam(), type: "lowpass" as const,
      getFrequencyResponse: (_frequencyHz: Float32Array, _magResponse: Float32Array, _phaseResponse: Float32Array) => {},
    }),
    createBufferSource: () => Object.assign(audioNodeFor(), scheduledSource, {
      buffer: null, detune: audioParam(), loop: false, loopEnd: 0, loopStart: 0, playbackRate: audioParam(1),
    }),
    createChannelMerger: (_numberOfInputs?: number) => audioNodeFor(),
    createChannelSplitter: (_numberOfOutputs?: number) => audioNodeFor(),
    createConstantSource: () => Object.assign(audioNodeFor(), scheduledSource, { offset: audioParam(1) }),
    createConvolver: () => Object.assign(audioNodeFor(), { buffer: null, normalize: true }),
    createDelay: (_maxDelayTime?: number) => Object.assign(audioNodeFor(), { delayTime: audioParam() }),
    createDynamicsCompressor: () => Object.assign(audioNodeFor(), {
      attack: audioParam(), knee: audioParam(), ratio: audioParam(), reduction: 0, release: audioParam(), threshold: audioParam(),
    }),
    createGain: () => Object.assign(audioNodeFor(), { gain: audioParam(1) }),
    createIIRFilter: (_feedforward: number[], _feedback: number[]) => Object.assign(audioNodeFor(), { getFrequencyResponse: (_freq: Float32Array, _mag: Float32Array, _phase: Float32Array) => {} }),
    createOscillator: () => Object.assign(audioNodeFor(), scheduledSource, {
      detune: audioParam(), frequency: audioParam(440), type: "sine" as const, setPeriodicWave: (_wave: PeriodicWave) => {},
    }),
    createPanner: () => Object.assign(audioNodeFor(), {
      coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0, distanceModel: "inverse" as const, maxDistance: 10000,
      orientationX: audioParam(), orientationY: audioParam(), orientationZ: audioParam(),
      panningModel: "HRTF" as const, positionX: audioParam(), positionY: audioParam(), positionZ: audioParam(),
      refDistance: 1, rolloffFactor: 1, setOrientation: () => {}, setPosition: () => {},
    }),
    createScriptProcessor: (_bufferSize?: number, _numberOfInputChannels?: number, _numberOfOutputChannels?: number) => Object.assign(audioNodeFor(), {
      bufferSize: 4096, onaudioprocess: null, inputBuffer: audioBuffer(), outputBuffer: audioBuffer(),
    }),
    createStereoPanner: () => Object.assign(audioNodeFor(), { pan: audioParam() }),
    createWaveShaper: () => Object.assign(audioNodeFor(), { curve: null, oversample: "none" as const }),
    createMediaStreamSource: (stream: MediaStream) => Object.assign(audioNodeFor(), { mediaStream: stream }),
    createMediaStreamDestination: () => Object.assign(audioNodeFor(), { stream: fakeMic().stream }),
    createMediaElementSource: (_element: HTMLMediaElement) => Object.assign(audioNodeFor(), { mediaElement: document.createElement("audio") }),
  });
  // One inert node per create* call, closed over the ASSIGNED context.
  function audioNodeFor(): InertAudioNode {
    return new InertAudioNode(context);
  }
  return { ctor: () => context, closed: () => closed };
}

function ramp(length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i / Math.max(1, length - 1);
  return out;
}

async function readWav(blob: Blob): Promise<{ bytes: Uint8Array; view: DataView }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, view: new DataView(bytes.buffer) };
}

function ascii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

describe("createVoiceRecorder", () => {
  test("happy path: start captures PCM, stop resolves a 16 kHz mono WAV blob", async () => {
    const { stream, trackStopped } = fakeMic();
    const pipe = fakePipeline({ sampleRate: 48000, pcm: ramp(480) });
    const audio = fakeAudio();
    const order: string[] = [];
    const recorder = createVoiceRecorder({
      createAudioContext: () => {
        order.push("context");
        return audio.ctor();
      },
      getUserMedia: async () => {
        order.push("mic");
        return stream;
      },
      createCapturePipeline: async () => pipe.capture,
    });
    await recorder.start();
    expect(recorder.isActive()).toBe(true);
    // Safari gesture pin: the context must exist BEFORE the getUserMedia
    // await — a context created after it starts suspended on Safari and
    // silently records an empty take.
    expect(order).toEqual(["context", "mic"]);

    const blob = await recorder.stop();
    expect(blob.type).toBe("audio/wav");
    // 480 samples @ 48 kHz → 160 samples @ 16 kHz → 44-byte header + 320 data.
    expect(blob.size).toBe(44 + 160 * 2);
    expect(recorder.isActive()).toBe(false);
    expect(trackStopped()).toBe(true);

    const { view } = await readWav(blob);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(320);
  });

  test("native 16 kHz input passes through at full length", async () => {
    const { stream } = fakeMic();
    const pipe = fakePipeline({ sampleRate: 16000, pcm: new Float32Array(160).fill(1) });
    const recorder = createVoiceRecorder({
      createAudioContext: fakeAudio().ctor,
      getUserMedia: async () => stream,
      createCapturePipeline: async () => pipe.capture,
    });
    await recorder.start();
    const blob = await recorder.stop();
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 160 * 2);
    const { view } = await readWav(blob);
    expect(view.getUint32(24, true)).toBe(16000);
    // Full-scale positive clamps to 0x7fff (float32-to-wav convention).
    expect(view.getInt16(44, true)).toBe(32767);
  });

  test("constant tone survives the resample without level shift", async () => {
    const { stream } = fakeMic();
    const pipe = fakePipeline({ sampleRate: 48000, pcm: new Float32Array(4800).fill(0.5) });
    const recorder = createVoiceRecorder({
      createAudioContext: fakeAudio().ctor,
      getUserMedia: async () => stream,
      createCapturePipeline: async () => pipe.capture,
    });
    await recorder.start();
    const { view } = await readWav(await recorder.stop());
    expect(view.getUint32(40, true)).toBe(1600 * 2);
    const first = view.getInt16(44, true) / 0x7fff;
    const last = view.getInt16(44 + (1600 - 1) * 2, true) / 0x7fff;
    expect(Math.abs(first - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(last - 0.5)).toBeLessThan(0.02);
  });

  test("stop before start rejects", async () => {
    const recorder = createVoiceRecorder({
      createAudioContext: fakeAudio().ctor,
      getUserMedia: async () => fakeMic().stream,
      createCapturePipeline: async () => fakePipeline().capture,
    });
    const error = await recorder.stop().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
  });

  test("permission denial maps to the permission error code and closes the context", async () => {
    const audio = fakeAudio();
    const recorder = createVoiceRecorder({
      createAudioContext: audio.ctor,
      getUserMedia: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
      createCapturePipeline: async () => fakePipeline().capture,
    });
    const error = await recorder.start().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
    expect((error as VoiceRecorderError).code).toBe("permission");
    // The gesture-created context must not leak when the mic never opens.
    expect(audio.closed()).toBe(true);
  });

  test("no AudioContext surfaces as the unsupported error code", async () => {
    const recorder = createVoiceRecorder({
      createAudioContext: () => {
        throw new VoiceRecorderError("unsupported", "no AudioContext");
      },
      getUserMedia: async () => fakeMic().stream,
      createCapturePipeline: async () => fakePipeline().capture,
    });
    const error = await recorder.start().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
    expect((error as VoiceRecorderError).code).toBe("unsupported");
    expect(recorder.isActive()).toBe(false);
  });

  test("pipeline failure during start rejects and releases the mic", async () => {
    const { stream, trackStopped } = fakeMic();
    const recorder = createVoiceRecorder({
      createAudioContext: fakeAudio().ctor,
      getUserMedia: async () => stream,
      createCapturePipeline: async () => {
        throw new Error("no worklet");
      },
    });
    const error = await recorder.start().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
    expect((error as VoiceRecorderError).code).toBe("failed");
    expect(recorder.isActive()).toBe(false);
    expect(trackStopped()).toBe(true);
  });

  test("cancel discards the take and releases the mic; a later stop() rejects", async () => {
    const { stream, trackStopped } = fakeMic();
    const pipe = fakePipeline({ sampleRate: 48000, pcm: ramp(480) });
    const recorder = createVoiceRecorder({
      createAudioContext: fakeAudio().ctor,
      getUserMedia: async () => stream,
      createCapturePipeline: async () => pipe.capture,
    });
    await recorder.start();
    recorder.cancel();
    expect(recorder.isActive()).toBe(false);
    expect(pipe.disposed()).toBe(true);
    expect(trackStopped()).toBe(true);
    const error = await recorder.stop().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
  });

  test("a failed pipeline stop surfaces as a failed recording", async () => {
    const { stream } = fakeMic();
    const pipe = fakePipeline({ stopError: new Error("worklet died") });
    const recorder = createVoiceRecorder({
      createAudioContext: fakeAudio().ctor,
      getUserMedia: async () => stream,
      createCapturePipeline: async () => pipe.capture,
    });
    await recorder.start();
    const error = await recorder.stop().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceRecorderError);
    expect((error as VoiceRecorderError).code).toBe("failed");
    expect(recorder.isActive()).toBe(false);
  });
});

describe("resampleMonoTo16k", () => {
  test("same-rate input returns an equal copy", () => {
    const pcm = ramp(100);
    const out = resampleMonoTo16k(pcm, 16000);
    expect(out).not.toBe(pcm);
    expect(Array.from(out)).toEqual(Array.from(pcm));
  });

  test("empty input returns empty", () => {
    expect(resampleMonoTo16k(new Float32Array(0), 48000).length).toBe(0);
  });

  test("48 kHz → 16 kHz is an exact third with endpoint fidelity", () => {
    const out = resampleMonoTo16k(ramp(480), 48000);
    expect(out.length).toBe(160);
    expect(Math.abs(out[0] - 0)).toBeLessThan(1e-6);
    // Last output taps input index 477 of 479.
    expect(Math.abs(out[159] - 477 / 479)).toBeLessThan(1e-6);
  });

  test("44.1 kHz one second yields 16000 samples", () => {
    expect(resampleMonoTo16k(new Float32Array(44100).fill(0.25), 44100).length).toBe(16000);
  });

  test("invalid rates throw", () => {
    for (const rate of [0, -48000, NaN, Infinity]) {
      expect(() => resampleMonoTo16k(new Float32Array(8), rate)).toThrow(RangeError);
    }
  });
});
