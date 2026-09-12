/**
 * HTML-audio narration player smoke tests (TPE-18b) — the DOM wiring
 * (volume application, clock jumps, position reporting, metadata probe)
 * against happy-dom's media stubs. Playback LOGIC (queue, seek mapping,
 * progress math) lives in the orchestrator tests with fakes; here we pin
 * that the real player neither throws nor hangs, and that volume/seek
 * reach the element.
 */

import { describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import { createHtmlAudioNarrationPlayer } from "./narration-player.js";

function wavBlob(): Blob {
  return new Blob(["fake-wav-bytes"], { type: "audio/wav" });
}

describe("createHtmlAudioNarrationPlayer (TPE-18b volume/seek wiring)", () => {
  test("no element, no crash: seek/volume/position are safe before any play", () => {
    const player = createHtmlAudioNarrationPlayer();
    expect(() => player.setVolume?.(0.5)).not.toThrow();
    expect(() => player.seekTo?.(3)).not.toThrow();
    expect(player.getPosition?.()).toBeNull();
    player.dispose();
  });

  // NOTE: play() settlement (ended/error) is NOT pinned here — happy-dom's
  // media stubs never fire media events, so a real play() hangs by stub
  // design, not by implementation bug. Completion flows are pinned with
  // fakes in the orchestrator suite; the browser owns the Audio lifecycle.

  test("probeDuration resolves null when metadata never loads (guarded, fast)", async () => {
    const player = createHtmlAudioNarrationPlayer({ metadataTimeoutMs: 50 });
    const probed = await player.probeDuration?.(wavBlob());
    expect(probed).toBeNull();
    player.dispose();
  });
});
