import { describe, expect, test } from "bun:test";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import { createTtsOrchestrator, GENERATION_LOOKAHEAD_CAP, INTER_SYNTHESIS_YIELD_MS } from "./tts-orchestrator.js";
import type { NarrationState, SynthesizeOptions } from "./tts-orchestrator.js";
import type { NarrationSegmentCache } from "./narration-cache.js";
import type { NarrationPlayer, SegmentPlayResult } from "./narration-player.js";

function profile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
  return {
    id: "p1",
    name: "Test",
    backend: "openai",
    config: {},
    hasStoredApiKey: false,
    providerRef: null,
    autoKeyProviderName: null,
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

  test("TPE-16: twice-failed segment → error state, good queue kept (no silent clear)", async () => {
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
    // One retry after the backoff: wait for the second attempt to arrive.
    for (let i = 0; i < 40 && synth.calls.length < 2; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    expect(synth.calls.length).toBe(2);
    synth.rejectNext("network boom");
    await p;

    const last = states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toContain("network boom");
    // Nothing was ever generated, so nothing plays — but the lane no
    // longer clears the queue on failure (kept for resume).
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

// ── TPE-1: annotation tag dialect mapping at the synthesis boundary ─────────

function makeImmediatePlayer(): NarrationPlayer {
  return {
    play(_blob: Blob, _rate: number): Promise<SegmentPlayResult> {
      return Promise.resolve("ended");
    },
    skipCurrent(): void {},
    pause(): void {},
    resume(): void {},
    setRate(): void {},
    dispose(): void {},
  };
}

describe("TTS orchestrator — tag dialect mapping (TPE-1)", () => {
  test("orpheus-model profile: canonical [laugh] synthesized as <laugh>", async () => {
    const seen: string[] = [];
    const orch = createTtsOrchestrator({
      synthesize: async (text) => {
        seen.push(text);
        return { blob: new Blob(["x"]), mime: "audio/wav" };
      },
      player: makeImmediatePlayer(),
      onState: () => {},
    });
    await orch.narrate(
      "m1",
      'Well [laugh] I never thought. "Really?"',
      profile({ backend: "openai-compatible", config: { model: "orpheus-3b-0.1-ft" } }),
    );
    expect(seen.some((t) => t.includes("<laugh>") && !t.includes("[laugh]"))).toBe(true);
  });

  test("chatterbox-model profile: canonical [laugh] passes through verbatim", async () => {
    const seen: string[] = [];
    const orch = createTtsOrchestrator({
      synthesize: async (text) => {
        seen.push(text);
        return { blob: new Blob(["x"]), mime: "audio/wav" };
      },
      player: makeImmediatePlayer(),
      onState: () => {},
    });
    await orch.narrate(
      "m1",
      "Well [laugh] I never thought.",
      profile({ backend: "openai-compatible", config: { model: "chatterbox-tts-1" } }),
    );
    expect(seen.some((t) => t.includes("[laugh]"))).toBe(true);
  });

  test("strip dialect profile (kokoro/elevenlabs/gemini/plain openai): tag removed, word never spoken", async () => {
    const seen: string[] = [];
    const orch = createTtsOrchestrator({
      synthesize: async (text) => {
        seen.push(text);
        return { blob: new Blob(["x"]), mime: "audio/wav" };
      },
      player: makeImmediatePlayer(),
      onState: () => {},
    });
    await orch.narrate("m1", "Well [laugh] I never.", profile({ backend: "elevenlabs", config: {} }));
    expect(seen.join(" ")).not.toContain("[laugh]");
    expect(seen.join(" ")).not.toContain("<laugh>");
    expect(seen.join(" ")).toContain("Well I never.");
  });
});

// ── TPE-16: retry, keep-on-failure, cache/resume, wait-full, abort ─────────

function createMapCache(): NarrationSegmentCache & { puts: string[]; gets: string[]; deletes: string[] } {
  const map = new Map<string, Blob>();
  const puts: string[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  return {
    puts,
    gets,
    deletes,
    async get(key: string): Promise<Blob | null> {
      gets.push(key);
      return map.get(key) ?? null;
    },
    async put(key: string, blob: Blob): Promise<void> {
      puts.push(key);
      map.set(key, blob);
    },
    async delete(key: string): Promise<void> {
      deletes.push(key);
      map.delete(key);
    },
  };
}

describe("TTS orchestrator — resilience (TPE-16)", () => {
  async function genTick(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, INTER_SYNTHESIS_YIELD_MS + 40));
  }

  test("single transient failure → retried once and completes", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const p = orch.narrate("m-retry", "A.\n\nB.", profile());
    await Promise.resolve();
    synth.rejectNext("hiccup");
    for (let i = 0; i < 40 && synth.calls.length < 2; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    expect(synth.calls.length).toBe(2);
    expect(synth.calls[0]!.text).toBe(synth.calls[1]!.text);
    synth.resolveNext();
    await genTick();
    synth.resolveNext();
    await genTick();
    for (let i = 0; i < 6; i += 1) {
      player.resolveCurrent("ended");
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await p;
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.played).toBe(2);
  });

  test("hard failure keeps the good segments: they play, then the error lands", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const p = orch.narrate("m-keep", "A.\n\nB.", profile());
    await Promise.resolve();
    synth.resolveNext("audio-a");
    await genTick();
    // Segment B fails twice (attempt + retry).
    synth.rejectNext("dead upstream");
    for (let i = 0; i < 40 && synth.calls.filter((c) => c.text === "B.").length < 2; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    synth.rejectNext("dead upstream");
    // The good segment still plays to the end, then the error lands.
    for (let i = 0; i < 10 && states.at(-1)?.status !== "error"; i += 1) {
      player.resolveCurrent("ended");
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await p;
    expect(player.calls.map((c) => c.text)).toEqual(["audio-a"]);
    const last = states.at(-1);
    expect(last?.status).toBe("error");
    expect(last?.error).toContain("dead upstream");
  });

  test("cache: second narrate of the same message issues zero synthesize calls", async () => {
    const cache = createMapCache();
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      cache,
      onState: (_id, s) => states.push({ ...s }),
    });

    const p1 = orch.narrate("m-cache", "A.\n\nB.", profile());
    for (let i = 0; i < 12 && synth.calls.length < 2; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    for (let i = 0; i < 12 && states.at(-1)?.status !== "complete"; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      player.resolveCurrent("ended");
      await genTick();
    }
    await p1;
    expect(states.at(-1)?.status).toBe("complete");
    expect(cache.puts.length).toBe(2);
    const callsAfterFirst = synth.calls.length;

    states.length = 0;
    const p2 = orch.narrate("m-cache", "A.\n\nB.", profile());
    for (let i = 0; i < 12 && states.at(-1)?.status !== "complete"; i += 1) {
      player.resolveCurrent("ended");
      await genTick();
    }
    await p2;
    expect(synth.calls.length).toBe(callsAfterFirst);
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.played).toBe(2);
  });

  test("cache: edited text re-synthesizes only the changed segment (partial resume)", async () => {
    const cache = createMapCache();
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      cache,
      onState: () => {},
    });

    const first = orch.narrate("m-partial", "A.\n\nB.", profile());
    for (let i = 0; i < 12 && synth.calls.length < 2; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    for (let i = 0; i < 12; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      player.resolveCurrent("ended");
      await genTick();
    }
    await first;
    const baseline = synth.calls.length;

    const second = orch.narrate("m-partial", "A.\n\nC.", profile());
    for (let i = 0; i < 12; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      player.resolveCurrent("ended");
      await genTick();
    }
    await second;
    const fresh = synth.calls.slice(baseline).map((c) => c.text);
    expect(fresh).toEqual(["C."]);
  });

  test("waitForFullGeneration: no playback until every segment is synthesized", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });
    const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

    const waitProfile = profile({ config: { waitForFullGeneration: true } });
    const p = orch.narrate("m-wait", "A.\n\nB.\n\nC.", waitProfile);
    await Promise.resolve();
    expect(synth.calls.length).toBe(1);
    synth.resolveNext(); // A done → B synthesizes, nothing plays.
    await sleep(120);
    expect(synth.calls.length).toBe(2);
    expect(player.maxConcurrent).toBe(0);
    synth.resolveNext(); // B done → C synthesizes, still nothing plays.
    await sleep(120);
    expect(synth.calls.length).toBe(3);
    expect(player.maxConcurrent).toBe(0);
    synth.resolveNext(); // C done → generationDone → playback starts.
    for (let i = 0; i < 12 && states.at(-1)?.status !== "complete"; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      player.resolveCurrent("ended");
      await genTick();
    }
    await p;
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.played).toBe(3);
  });

  test("waitForFullGeneration off (default): playback still starts on the first blob", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: () => {},
    });

    const p = orch.narrate("m-prog", "A.\n\nB.\n\nC.", profile());
    await Promise.resolve();
    synth.resolveNext();
    await new Promise<void>((r) => setTimeout(r, 120));
    // Progressive: the first blob is already playing while B/C synthesize.
    expect(player.maxConcurrent).toBe(1);
    for (let i = 0; i < 12; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      player.resolveCurrent("ended");
      await genTick();
    }
    await p;
  });

  test("stop() aborts the in-flight synthesize: complete, never error", async () => {
    const player = createDeferredPlayer();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: (text, prof, voiceId, options?: SynthesizeOptions) => {
        seenSignals.push(options?.signal);
        return synth.fn(text, prof, voiceId);
      },
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const p = orch.narrate("m-abort", "A.\n\nB.", profile());
    await Promise.resolve();
    expect(synth.calls.length).toBe(1);
    orch.stop();
    expect(seenSignals[0]?.aborted).toBe(true);
    // The abandoned fetch rejects like a real aborted fetch would.
    const pending = synth.deferreds.shift();
    pending?.reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    await p;
    const last = states.at(-1);
    expect(last?.status).toBe("complete");
    expect(states.some((s) => s.status === "error")).toBe(false);
  });

  test("poison cache entry: undecodable blob is evicted on playback failure, next narrate re-synthesizes", async () => {
    const cache = createMapCache();
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      cache,
      onState: (_id, s) => states.push({ ...s }),
    });

    // First narrate populates the cache; fail the blob once it is playing.
    const first = orch.narrate("m-poison", "A.", profile());
    for (let i = 0; i < 24 && states.at(-1)?.status !== "playing"; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      await genTick();
    }
    expect(states.at(-1)?.status).toBe("playing");
    player.failCurrent();
    await first;
    expect(states.at(-1)?.status).toBe("error");
    expect(cache.deletes.length).toBe(1);
    expect(cache.deletes[0]).toBe(cache.puts[0]);

    // The entry is gone: the next narrate synthesizes instead of replaying poison.
    states.length = 0;
    const second = orch.narrate("m-poison", "A.", profile());
    for (let i = 0; i < 24 && states.at(-1)?.status !== "complete"; i += 1) {
      if (synth.deferreds.length > 0) synth.resolveNext();
      player.resolveCurrent("ended");
      await genTick();
    }
    await second;
    expect(synth.calls.length).toBe(2);
    expect(states.at(-1)?.status).toBe("complete");
  });

  test("failed lane recovers: stop() resets to complete, a fresh narrate succeeds", async () => {
    const player = createDeferredPlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
    });

    const failing = orch.narrate("m-lane", "A.", profile());
    await Promise.resolve();
    synth.rejectNext("boom");
    for (let i = 0; i < 40 && synth.calls.length < 2; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    synth.rejectNext("boom");
    await failing;
    expect(states.at(-1)?.status).toBe("error");

    orch.stop();
    expect(states.at(-1)?.status).toBe("complete");

    states.length = 0;
    const retry = orch.narrate("m-lane", "A.", profile());
    await Promise.resolve();
    synth.resolveNext();
    await genTick();
    player.resolveCurrent("ended");
    await genTick();
    await retry;
    expect(states.at(-1)?.status).toBe("complete");
  });
});
describe("TPE-18b player controls (pause / seek / volume / progress)", () => {
  interface SeekablePlayer extends NarrationPlayer {
    plays: Array<{ text: string; startAt: number }>;
    volumeCalls: number[];
    seekCalls: number[];
    pauseCalls: number;
    onTimes: Array<(pos: number) => void>;
    resolveCurrent(result?: SegmentPlayResult): void;
  }

  /** Deferred fake with TPE-18b seams: records startAt, volume, seeks,
   *  pauses; probe durations come from a per-text stub map. */
  function createSeekablePlayer(durationsByText: Record<string, number | null> = {}): SeekablePlayer {
    const plays: SeekablePlayer["plays"] = [];
    const volumeCalls: number[] = [];
    const seekCalls: number[] = [];
    const onTimes: Array<(pos: number) => void> = [];
    let pauseCalls = 0;
    let currentResolve: ((v: SegmentPlayResult) => void) | null = null;
    const player: SeekablePlayer = {
      plays,
      volumeCalls,
      seekCalls,
      onTimes,
      get pauseCalls() {
        return pauseCalls;
      },
      play(blob: Blob, _rate: number, options?: { startAt?: number; onTime?: (pos: number) => void }): Promise<SegmentPlayResult> {
        if (options?.onTime) onTimes.push(options.onTime);
        return new Promise<SegmentPlayResult>((resolve) => {
          currentResolve = resolve;
          void blob.text().then((t) => {
            plays.push({ text: t, startAt: options?.startAt ?? 0 });
          });
        });
      },
      skipCurrent(): void {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn("skipped");
      },
      pause(): void {
        pauseCalls += 1;
      },
      resume(): void {},
      setRate(): void {},
      setVolume(v: number): void {
        volumeCalls.push(v);
      },
      seekTo(offset: number): void {
        seekCalls.push(offset);
      },
      getPosition() {
        return { position: 0, duration: null };
      },
      probeDuration(blob: Blob): Promise<number | null> {
        return blob.text().then((t) => durationsByText[t] ?? null);
      },
      dispose(): void {
        if (currentResolve) {
          const fn = currentResolve;
          currentResolve = null;
          fn("skipped");
        }
      },
      resolveCurrent(result: SegmentPlayResult = "ended"): void {
        const fn = currentResolve;
        currentResolve = null;
        if (fn) fn(result);
      },
    };
    return player;
  }

  function memoryCache(): NarrationSegmentCache {
    const blobs = new Map<string, Blob>();
    return {
      async get(key: string) {
        return blobs.get(key) ?? null;
      },
      async put(key: string, blob: Blob) {
        blobs.set(key, blob);
      },
      async delete(key: string) {
        blobs.delete(key);
      },
    };
  }

  async function tick(ms = 0): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, ms));
  }

  test("pause mid-segment freezes and resume completes the SAME segment, not skipped", async () => {
    const player = createSeekablePlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({ synthesize: synth.fn, player, onState: (_id, s) => states.push({ ...s }) });

    const done = orch.narrate("m1", "Para one.\n\nPara two.", profile());
    // Let the fill loop issue its first synthesize (sync without a
    // cache, one macrotask with one — resolving blindly would waste
    // one resolution and shift every segment).
    await tick(0);
    synth.resolveNext();
    await tick(100);
    synth.resolveNext();
    await tick(100);
    await tick(0);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one."]);

    orch.pause();
    expect(player.pauseCalls).toBe(1);
    expect(states.at(-1)?.status).toBe("paused");
    // Frozen: time passes, nothing advances to the second segment.
    await tick(150);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one."]);

    orch.resume();
    expect(states.at(-1)?.status).toBe("playing");
    // The parked first segment completes (not skipped), then the second plays.
    player.resolveCurrent("ended");
    await tick(0);
    await tick(0);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one.", "Para two."]);
    player.resolveCurrent("ended");
    await done;
    expect(synth.calls).toHaveLength(2);
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.played).toBe(2);
  });

  test("forward seek jumps to the later segment at the given offset (cache hit, no re-synth)", async () => {
    const player = createSeekablePlayer({ "Para one.": 10, "Para two.": 10, "Para three.": 10 });
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      cache: memoryCache(),
      onState: (_id, s) => states.push({ ...s }),
    });

    const done = orch.narrate("m1", "Para one.\n\nPara two.\n\nPara three.", profile());
    // Let the fill loop issue its first synthesize (the cache lookup
    // suspends past narrate()'s sync prefix — resolving blindly here
    // would waste one resolution and shift every segment).
    await tick(0);
    synth.resolveNext();
    await tick(100);
    synth.resolveNext();
    await tick(100);
    synth.resolveNext();
    await tick(150);
    await tick(0);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one."]);

    // 25s into 10+10+10 → third segment at offset 5. The fake reports a
    // live clock but position 0 on another segment — the same-segment fast
    // path only applies to the CURRENT segment, so this rebuilds the queue.
    orch.seekTo(25);
    await tick(0);
    await tick(100);
    expect(player.plays).toHaveLength(2);
    expect(player.plays[1]).toEqual({ text: "Para three.", startAt: 5 });
    // Served from the segment cache — synthesis ran exactly 3× (once each).
    expect(synth.calls).toHaveLength(3);

    player.resolveCurrent("ended");
    await done;
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.played).toBe(3);
  });

  test("backward seek replays the earlier segment from cache and refills forward without re-synthesizing", async () => {
    const player = createSeekablePlayer({ "Para one.": 10, "Para two.": 10 });
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      cache: memoryCache(),
      onState: (_id, s) => states.push({ ...s }),
    });

    const done = orch.narrate("m1", "Para one.\n\nPara two.", profile());
    // Let the fill loop issue its first synthesize (sync without a
    // cache, one macrotask with one — resolving blindly would waste
    // one resolution and shift every segment).
    await tick(0);
    synth.resolveNext();
    await tick(100);
    synth.resolveNext();
    await tick(150);
    await tick(0);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one."]);
    player.resolveCurrent("ended");
    await tick(0);
    await tick(0);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one.", "Para two."]);

    // 5s → first segment at offset 5: replay from cache (serial lane —
    // the refilled second segment plays after the replay ends), then the
    // second segment refills from cache behind it (finished fill restarts).
    orch.seekTo(5);
    await tick(0);
    await tick(150);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one.", "Para two.", "Para one."]);
    expect(player.plays[2]).toEqual({ text: "Para one.", startAt: 5 });
    expect(synth.calls).toHaveLength(2);

    player.resolveCurrent("ended");
    await tick(0);
    await tick(0);
    expect(player.plays.map((p) => p.text)).toEqual(["Para one.", "Para two.", "Para one.", "Para two."]);
    player.resolveCurrent("ended");
    await done;
    expect(states.at(-1)?.status).toBe("complete");
    expect(states.at(-1)?.played).toBe(2);
  });

  test("seek while paused stays paused at the new position until resume", async () => {
    const player = createSeekablePlayer({ "Para one.": 10, "Para two.": 10 });
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      cache: memoryCache(),
      onState: (_id, s) => states.push({ ...s }),
    });

    const done = orch.narrate("m1", "Para one.\n\nPara two.", profile());
    // Let the fill loop issue its first synthesize (sync without a
    // cache, one macrotask with one — resolving blindly would waste
    // one resolution and shift every segment).
    await tick(0);
    synth.resolveNext();
    await tick(100);
    synth.resolveNext();
    await tick(150);
    await tick(0);
    expect(player.plays).toHaveLength(1);

    orch.pause();
    orch.seekTo(15);
    await tick(0);
    await tick(150);
    // Still parked: the target is queued but nothing plays while paused.
    expect(states.at(-1)?.status).toBe("paused");
    expect(player.plays).toHaveLength(1);

    orch.resume();
    await tick(0);
    await tick(0);
    expect(player.plays).toHaveLength(2);
    expect(player.plays[1]).toEqual({ text: "Para two.", startAt: 5 });
    player.resolveCurrent("ended");
    await done;
    expect(states.at(-1)?.status).toBe("complete");
  });

  test("same-segment seek uses the live clock without rebuilding the queue", async () => {
    const player = createSeekablePlayer({ "Para one.": 10, "Para two.": 10 });
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      cache: memoryCache(),
      onState: (_id, s) => states.push({ ...s }),
    });

    const done = orch.narrate("m1", "Para one.\n\nPara two.", profile());
    // Let the fill loop issue its first synthesize (sync without a
    // cache, one macrotask with one — resolving blindly would waste
    // one resolution and shift every segment).
    await tick(0);
    synth.resolveNext();
    await tick(100);
    synth.resolveNext();
    await tick(150);
    await tick(0);
    expect(player.plays).toHaveLength(1);

    // 6s lands inside the CURRENT first segment → seamless clock jump.
    orch.seekTo(6);
    await tick(0);
    expect(player.seekCalls).toEqual([6]);
    expect(player.plays).toHaveLength(1);
    expect(synth.calls).toHaveLength(2);

    player.resolveCurrent("ended");
    await tick(0);
    await tick(0);
    player.resolveCurrent("ended");
    await done;
    expect(states.at(-1)?.status).toBe("complete");
  });

  test("setVolume forwards to the player", async () => {
    const player = createSeekablePlayer();
    const synth = createDeferredSynthesize();
    const orch = createTtsOrchestrator({ synthesize: synth.fn, player, onState: () => {} });
    orch.setVolume(0.4);
    expect(player.volumeCalls).toEqual([0.4]);
  });

  test("progress reports cumulative position and total once durations are known", async () => {
    const player = createSeekablePlayer({ "Para one.": 10, "Para two.": 20 });
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const progresses: Array<{ positionSec: number; totalSec: number | null; currentIndex: number }> = [];
    const orch = createTtsOrchestrator({
      synthesize: synth.fn,
      player,
      onState: (_id, s) => states.push({ ...s }),
      onProgress: (_id, p) => progresses.push({ positionSec: p.positionSec, totalSec: p.totalSec, currentIndex: p.currentIndex }),
    });

    const done = orch.narrate("m1", "Para one.\n\nPara two.", profile());
    // Let the fill loop issue its first synthesize (sync without a
    // cache, one macrotask with one — resolving blindly would waste
    // one resolution and shift every segment).
    await tick(0);
    synth.resolveNext();
    await tick(100);
    synth.resolveNext();
    await tick(150);
    await tick(0);
    expect(player.plays).toHaveLength(1);
    expect(player.onTimes.length).toBeGreaterThan(0);

    // Simulate ~4 Hz timeupdate ticks inside the first segment.
    player.onTimes[0](4);
    const last = progresses.at(-1);
    expect(last?.currentIndex).toBe(0);
    expect(last?.positionSec).toBe(4);
    expect(last?.totalSec).toBe(30);

    player.resolveCurrent("ended");
    await tick(0);
    await tick(0);
    // Second segment: cumulative position starts at the first duration.
    const after = progresses.at(-1);
    expect(after?.currentIndex).toBe(1);
    expect(after?.positionSec).toBe(10);
    player.resolveCurrent("ended");
    await done;
    expect(states.at(-1)?.status).toBe("complete");
  });

  test("seek is a no-op on a settled lane", async () => {
    const player = createSeekablePlayer();
    const synth = createDeferredSynthesize();
    const states: NarrationState[] = [];
    const orch = createTtsOrchestrator({ synthesize: synth.fn, player, onState: (_id, s) => states.push({ ...s }) });

    const done = orch.narrate("m1", "Para one.", profile());
    synth.resolveNext();
    await tick(150);
    await tick(0);
    player.resolveCurrent("ended");
    await done;
    expect(states.at(-1)?.status).toBe("complete");

    const playsBefore = player.plays.length;
    orch.seekTo(5);
    await tick(50);
    // No rebuild, no replay, no state churn on a finished lane.
    expect(player.plays).toHaveLength(playsBefore);
    expect(states.at(-1)?.status).toBe("complete");
  });
});
