import { describe, expect, test } from "bun:test";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import { createTtsOrchestrator } from "./tts-orchestrator.js";
import type { NarrationState } from "./tts-orchestrator.js";
import type { NarrationPlayer, SegmentPlayResult } from "./narration-player.js";

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

function fakeBlob(text: string): Blob {
  return new Blob([text], { type: "audio/mpeg" });
}

// ── Fake player (deferred promises per segment for precise control) ───────

function createDeferredPlayer(): NarrationPlayer & {
  calls: Array<{ text: string; rate: number }>;
  maxConcurrent: number;
  resolveCurrent(result?: SegmentPlayResult): void;
  failCurrent(): void;
} {
  let concurrent = 0;
  let maxConcurrent = 0;
  const calls: Array<{ text: string; rate: number }> = [];
  let currentResolve: ((v: SegmentPlayResult) => void) | null = null;
  let currentRate = 1;

  const player: NarrationPlayer & {
    calls: typeof calls;
    maxConcurrent: number;
    resolveCurrent(result?: SegmentPlayResult): void;
    failCurrent(): void;
  } = {
    get calls() {
      return calls;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    play(blob: Blob, rate: number): Promise<SegmentPlayResult> {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      currentRate = rate;
      // Capture text synchronously via size? Use blob.text async but track via closure.
      // For test assertions we record via synthesize mapping; here just track rate.
      return new Promise<SegmentPlayResult>((resolve) => {
        currentResolve = (r: SegmentPlayResult) => {
          concurrent -= 1;
          resolve(r);
        };
        // Read text for calls array
        blob.text().then((t) => calls.push({ text: t, rate }));
      });
    },
    skipCurrent(): void {
      const fn = currentResolve;
      currentResolve = null;
      if (fn) {
        concurrent -= 1;
        fn("skipped");
      }
    },
    pause(): void {},
    resume(): void {},
    setRate(rate: number): void {
      currentRate = rate;
    },
    dispose(): void {
      if (currentResolve) {
        const fn = currentResolve;
        currentResolve = null;
        concurrent -= 1;
        fn("skipped");
      }
    },
    resolveCurrent(result: SegmentPlayResult = "ended"): void {
      const fn = currentResolve;
      currentResolve = null;
      if (fn) {
        concurrent -= 1;
        fn(result);
      }
    },
    failCurrent(): void {
      const fn = currentResolve;
      currentResolve = null;
      if (fn) {
        concurrent -= 1;
        fn("error");
      }
    },
  };
  return player;
}

// ── Helpers for deferred synthesize ────────────────────────────────────────

function createDeferredSynthesize(): {
  fn: (text: string, profile: TtsProfileRecord) => Promise<{ blob: Blob; mime: string }>;
  calls: string[];
  deferreds: Array<{ text: string; resolve: (v: { blob: Blob; mime: string }) => void; reject: (e: Error) => void }>;
  resolveNext(blobText?: string): void;
  rejectNext(message?: string): void;
} {
  const calls: string[] = [];
  const deferreds: Array<{ text: string; resolve: (v: { blob: Blob; mime: string }) => void; reject: (e: Error) => void }> = [];
  const fn = (text: string, _profile: TtsProfileRecord): Promise<{ blob: Blob; mime: string }> => {
    calls.push(text);
    return new Promise<{ blob: Blob; mime: string }>((resolve, reject) => {
      deferreds.push({ text, resolve, reject });
    });
  };
  return {
    fn,
    calls,
    deferreds,
    resolveNext(blobText?: string): void {
      const d = deferreds.shift();
      if (d) d.resolve({ blob: fakeBlob(blobText ?? d.text), mime: "audio/mpeg" });
    },
    rejectNext(message = "synthesize failed"): void {
      const d = deferreds.shift();
      if (d) d.reject(new Error(message));
    },
  };
}

describe("TtsOrchestrator", () => {
  test("paragraph dispatch: 3-paragraph text → synthesize called 3× with exact paragraphs", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const text = "Para one.\n\nPara two.\n\nPara three.";
    const narratePromise = orch.narrate("m1", text, profile());

    // Let generation start; first synthesize call is pending.
    await Promise.resolve();
    expect(synth.calls).toEqual(["Para one."]);
    // Resolve first
    synth.resolveNext();
    await Promise.resolve();
    // After first resolves, second synthesize starts
    expect(synth.calls).toEqual(["Para one.", "Para two."]);
    synth.resolveNext();
    await Promise.resolve();
    expect(synth.calls).toEqual(["Para one.", "Para two.", "Para three."]);
    synth.resolveNext();
    await Promise.resolve();

    // Now playback: first segment should be playing; resolve it
    // Drive playback to completion
    player.resolveCurrent("ended");
    await Promise.resolve();
    // Allow next play to start
    await new Promise<void>((r) => setTimeout(r, 0));
    player.resolveCurrent("ended");
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
    player.resolveCurrent("ended");
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));

    await narratePromise;
    expect(synth.calls).toEqual(["Para one.", "Para two.", "Para three."]);
    const last = states.at(-1);
    expect(last?.status).toBe("complete");
    expect(last?.total).toBe(3);
    expect(last?.played).toBe(3);
  });

  test("serial playback: never more than one concurrent play", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: () => {},
    });

    const text = "A.\n\nB.\n\nC.";
    const p = orch.narrate("m1", text, profile());
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();

    // Resolve sequentially, checking maxConcurrent stays 1
    player.resolveCurrent("ended");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(player.maxConcurrent).toBe(1);
    player.resolveCurrent("ended");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(player.maxConcurrent).toBe(1);
    player.resolveCurrent("ended");
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(player.maxConcurrent).toBe(1);

    await p;
    expect(player.maxConcurrent).toBe(1);
  });

  test("pipelining: first blob starts playing before later synthesizes resolve", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const text = "Para one.\n\nPara two.\n\nPara three.";
    const p = orch.narrate("m1", text, profile());
    await Promise.resolve();
    // Only first synthesize pending
    expect(synth.calls).toEqual(["Para one."]);
    synth.resolveNext();
    // After first resolves, playback should start and second synthesize should be pending
    await Promise.resolve();
    await Promise.resolve();
    // Player should have been called for first paragraph already
    expect(player.calls.length).toBeGreaterThanOrEqual(1);
    // Second and third synthesizes may be in flight or queued; at least second call exists
    // Due to sequential generation, second call should exist now
    expect(synth.calls.length).toBeGreaterThanOrEqual(2);
    // Third synthesize should NOT yet be resolved (still pending deferred)
    expect(synth.deferreds.length).toBeGreaterThanOrEqual(1);

    // Pipelining assertion already checked above; now drain remaining.
    // Generation creates deferreds lazily, so resolve in a loop with ticks.
    for (let iter = 0; iter < 10 && (synth.deferreds.length > 0 || synth.calls.length < 3); iter++) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    // Drain any remaining deferreds
    while (synth.deferreds.length > 0) {
      synth.resolveNext();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    // Drain playback
    for (let i = 0; i < 5; i++) {
      player.resolveCurrent("ended");
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await p;
  });

  test("skipSegment resolves current and advances to next", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const text = "A.\n\nB.\n\nC.";
    const p = orch.narrate("m1", text, profile());
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));

    // First segment is playing; skip it
    orch.skipSegment();
    await new Promise<void>((r) => setTimeout(r, 0));
    // Second segment should now be playing
    expect(player.calls.length).toBeGreaterThanOrEqual(2);

    // Finish remaining
    player.resolveCurrent("ended");
    await new Promise<void>((r) => setTimeout(r, 0));
    player.resolveCurrent("ended");
    await new Promise<void>((r) => setTimeout(r, 0));

    await p;
    const last = states.at(-1);
    expect(last?.status).toBe("complete");
  });

  test("stop clears queue: pending synthesize late resolve is no-op", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const text = "A.\n\nB.\n\nC.";
    const p = orch.narrate("m1", text, profile());
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    // Stop before second synthesize resolves
    orch.stop();
    await Promise.resolve();
    const callsAfterStop = player.calls.length;
    // Resolve pending synthesize (should be dropped)
    if (synth.deferreds.length > 0) synth.resolveNext();
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
    // No new play calls after stop
    expect(player.calls.length).toBe(callsAfterStop);

    await p;
    const last = states.at(-1);
    expect(last?.status).toBe("complete");
  });

  test("setRate reaches player for subsequent segments", async () => {
    const rates: number[] = [];
    const player: NarrationPlayer = {
      play(_blob: Blob, rate: number): Promise<SegmentPlayResult> {
        rates.push(rate);
        return Promise.resolve("ended");
      },
      skipCurrent(): void {},
      pause(): void {},
      resume(): void {},
      setRate(): void {},
      dispose(): void {},
    };
    let setRateArgs: number[] = [];
    const origSetRate = player.setRate.bind(player);
    player.setRate = (rate: number): void => {
      setRateArgs.push(rate);
      origSetRate(rate);
    };

    const synth = createDeferredSynthesize();
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: () => {},
    });

    orch.setRate(1.5);
    const text = "A.\n\nB.";
    const p = orch.narrate("m1", text, profile());
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    synth.resolveNext();
    await Promise.resolve();
    await p;

    expect(setRateArgs).toContain(1.5);
    // At least one play should have used 1.5
    expect(rates).toContain(1.5);
  });

  test("synthesize rejection → error state, queue cleared", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const text = "A.\n\nB.";
    const p = orch.narrate("m1", text, profile());
    await Promise.resolve();
    synth.rejectNext("network boom");
    await Promise.resolve();
    await p;

    const last = states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toContain("network boom");
    expect(player.calls.length).toBe(0);
  });

  test("empty/whitespace text → zero synthesize calls, immediate complete", async () => {
    const player = createDeferredPlayer();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: async () => {
        throw new Error("must not be called");
      },
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    await orch.narrate("m1", "   \n\n  ", profile());
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.total).toBe(0);
    expect(player.calls.length).toBe(0);
  });
});
