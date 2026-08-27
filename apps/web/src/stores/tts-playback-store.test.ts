import { describe, expect, test, beforeEach } from "bun:test";
import { useTtsPlaybackStore, __setTtsPlaybackDepsForTests } from "./tts-playback-store.js";
import type { NarrationPlayer } from "../lib/tts/narration-player.js";
import type { TtsProfileRecord } from "../api/tts-api.js";

function profile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
  return {
    id: "p1",
    name: "Test",
    backend: "openai",
    config: {},
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
});
