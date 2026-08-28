import { describe, expect, test, beforeEach } from "bun:test";
import { useTtsPlaybackStore, __setTtsPlaybackDepsForTests } from "./tts-playback-store.js";
import type { NarrationPlayer } from "../lib/tts/narration-player.js";
import type { TtsProfileRecord } from "../api/tts-api.js";
import { chunkNarrationText } from "../lib/tts/kokoro/kokoro-text.js";
import {
  __resetSharedKokoroClientForTests,
  __setKokoroWorkerFactoryForTests,
} from "../lib/tts/kokoro/kokoro-client-instance.js";

function profile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
  return {
    id: "p1",
    name: "Test",
    backend: "openai",
    config: {},
    hasStoredApiKey: false,
    voiceId: "alloy",
    lang: "en",
    sortOrder: 0,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createFakePlayer(): NarrationPlayer & { playCalls: number } {
  let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
  const state = { playCalls: 0 };
  const player: NarrationPlayer & typeof state = Object.assign(
    {
      play(_blob: Blob, _rate: number): Promise<"ended" | "skipped" | "error"> {
        state.playCalls += 1;
        return new Promise<"ended" | "skipped" | "error">((resolve) => {
          currentResolve = resolve;
          // Auto-resolve quickly so narrate completes
          queueMicrotask(() => {
            const fn = currentResolve;
            currentResolve = null;
            if (fn) fn("ended");
          });
        });
      },
      skipCurrent(): void {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn("skipped");
      },
      pause(): void {},
      resume(): void {},
      setRate(): void {},
      dispose(): void {
        if (currentResolve) {
          const fn = currentResolve;
          currentResolve = null;
          fn("skipped");
        }
      },
    },
    state,
  );
  return player;
}

beforeEach(() => {
  useTtsPlaybackStore.setState({ narrations: {}, rate: 1, autoNarrate: false });
  __setTtsPlaybackDepsForTests(null);
});

describe("tts-playback-store", () => {
  test("autoNarrate defaults to false", () => {
    expect(useTtsPlaybackStore.getState().autoNarrate).toBe(false);
  });

  test("setAutoNarrate flips the flag", () => {
    useTtsPlaybackStore.getState().setAutoNarrate(true);
    expect(useTtsPlaybackStore.getState().autoNarrate).toBe(true);
    useTtsPlaybackStore.getState().setAutoNarrate(false);
    expect(useTtsPlaybackStore.getState().autoNarrate).toBe(false);
  });

  test("startNarration records state into narrations[messageId]; stopNarration clears playback", async () => {
    const player = createFakePlayer();
    const synthesize = async (text: string): Promise<{ blob: Blob; mime: string }> => ({
      blob: new Blob([text], { type: "audio/mpeg" }),
      mime: "audio/mpeg",
    });
    __setTtsPlaybackDepsForTests({ player, synthesize });

    await useTtsPlaybackStore.getState().startNarration("m1", "Hello.\n\nWorld.", profile());
    const narr = useTtsPlaybackStore.getState().narrations["m1"];
    expect(narr).toBeDefined();
    expect(narr?.status).toBe("complete");
    expect(narr?.total).toBe(2);

    // Start another narration then stop
    const slowSynthesize = (text: string): Promise<{ blob: Blob; mime: string }> =>
      new Promise<{ blob: Blob; mime: string }>((resolve) => {
        setTimeout(() => resolve({ blob: new Blob([text], { type: "audio/mpeg" }), mime: "audio/mpeg" }), 50);
      });
    __setTtsPlaybackDepsForTests({ player: createFakePlayer(), synthesize: slowSynthesize });
    const p = useTtsPlaybackStore.getState().startNarration("m2", "A.\n\nB.\n\nC.", profile());
    // Stop quickly before it completes
    useTtsPlaybackStore.getState().stopNarration();
    await p;
    const narr2 = useTtsPlaybackStore.getState().narrations["m2"];
    expect(narr2?.status).toBe("complete");
  });

  test("setRate updates store rate", () => {
    useTtsPlaybackStore.getState().setRate(1.5);
    expect(useTtsPlaybackStore.getState().rate).toBe(1.5);
    useTtsPlaybackStore.getState().setRate(1);
    expect(useTtsPlaybackStore.getState().rate).toBe(1);
  });

  // D10 boundary pin: a kokoro narration sends MODEL-SAFE chunks to the
  // worker, never the whole segment (kokoro-js caps generation internally —
  // unchunked text truncates the audio mid-message). Covers the real path
  // startNarration → defaultSynthesize → shared client → worker transport.
  test("kokoro narration synthesizes each paragraph in ≤400-char chunks via the shared client", async () => {
    const seenRequests: { type: string; text?: string }[] = [];
    let handler: ((event: { data: unknown }) => void) | null = null;
    const worker = {
      postMessage(request: { type: string }) {
        seenRequests.push(request as { type: string; text?: string });
        if (request.type === "load") {
          queueMicrotask(() => handler?.({ data: { type: "loaded" } }));
        } else if (request.type === "generate") {
          const req = request as { type: string; id: number };
          queueMicrotask(() =>
            handler?.({ data: { type: "generated", id: req.id, audio: new Float32Array([0.5]), sampleRate: 24000 } }),
          );
        }
      },
      terminate() {
        handler = null;
      },
      set onmessage(h: ((event: { data: unknown }) => void) | null) {
        handler = h;
      },
      get onmessage() {
        return handler;
      },
    };
    __setKokoroWorkerFactoryForTests(() => worker);
    __resetSharedKokoroClientForTests();
    try {
      // Player seam only — synthesize stays the DEFAULT so the real
      // kokoro wiring runs; the fake worker replaces the real thread.
      __setTtsPlaybackDepsForTests({ player: createFakePlayer() });

      const para =
        "She moves through the corridor with slow deliberate steps, counting the doors as she passes them, " +
        "because numbers are the only thing in this house that still behaves. Ten. Eleven. Twelve. " +
        "The thirteenth door is where the sound comes from, and she stops there, palm flat against the wood, " +
        "listening for breathing that is not her own. ".repeat(2).trim();
      const longPara = (para + "Extra tail sentence to push it over the limit. ").repeat(3).trim();
      const message = `${para}\n\n${longPara}\n\nshort end`;
      const kokoro = profile({ backend: "kokoro", voiceId: "af_heart", config: { speed: 1.1 } });

      await useTtsPlaybackStore.getState().startNarration("m1", message, kokoro);

      const narr = useTtsPlaybackStore.getState().narrations["m1"];
      expect(narr?.status).toBe("complete");
      // One paragraph per segment…
      expect(narr?.total).toBe(3);

      const gens = seenRequests.filter((r) => r.type === "generate");
      const expectedChunks = [...chunkNarrationText(para), ...chunkNarrationText(longPara), ...chunkNarrationText("short end")];
      expect(gens.map((r) => r.text)).toEqual(expectedChunks);
      // …and every request is model-safe length.
      for (const gen of gens) expect((gen.text as string).length).toBeLessThanOrEqual(400);
      expect(gens.length).toBeGreaterThan(3); // chunking actually engaged
      expect(seenRequests.filter((r) => r.type === "load")).toHaveLength(1);
    } finally {
      __setKokoroWorkerFactoryForTests(null);
      __resetSharedKokoroClientForTests();
      __setTtsPlaybackDepsForTests(null);
    }
  });
});
