/**
 * Test-audio synthesis for the STT tab's Test Connection button
 * (STT_PLAN ST-4a).
 *
 * The STT test flow has NO draft-transcribe route (ST-5b scope: only saved
 * profiles transcribe). Testing a saved profile therefore needs a real
 * audio clip — and the cheapest honest one is a tiny SILENT WAV: it proves
 * the full path (multipart upload → server → OpenAI-compatible backend →
 * response) without depending on a microphone or an asset file. Whisper
 * returns an empty transcript for pure silence, which is still a successful
 * transcription round-trip (a 200 + `{text: ""}` JSON).
 *
 * Pure function, no deps — DataView-built RIFF/WAVE (44-byte header, PCM16
 * mono, ~0.05s at 16 kHz = 800 silent samples).
 */

const SAMPLE_RATE = 16_000;
const SECONDS = 0.05;
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * SECONDS);
const BYTES_PER_SAMPLE = 2; // PCM16
const DATA_BYTES = NUM_SAMPLES * BYTES_PER_SAMPLE;
const HEADER_BYTES = 44;

/** Build the silent test-clip WAV Blob (RIFF + WAVE + fmt + data). */
export function buildSilentTestWav(): Blob {
  const buffer = new ArrayBuffer(HEADER_BYTES + DATA_BYTES);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + DATA_BYTES, true); // RIFF chunk size (file − 8)
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, DATA_BYTES, true);
  // The byte range after the header is zero-initialized — that IS the
  // silence (PCM16 zero = no signal).
  return new Blob([buffer], { type: "audio/wav" });
}