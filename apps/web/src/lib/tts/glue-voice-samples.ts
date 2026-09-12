/**
 * Client-side multi-sample voice-clone glue (TPE-11, owner decision 2026-09-05).
 *
 * Every clone-capable backend speaks a SINGLE-file upload wire, but the
 * owner's material is many SHORT samples — so the client glues them into one
 * mono WAV before upload. No backend change, no ffmpeg: the browser's
 * decodeAudioData natively decodes mp3/m4a/ogg/webm/wav/flac and resamples
 * everything to one rate, which is exactly what server-side glue would need
 * ffmpeg for.
 *
 * Owner decisions (2026-09-05): order = selection order (no drag-reorder in
 * v1); total-duration warning outside 10–30 s is WARNING-ONLY (the only hard
 * upstream limit is the 10 MB file size — duration is a recommendation:
 * shorter weakens similarity, longer slows every generation); mono mix
 * (chatterbox output is mono 24 kHz, S3/HiFT family — a stereo reference is
 * double file weight for zero identity gain). A SINGLE sample is passed
 * through untouched (original bytes, original container).
 */

import { float32ToWavBytes } from "../audio/float32-to-wav.js";

/** One decoded sample: raw channel data at one rate. */
export interface RawVoiceSample {
  channels: Float32Array[];
  sampleRate: number;
}

/** Decoding seam — the browser impl uses decodeAudioData; tests inject fakes. */
export type RawVoiceSampleDecoder = (file: File) => Promise<RawVoiceSample>;

/** The glue result: the uploadable file plus duration facts for the UI. */
export interface GluedVoiceSample {
  file: File;
  totalSeconds: number;
  sampleDurations: number[];
}

export type GlueVoiceErrorCode = "decode" | "size";

/** Typed failure so the card can map codes to i18n keys without parsing. */
export class GlueVoiceSamplesError extends Error {
  readonly code: GlueVoiceErrorCode;

  constructor(code: GlueVoiceErrorCode, message: string) {
    super(message);
    this.name = "GlueVoiceSamplesError";
    this.code = code;
  }
}

/** Silence between samples — unrelated clips must not butt joins (TPE-11). */
export const GLUE_GAP_SECONDS = 0.4;

/** Downmix to mono by averaging channels (identical-length channels by contract). */
export function monoMix(sample: RawVoiceSample): Float32Array {
  if (sample.channels.length <= 1) return sample.channels[0];
  const first = sample.channels[0];
  const out = new Float32Array(first.length);
  for (const channel of sample.channels) {
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i];
  }
  const count = sample.channels.length;
  for (let i = 0; i < out.length; i += 1) out[i] /= count;
  return out;
}

/**
 * Glue samples in selection order into one mono WAV (or pass a lone sample
 * through untouched). `decode` must return a UNIFORM sample rate across files
 * — the browser impl guarantees it by decoding every file through the same
 * fixed-rate context.
 */
export async function glueVoiceSamples(
  files: File[],
  decode: RawVoiceSampleDecoder,
  maxBytes: number,
): Promise<GluedVoiceSample> {
  if (files.length === 0) throw new Error("glueVoiceSamples: no files selected");

  const decoded: RawVoiceSample[] = [];
  try {
    for (const file of files) decoded.push(await decode(file));
  } catch (cause) {
    throw new GlueVoiceSamplesError(
      "decode",
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  const sampleDurations = decoded.map((d) => d.channels[0].length / d.sampleRate);

  if (files.length === 1) {
    // Passthrough: the original container is already uploadable — re-encoding
    // a lone sample to WAV would only inflate it.
    return { file: files[0], totalSeconds: sampleDurations[0], sampleDurations };
  }

  const rate = decoded[0].sampleRate;
  const gapSamples = Math.round(rate * GLUE_GAP_SECONDS);
  const monoChunks = decoded.map(monoMix);
  const totalSamples =
    monoChunks.reduce((sum, chunk) => sum + chunk.length, 0) + gapSamples * (files.length - 1);
  const out = new Float32Array(totalSamples);
  let offset = 0;
  monoChunks.forEach((chunk, index) => {
    out.set(chunk, offset);
    offset += chunk.length + gapSamples; // the gap stays zero-filled
  });

  const bytes = float32ToWavBytes(out, rate);
  if (bytes.byteLength > maxBytes) {
    throw new GlueVoiceSamplesError("size", `glued wav is ${bytes.byteLength} bytes`);
  }
  const file = new File([bytes], "voice-samples.wav", { type: "audio/wav" });
  return { file, totalSeconds: totalSamples / rate, sampleDurations };
}

// ─── Browser decode seam ─────────────────────────────────────────────────────

/** Lazy shared context — decodeAudioData never emits sound, so reuse is safe.
 *  OfflineAudioContext pins 44.1 kHz instead of the device rate (48 k on much
 *  hardware), making the glued WAV's rate deterministic. */
let decodeContext: OfflineAudioContext | null = null;

async function decodeViaAudioContext(file: File): Promise<RawVoiceSample> {
  const arrayBuffer = await file.arrayBuffer();
  if (decodeContext === null) {
    decodeContext = new OfflineAudioContext(1, 1, 44100);
  }
  const buffer = await decodeContext.decodeAudioData(arrayBuffer);
  const channels: Float32Array[] = [];
  for (let i = 0; i < buffer.numberOfChannels; i += 1) {
    // Copy: getChannelData views die with the AudioBuffer.
    channels.push(new Float32Array(buffer.getChannelData(i)));
  }
  return { channels, sampleRate: buffer.sampleRate };
}

/** Test seam (happy-dom has no AudioContext) — null restores the browser impl. */
let decodeOverride: RawVoiceSampleDecoder | null = null;

export function __setGlueDecoderForTests(decoder: RawVoiceSampleDecoder | null): void {
  decodeOverride = decoder;
}

/** The decoder the UI uses — overridable seam first, browser impl as default. */
export function glueDecoder(): RawVoiceSampleDecoder {
  return decodeOverride ?? decodeViaAudioContext;
}
