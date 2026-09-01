/**
 * Silent-WAV builder (STT_PLAN ST-4a): a structurally valid RIFF/WAVE file —
 * 44-byte header + PCM16 mono zero samples at 16 kHz.
 */

import { describe, expect, test } from "bun:test";

import { buildSilentTestWav } from "./test-audio.js";

function headerAscii(view: DataView, offset: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe("buildSilentTestWav", () => {
  test("produces an audio/wav Blob", () => {
    const blob = buildSilentTestWav();
    expect(blob.type).toBe("audio/wav");
  });

  test("RIFF/WAVE magic + correct chunk sizes", async () => {
    const blob = buildSilentTestWav();
    const view = new DataView(await blob.arrayBuffer());
    expect(headerAscii(view, 0, 4)).toBe("RIFF");
    expect(headerAscii(view, 8, 4)).toBe("WAVE");
    // RIFF chunk size = file length − 8
    expect(view.getUint32(4, true)).toBe(blob.size - 8);
    // fmt chunk: PCM16 mono at 16 kHz
    expect(headerAscii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    // data chunk: 0.05s × 16 kHz × 2 bytes
    expect(headerAscii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(0.05 * 16_000 * 2);
  });

  test("samples are silent (all zero)", async () => {
    const blob = buildSilentTestWav();
    const view = new DataView(await blob.arrayBuffer());
    const dataBytes = view.getUint32(40, true);
    let nonzero = 0;
    for (let i = 0; i < dataBytes; i += 2) {
      if (view.getInt16(44 + i, true) !== 0) nonzero += 1;
    }
    expect(nonzero).toBe(0);
  });
});