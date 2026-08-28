import { describe, expect, test } from "bun:test";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import { createTtsOrchestrator, GENERATION_LOOKAHEAD_CAP, INTER_SYNTHESIS_YIELD_MS } from "./tts-orchestrator.js";
import type { NarrationState } from "./tts-orchestrator.js";
import type { NarrationPlayer, SegmentPlayResult } from "./narration-player.js";

function profile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
  return {
    id: "p1",
    name: "Test",
    backend: "openai",
    config: {},
    hasStoredApiKey: false,
    providerRef: null,
    voiceId: "alloy",
    narratorVoiceId: null,
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
  fn: (text: string, profile: TtsProfileRecord, voiceId: string) => Promise<{ blob: Blob; mime: string }>;
  calls: Array<{ text: string; voiceId: string }>;
  deferreds: Array<{ text: string; voiceId: string; resolve: (v: { blob: Blob; mime: string }) => void; reject: (e: Error) => void }>;
  resolveNext(blobText?: string): void;
  rejectNext(message?: string): void;
} {
  const calls: Array<{ text: string; voiceId: string }> = [];
  const deferreds: Array<{ text: string; voiceId: string; resolve: (v: { blob: Blob; mime: string }) => void; reject: (e: Error) => void }> = [];
  const fn = (text: string, _profile: TtsProfileRecord, voiceId: string): Promise<{ blob: Blob; mime: string }> => {
    calls.push({ text, voiceId });
    return new Promise<{ blob: Blob; mime: string }>((resolve, reject) => {
      deferreds.push({ text, voiceId, resolve, reject });
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
  /** Advance past the paced generation's inter-synthesis yield (+margin). */
  async function genTick(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, INTER_SYNTHESIS_YIELD_MS + 40));
  }

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
    expect(synth.calls.map((c) => c.text)).toEqual(["Para one."]);
    // Resolve first
    synth.resolveNext();
    await genTick();
    // After first resolves, second synthesize starts
    expect(synth.calls.map((c) => c.text)).toEqual(["Para one.", "Para two."]);
    synth.resolveNext();
    await genTick();
    expect(synth.calls.map((c) => c.text)).toEqual(["Para one.", "Para two.", "Para three."]);
    synth.resolveNext();
    await genTick();

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
    expect(synth.calls.map((c) => c.text)).toEqual(["Para one.", "Para two.", "Para three."]);
    const last = states.at(-1);
    expect(last?.status).toBe("complete");
    expect(last?.total).toBe(3);
    expect(last?.played).toBe(3);
  });

  test("dual-voice: narrator profile splits quoted vs narrator runs with role-resolved voiceId", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const dualProfile = profile({ voiceId: "alloy", narratorVoiceId: "verse" });
    const text = 'Intro narration. "Hello there!" More narration here.';
    const p = orch.narrate("m-dual", text, dualProfile);
    await Promise.resolve();
    // First segment should be the leading narration chunk
    expect(synth.calls.length).toBe(1);
    expect(synth.calls[0]!.voiceId).toBe("verse");
    expect(synth.calls[0]!.text).toBe("Intro narration. ");
    synth.resolveNext();
    await genTick();
    expect(synth.calls[1]!.voiceId).toBe("alloy");
    expect(synth.calls[1]!.text).toBe("Hello there!");
    synth.resolveNext();
    await genTick();
    expect(synth.calls[2]!.voiceId).toBe("verse");
    expect(synth.calls[2]!.text).toBe(" More narration here.");
    synth.resolveNext();
    await genTick();
    // Drain playback
    for (let i = 0; i < 5; i++) {
      player.resolveCurrent("ended");
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await p;
    // Narrator runs all use narratorVoiceId, quoted runs use voiceId
    expect(synth.calls.every((c) => c.voiceId === "alloy" || c.voiceId === "verse")).toBe(true);
    expect(synth.calls.filter((c) => c.voiceId === "verse").length).toBe(2);
    expect(synth.calls.filter((c) => c.voiceId === "alloy").length).toBe(1);
  });

  test("narrator-empty profile still synthesizes per paragraph with voiceId = profile.voiceId", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: () => {},
    });
    // Quotes present but no narrator — should NOT split by role
    const emptyProfile = profile({ voiceId: "alloy", narratorVoiceId: null });
    const text = 'Intro "quoted" tail.\n\nSecond para.';
    const p = orch.narrate("m-plain", text, emptyProfile);
    await Promise.resolve();
    expect(synth.calls[0]!.text).toBe('Intro "quoted" tail.');
    expect(synth.calls[0]!.voiceId).toBe("alloy");
    synth.resolveNext();
    await genTick();
    expect(synth.calls[1]!.text).toBe("Second para.");
    expect(synth.calls[1]!.voiceId).toBe("alloy");
    synth.resolveNext();
    await genTick();
    player.resolveCurrent("ended");
    await new Promise<void>((r) => setTimeout(r, 0));
    player.resolveCurrent("ended");
    await new Promise<void>((r) => setTimeout(r, 0));
    await p;
    expect(synth.calls.length).toBe(2);
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
    await genTick();
    synth.resolveNext();
    await genTick();
    synth.resolveNext();
    await genTick();

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
    expect(synth.calls.map((c) => c.text)).toEqual(["Para one."]);
    synth.resolveNext();
    // After first resolves, playback should start immediately; the second
    // synthesize starts after the inter-synthesis yield (TE2-14 pacing).
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(player.calls.length).toBeGreaterThanOrEqual(1);
    await genTick();
    expect(synth.calls.length).toBeGreaterThanOrEqual(2);
    // Third synthesize should NOT yet be resolved (still pending deferred)
    expect(synth.deferreds.length).toBeGreaterThanOrEqual(1);

    // Pipelining assertion already checked above; now drain remaining.
    // Generation creates deferreds lazily, so resolve in a loop with ticks.
    for (let iter = 0; iter < 10 && (synth.deferreds.length > 0 || synth.calls.length < 3); iter++) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    // Drain any remaining deferreds
    while (synth.deferreds.length > 0) {
      synth.resolveNext();
      await genTick();
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
    await genTick();
    synth.resolveNext();
    await genTick();
    synth.resolveNext();
    await genTick();
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
    // Let the paced second call START so a pending deferred exists (the pin:
    // its late resolve after stop must be dropped).
    await genTick();
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
    await genTick();
    synth.resolveNext();
    await genTick();
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

  test("TE2-14 pacing: generation caps at 3 queued segments and resumes on drain", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const text = "S1.\n\nS2.\n\nS3.\n\nS4.\n\nS5.\n\nS6.";
    const p = orch.narrate("m-cap", text, profile());
    // Resolve every synthesize as it appears until calls stop growing.
    for (let iter = 0; iter < 12; iter++) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    // 1 playing + 3 queued = cap reached: the 5th call must NOT have started.
    expect(synth.calls.length).toBe(GENERATION_LOOKAHEAD_CAP + 1);
    // Playback drains one segment → generation wakes and synthesizes the 5th.
    player.resolveCurrent("ended");
    for (let iter = 0; iter < 12 && synth.calls.length < GENERATION_LOOKAHEAD_CAP + 2; iter++) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    expect(synth.calls.length).toBe(GENERATION_LOOKAHEAD_CAP + 2);
    // Drain everything to completion.
    for (let iter = 0; iter < 24; iter++) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      player.resolveCurrent("ended");
      await genTick();
      if (states.at(-1)?.status === "complete") break;
    }
    await p;
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.played).toBe(6);
    expect(synth.calls.length).toBe(6);
  });

  test("TE2-14 pacing: stop() while generation waits at the cap unblocks narrate", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const text = "S1.\n\nS2.\n\nS3.\n\nS4.\n\nS5.";
    const p = orch.narrate("m-stop", text, profile());
    for (let iter = 0; iter < 12; iter++) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    expect(synth.calls.length).toBe(GENERATION_LOOKAHEAD_CAP + 1); // parked at the cap
    orch.stop();
    await p; // must not hang: the parked generator must be woken and retired
    expect(synth.calls.length).toBe(GENERATION_LOOKAHEAD_CAP + 1);
    expect(states.at(-1)?.status).toBe("complete");
  });

  test("TE2-14 pacing: consecutive syntheses are spaced by the inter-synthesis yield", async () => {
    const player: NarrationPlayer = {
      play: () => Promise.resolve("ended"),
      skipCurrent(): void {},
      pause(): void {},
      resume(): void {},
      setRate(): void {},
      dispose(): void {},
    };
    const stamps: number[] = [];
    const synth = createDeferredSynthesize();
    const wrapped = (text: string, profileArg: TtsProfileRecord, voiceId: string) => {
      stamps.push(Date.now());
      return synth.fn(text, profileArg, voiceId);
    };
    const orch = createTtsOrchestrator({
      synthesize: wrapped,
      player,
      onState: () => {},
    });

    const text = "A.\n\nB.\n\nC.";
    const p = orch.narrate("m-yield", text, profile());
    for (let iter = 0; iter < 12 && stamps.length < 3; iter++) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    // Drain the final pending deferred so generation can finish.
    while (synth.deferreds.length > 0) {
      synth.resolveNext();
      await genTick();
    }
    await p;
    expect(stamps.length).toBe(3);
    // Two yields between three calls: total span ≥ 2 × yield.
    expect(stamps[2]! - stamps[0]!).toBeGreaterThanOrEqual(2 * INTER_SYNTHESIS_YIELD_MS);
  });
});
