/**
 * Pure Float32 → 16-bit PCM WAV encoder for the Kokoro in-browser path.
 *
 * kokoro-js emits `RawAudio` (Float32 samples at 24 kHz); playback surfaces
 * (the `<audio>` preview, the serial narration queue) consume WAV Blobs, so
 * the client encodes once per generated paragraph. Pure and total: samples are
 * clamped to [-1, 1]; NaN/Infinity map to 0 (defensive against a malformed
 * waveform); no DOM.
 */

/** Bytes per sample (16-bit signed little-endian). */
const BYTES_PER_SAMPLE = 2;

const MAX_AMPLITUDE = 1;

export function float32ToWavBytes(pcm: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataLength = pcm.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true); // RIFF chunk size
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i];
    // NaN / ±Infinity → silence; everything else clamps into [-1, 1].
    // Full-scale is asymmetric (−32768..32767): scaling by 0x8000 would wrap
    // +1.0 around to the negative extreme, so positives scale by 0x7fff.
    const clamped =
      Number.isFinite(sample)
        ? Math.min(MAX_AMPLITUDE, Math.max(-MAX_AMPLITUDE, sample))
        : 0;
    const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(scaled), true);
    offset += BYTES_PER_SAMPLE;
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
