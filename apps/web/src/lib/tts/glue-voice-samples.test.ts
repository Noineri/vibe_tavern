/**
 * TPE-11 — pure glue core: order, gaps, mono mix, wav bytes, passthrough,
 * size cap, decode failure. The decode seam is faked (no AudioContext in
 * happy-dom); the browser impl itself is one trivial pass-through to
 * decodeAudioData.
 */
import { describe, expect, test } from "bun:test";

import {
  GLUE_GAP_SECONDS,
  GlueVoiceSamplesError,
  glueVoiceSamples,
  monoMix,
  type RawVoiceSampleDecoder,
} from "./glue-voice-samples.js";

function fakeDecoder(byName: Record<string, { channels: number[][]; sampleRate: number }>): RawVoiceSampleDecoder {
  return async (file: File) => {
    const entry = byName[file.name];
    if (entry === undefined) throw new Error(`undecodable: ${file.name}`);
    return { channels: entry.channels.map((c) => Float32Array.from(c)), sampleRate: entry.sampleRate };
  };
}

function makeFile(name: string): File {
  return new File([new Uint8Array([1])], name, { type: "audio/mpeg" });
}

/** Canonical 44-byte WAV header (the shared encoder's output shape). */
function parseWav(bytes: Uint8Array): { sampleRate: number; channels: number; dataSamples: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const wave = String.fromCharCode(...bytes.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error("not a wav");
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    dataSamples: view.getUint32(40, true) / 2, // 16-bit mono
  };
}

describe("monoMix", () => {
  test("stereo averages to mono; mono passes through by reference", () => {
    const stereo = monoMix({
      channels: [Float32Array.from([0.5, -0.5]), Float32Array.from([0.25, 0.25])],
      sampleRate: 8000,
    });
    expect(Array.from(stereo)).toEqual([0.375, -0.125]);
    const mono = Float32Array.from([1, 2]);
    expect(monoMix({ channels: [mono], sampleRate: 8000 })).toBe(mono);
  });
});

describe("glueVoiceSamples", () => {
  test("single sample passes through untouched (original File identity, no re-encode)", async () => {
    const only = makeFile("a.mp3");
    const result = await glueVoiceSamples(
      [only],
      fakeDecoder({ "a.mp3": { channels: [[0, 0, 0, 0, 0, 0, 0, 0]], sampleRate: 8000 } }),
      1024,
    );
    expect(result.file).toBe(only);
    // 8 samples at 8 kHz = 1 ms.
    expect(result.totalSeconds).toBe(0.001);
    expect(result.sampleDurations).toEqual([0.001]);
  });

  test("two samples glue in selection order with a 0.4 s zero gap between", async () => {
    // Two 1-second samples at 1000 Hz: A = constant 0.25, B = constant -0.25.
    const decode = fakeDecoder({
      "a.mp3": { channels: [new Array(1000).fill(0.25)], sampleRate: 1000 },
      "b.mp3": { channels: [new Array(1000).fill(-0.25)], sampleRate: 1000 },
    });
    const result = await glueVoiceSamples([makeFile("a.mp3"), makeFile("b.mp3")], decode, 10 * 1024 * 1024);

    expect(result.sampleDurations).toEqual([1, 1]);
    expect(result.totalSeconds).toBe(2 + GLUE_GAP_SECONDS);
    expect(result.file.name).toBe("voice-samples.wav");
    expect(result.file.type).toBe("audio/wav");

    const parsed = parseWav(new Uint8Array(await result.file.arrayBuffer()));
    expect(parsed.sampleRate).toBe(1000);
    expect(parsed.channels).toBe(1);
    expect(parsed.dataSamples).toBe(2400);

    // Body: A(0.25) → gap(silence) → B(−0.25) — order and gap pinned.
    const view = new DataView((await result.file.arrayBuffer()) as ArrayBuffer);
    const sampleAt = (i: number) => view.getInt16(44 + i * 2, true);
    expect(sampleAt(0)).toBe(Math.round(0.25 * 0x7fff));
    expect(sampleAt(999)).toBe(Math.round(0.25 * 0x7fff));
    expect(sampleAt(1000)).toBe(0);
    expect(sampleAt(1399)).toBe(0);
    expect(sampleAt(1400)).toBe(Math.round(-0.25 * 0x8000));
    expect(sampleAt(2399)).toBe(Math.round(-0.25 * 0x8000));
  });

  test("glued wav above the byte cap → typed size error", async () => {
    const decode = fakeDecoder({
      "a.mp3": { channels: [new Array(100).fill(0.1)], sampleRate: 1000 },
      "b.mp3": { channels: [new Array(100).fill(0.1)], sampleRate: 1000 },
    });
    let caught: unknown = null;
    try {
      await glueVoiceSamples([makeFile("a.mp3"), makeFile("b.mp3")], decode, 45); // header alone is 44 B
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof GlueVoiceSamplesError).toBe(true);
    expect((caught as GlueVoiceSamplesError).code).toBe("size");
  });

  test("undecodable sample → typed decode error", async () => {
    let caught: unknown = null;
    try {
      await glueVoiceSamples([makeFile("a.mp3"), makeFile("broken.ogg")], fakeDecoder({ "a.mp3": { channels: [[0]], sampleRate: 1000 } }), 10 * 1024 * 1024);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof GlueVoiceSamplesError).toBe(true);
    expect((caught as GlueVoiceSamplesError).code).toBe("decode");
  });

  test("empty selection is a programming error, not a UI path", async () => {
    await expect(glueVoiceSamples([], fakeDecoder({}), 1024)).rejects.toThrow("no files");
  });
});
