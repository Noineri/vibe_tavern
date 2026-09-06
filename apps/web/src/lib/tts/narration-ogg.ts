import { APP_VERSION } from "../../build-config.js";

/**
 * TPE-18c: client-side merge of cached narration segments into ONE Ogg
 * Vorbis file (owner decision: one file per message, no blobs+manifest).
 *
 * Pipeline: decode each cached segment blob (Web Audio) → assert uniform
 * sampleRate/channel count (same TTS profile per narration — a mismatch is
 * an honest error, never a silent resample) → concatenate PCM → encode a
 * single OGG via `wasm-media-encoders`.
 *
 * Laziness (owner constraint): the ~780KB encoder glue enters through the
 * ONLY dynamic import of the package in the app — the main bundle never
 * carries it; the chunk loads on first save. The 440KB ogg.wasm bytes are
 * in NO bundle at all: they are fetched at runtime from the static public
 * asset below (public/ is copied verbatim in prod, served directly in
 * dev). Tests pin the asset URL (static path, not a bundled chunk hash).
 */

/** Static public asset (never bundled) — cache-busted with the app
 *  version, same pattern as the kokoro/whisper worker factories. */
export const NARRATION_OGG_WASM_URL = `/narration-ogg.wasm?v=${APP_VERSION}`;

export interface DecodedNarrationAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export interface NarrationOggEncoder {
  configure(params: { channels: 1 | 2; sampleRate: number }): void;
  encode(samples: readonly Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
}

export interface NarrationOggDeps {
  decodeAudio?: (blob: Blob) => Promise<DecodedNarrationAudio>;
  loadEncoder?: () => Promise<NarrationOggEncoder>;
}

export interface EncodedNarrationFile {
  bytes: Uint8Array<ArrayBuffer>;
  sampleRate: number;
  channels: number;
  durationSec: number;
  blobCount: number;
}

async function defaultDecodeAudio(blob: Blob): Promise<DecodedNarrationAudio> {
  if (typeof AudioContext === "undefined") {
    throw new Error("saving a narration needs Web Audio (no AudioContext in this runtime)");
  }
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      // Copy out: the AudioBuffer dies with the context below.
      channels.push(buffer.getChannelData(channel).slice());
    }
    return { sampleRate: buffer.sampleRate, channels };
  } finally {
    try {
      await context.close();
    } catch {
      // Best-effort teardown — the decode already succeeded or threw.
    }
  }
}

let encoderModulePromise: Promise<typeof import("wasm-media-encoders")> | null = null;

async function defaultLoadEncoder(): Promise<NarrationOggEncoder> {
  // The encoder glue chunk loads here (first save), the wasm bytes load
  // from the static URL inside create() — neither is in the main bundle.
  if (!encoderModulePromise) encoderModulePromise = import("wasm-media-encoders");
  const module = await encoderModulePromise;
  const encoder = await module.createEncoder("audio/ogg", NARRATION_OGG_WASM_URL);
  return {
    configure: (params) => encoder.configure({ channels: params.channels, sampleRate: params.sampleRate }),
    encode: (samples) => encoder.encode(samples),
    finalize: () => encoder.finalize(),
  };
}

/** Merge decoded segments into one OGG file. Throws on empty input,
 *  rate/channel mismatch, or unsupported channel counts — the save flow
 *  surfaces these as visible errors (never a corrupt silent file). */
export async function encodeNarrationSegmentsToOgg(
  blobs: Blob[],
  deps?: NarrationOggDeps,
): Promise<EncodedNarrationFile> {
  if (blobs.length === 0) {
    throw new Error("nothing to save: the narration produced no audio segments");
  }
  const decode = deps?.decodeAudio ?? defaultDecodeAudio;
  const decoded = await Promise.all(blobs.map((blob) => decode(blob)));
  const first = decoded[0];
  if (!first || first.channels.length === 0) {
    throw new Error("nothing to save: the first segment decoded to no audio");
  }
  const sampleRate = first.sampleRate;
  const channelCount = first.channels.length;
  for (let i = 1; i < decoded.length; i += 1) {
    const segment = decoded[i];
    if (!segment || segment.channels.length === 0) {
      throw new Error(`segment ${i} decoded to no audio — re-narrate before saving`);
    }
    if (segment.sampleRate !== sampleRate || segment.channels.length !== channelCount) {
      throw new Error(
        `segment ${i} has a different format (${segment.sampleRate} Hz × ${segment.channels.length}) ` +
          `than the first (${sampleRate} Hz × ${channelCount}) — re-narrate before saving`,
      );
    }
  }
  if (channelCount !== 1 && channelCount !== 2) {
    throw new Error(`unsupported channel count for OGG save: ${channelCount} (mono/stereo only)`);
  }
  const channels: 1 | 2 = channelCount === 2 ? 2 : 1;

  const load = deps?.loadEncoder ?? defaultLoadEncoder;
  const encoder = await load();
  encoder.configure({ channels, sampleRate });
  const parts: Uint8Array[] = [];
  let totalSamples = 0;
  for (const segment of decoded) {
    // encode() output is encoder-owned — copy before the next call.
    parts.push(encoder.encode(segment.channels).slice());
    const frames = segment.channels[0]?.length ?? 0;
    totalSamples += frames;
  }
  parts.push(encoder.finalize().slice());
  const totalBytes = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, sampleRate, channels: channelCount, durationSec: totalSamples / sampleRate, blobCount: blobs.length };
}
