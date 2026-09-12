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

function createFakePlayer(): NarrationPlayer & { playCalls: number } {
  let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
  let playCalls = 0;
  const player: NarrationPlayer & { playCalls: number } = {
      play(_blob: Blob, _rate: number): Promise<"ended" | "skipped" | "error"> {
        playCalls += 1;
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
      // Live counter (a plain field would snapshot 0 — Object.assign
      // copies numbers by value, so the increment would land detached).
      get playCalls(): number {
        return playCalls;
      },
    };
  return player;
}

beforeEach(() => {
  // TPE-18b: reset the new player-layer keys too (volume persists across
  // tests otherwise — the store rehydrates from localStorage at creation).
  // TPE-18d: same for the chain pref + any armed advance.
  useTtsPlaybackStore.setState({ narrations: {}, rate: 1, autoNarrate: false, volume: 1, progress: {}, continuous: false, advanceTo: null });
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
    const synthesize = async (text: string, _profile: TtsProfileRecord, _voiceId: string): Promise<{ blob: Blob; mime: string }> => ({
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
    const slowSynthesize = (text: string, _p: TtsProfileRecord, _v: string): Promise<{ blob: Blob; mime: string }> =>
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
      expect(gens.map((r) => (r as { text: string }).text)).toEqual(expectedChunks);
      // …and every request is model-safe length.
      for (const gen of gens) expect(((gen as { text: string }).text as string).length).toBeLessThanOrEqual(400);
      expect(gens.length).toBeGreaterThan(3); // chunking actually engaged
      expect(seenRequests.filter((r) => r.type === "load")).toHaveLength(1);
    } finally {
      __setKokoroWorkerFactoryForTests(null);
      __resetSharedKokoroClientForTests();
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("dual-voice kokoro: role runs synthesize with per-segment voiceIds via the worker", async () => {
    const seen: Array<{ text: string; voice: string }> = [];
    let handler: ((event: { data: unknown }) => void) | null = null;
    const worker = {
      postMessage(request: { type: string; text?: string; voice?: string; id?: number }) {
        if (request.type === "load") {
          queueMicrotask(() => handler?.({ data: { type: "loaded" } }));
        } else if (request.type === "generate") {
          seen.push({ text: request.text ?? "", voice: request.voice ?? "" });
          queueMicrotask(() =>
            handler?.({ data: { type: "generated", id: request.id, audio: new Float32Array([0.1]), sampleRate: 24000 } }),
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
      __setTtsPlaybackDepsForTests({ player: createFakePlayer() });
      const kokoroDual = profile({ backend: "kokoro", voiceId: "af_heart", narratorVoiceId: "af_bella", config: {} });
      const text = 'Intro narration here. "Hello quoted!" More narration after.';
      await useTtsPlaybackStore.getState().startNarration("m-dual", text, kokoroDual);
      // At least 3 worker generates: narrator intro, quoted character, trailing narration
      expect(seen.length).toBeGreaterThanOrEqual(3);
      const narratorGens = seen.filter((s) => s.voice === "af_bella");
      const characterGens = seen.filter((s) => s.voice === "af_heart");
      expect(narratorGens.length).toBeGreaterThanOrEqual(2);
      expect(characterGens.length).toBe(1);
      expect(characterGens[0]!.text).toBe("Hello quoted!");
      expect(useTtsPlaybackStore.getState().narrations["m-dual"]?.status).toBe("complete");
    } finally {
      __setKokoroWorkerFactoryForTests(null);
      __resetSharedKokoroClientForTests();
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("narrator-empty kokoro path stays byte-identical: same chunks as before", async () => {
    const seenPlain: string[] = [];
    let handler: ((event: { data: unknown }) => void) | null = null;
    const worker = {
      postMessage(request: { type: string; text?: string; id?: number }) {
        if (request.type === "load") {
          queueMicrotask(() => handler?.({ data: { type: "loaded" } }));
        } else if (request.type === "generate") {
          seenPlain.push(request.text ?? "");
          queueMicrotask(() =>
            handler?.({ data: { type: "generated", id: request.id, audio: new Float32Array([0.2]), sampleRate: 24000 } }),
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
      __setTtsPlaybackDepsForTests({ player: createFakePlayer() });
      const para = "Hello world. This is a plain paragraph without narrator.";
      const kokoroSingle = profile({ backend: "kokoro", voiceId: "af_heart", narratorVoiceId: null, config: {} });
      await useTtsPlaybackStore.getState().startNarration("m-plain", para, kokoroSingle);
      const expected = chunkNarrationText(para);
      expect(seenPlain).toEqual(expected);
    } finally {
      __setKokoroWorkerFactoryForTests(null);
      __resetSharedKokoroClientForTests();
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("TPE-16: narration error transition fires the error notifier exactly once", async () => {
    const notified: Array<{ id: string; message: string }> = [];
    const synthesize = async (): Promise<{ blob: Blob; mime: string }> => {
      throw new Error("upstream down");
    };
    __setTtsPlaybackDepsForTests({
      player: createFakePlayer(),
      synthesize,
      notifyError: (id, message) => {
        notified.push({ id, message });
      },
    });
    try {
      // Unique text: the store's shared segment cache persists across
      // tests in this file (prod behavior) — a reused text would resume
      // from cache and never touch synthesize.
      await useTtsPlaybackStore.getState().startNarration("m-err", "Hello error probe.", profile());
      expect(useTtsPlaybackStore.getState().narrations["m-err"]?.status).toBe("error");
      expect(notified).toEqual([{ id: "m-err", message: "upstream down" }]);
    } finally {
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("TPE-16: stopNarration during synthesis completes the lane without an error toast", async () => {
    const notified: string[] = [];
    let release!: (value: { blob: Blob; mime: string }) => void;
    let calls = 0;
    const gate = new Promise<{ blob: Blob; mime: string }>((resolve) => {
      release = resolve;
    });
    __setTtsPlaybackDepsForTests({
      player: createFakePlayer(),
      synthesize: () => {
        calls += 1;
        return gate;
      },
      notifyError: (_id, message) => {
        notified.push(message);
      },
    });
    try {
      // Unique text (see above: the shared cache would otherwise serve it).
      const started = useTtsPlaybackStore.getState().startNarration("m-stop", "Hello stop probe.", profile());
      for (let i = 0; i < 40 && calls < 1; i += 1) {
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      expect(calls).toBe(1);
      useTtsPlaybackStore.getState().stopNarration();
      release({ blob: new Blob(["x"]), mime: "audio/mpeg" });
      await started;
      expect(useTtsPlaybackStore.getState().narrations["m-stop"]?.status).toBe("complete");
      expect(notified).toEqual([]);
    } finally {
      __setTtsPlaybackDepsForTests(null);
    }
  });
});

describe("tts-playback-store player controls (TPE-18b)", () => {
  /** Recording fake: auto-ending plays with text/startAt capture, fixed
   *  probe durations, volume capture. */
  function createRecordingPlayer(durationsByText: Record<string, number> = {}): NarrationPlayer & {
    plays: Array<{ text: string; startAt: number }>;
    volumeCalls: number[];
  } {
    const plays: Array<{ text: string; startAt: number }> = [];
    const volumeCalls: number[] = [];
    return {
      plays,
      volumeCalls,
      play(blob: Blob, _rate: number, options?: { startAt?: number }): Promise<"ended" | "skipped" | "error"> {
        void blob.text().then((t) => plays.push({ text: t, startAt: options?.startAt ?? 0 }));
        return new Promise<"ended" | "skipped" | "error">((resolve) => {
          queueMicrotask(() => resolve("ended"));
        });
      },
      skipCurrent(): void {},
      pause(): void {},
      resume(): void {},
      setRate(): void {},
      setVolume(v: number): void {
        volumeCalls.push(v);
      },
      probeDuration(blob: Blob): Promise<number | null> {
        return blob.text().then((t) => durationsByText[t] ?? null);
      },
      dispose(): void {},
    };
  }

  test("setVolume clamps and stores; forwarding reaches the lane once it exists", async () => {
    const player = createRecordingPlayer();
    __setTtsPlaybackDepsForTests({ player, synthesize: async () => ({ blob: new Blob(["x"]), mime: "audio/mpeg" }) });
    try {
      // No lane yet — the value persists, nothing to forward to (no crash).
      useTtsPlaybackStore.getState().setVolume(0.35);
      expect(useTtsPlaybackStore.getState().volume).toBe(0.35);
      expect(player.volumeCalls).toEqual([]);
      // Clamp, not wrap: out-of-lane values pin to the edges.
      useTtsPlaybackStore.getState().setVolume(2);
      expect(useTtsPlaybackStore.getState().volume).toBe(1);
      useTtsPlaybackStore.getState().setVolume(-1);
      expect(useTtsPlaybackStore.getState().volume).toBe(0);
      // A live lane receives the stored value.
      useTtsPlaybackStore.getState().setVolume(0.35);
      await useTtsPlaybackStore.getState().startNarration("m-volstate", "Hello.", profile());
      expect(player.volumeCalls).toEqual([0.35]);
    } finally {
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("startNarration applies the stored volume to the lane", async () => {
    const player = createRecordingPlayer();
    __setTtsPlaybackDepsForTests({ player, synthesize: async () => ({ blob: new Blob(["x"]), mime: "audio/mpeg" }) });
    try {
      useTtsPlaybackStore.getState().setVolume(0.5);
      player.volumeCalls.length = 0;
      await useTtsPlaybackStore.getState().startNarration("m-vol", "Hello.", profile());
      // A recreated lane starts at full volume unless told otherwise —
      // the store applies its value on every start.
      expect(player.volumeCalls).toEqual([0.5]);
    } finally {
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("seek forwards to the ruling lane only; foreign ids are ignored", async () => {
    // Deferred player: the lane stays parked inside the first segment
    // (instant fakes would play the whole message before the seek).
    const plays: Array<{ text: string; startAt: number }> = [];
    let currentResolve: ((v: "ended" | "skipped" | "error") => void) | null = null;
    const player: NarrationPlayer = {
      play(blob: Blob, _rate: number, options?: { startAt?: number }): Promise<"ended" | "skipped" | "error"> {
        void blob.text().then((t) => plays.push({ text: t, startAt: options?.startAt ?? 0 }));
        return new Promise<"ended" | "skipped" | "error">((resolve) => {
          currentResolve = resolve;
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
      probeDuration(blob: Blob): Promise<number | null> {
        const known: Record<string, number> = { "Seg one.": 10, "Seg two.": 10 };
        return blob.text().then((t) => known[t] ?? null);
      },
      dispose(): void {},
    };
    const synthCalls: string[] = [];
    __setTtsPlaybackDepsForTests({
      player,
      synthesize: async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([text]), mime: "audio/mpeg" };
      },
    });
    const pump = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 40 && !cond(); i += 1) {
        await new Promise<void>((r) => setTimeout(r, 25));
      }
    };
    const releaseCurrent = (): void => {
      const fn = currentResolve;
      currentResolve = null;
      if (fn) fn("ended");
    };
    try {
      const started = useTtsPlaybackStore.getState().startNarration("m-seek", "Seg one.\n\nSeg two.", profile());
      await pump(() => plays.length >= 1);
      expect(plays.map((p) => p.text)).toEqual(["Seg one."]);

      // A stale row action for another message must not touch the lane.
      useTtsPlaybackStore.getState().seek("m-other", 15);
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(plays).toHaveLength(1);

      // 15s into 10+10 → second segment at offset 5 (re-synthesized on
      // the seek load — the store suite wires no segment cache).
      useTtsPlaybackStore.getState().seek("m-seek", 15);
      await pump(() => plays.length >= 2);
      expect(plays[1]).toEqual({ text: "Seg two.", startAt: 5 });
      releaseCurrent();
      await started;
      expect(useTtsPlaybackStore.getState().narrations["m-seek"]?.status).toBe("complete");
    } finally {
      __setTtsPlaybackDepsForTests(null);
    }
  });
});

describe("TPE-18c narration library (store)", () => {
  const SCOPE = { chatId: "c1", branchId: "b1", characterId: "ch1", messageId: "m1" };

  type PlaylistEntry = import("../lib/tts/narration-cache.js").NarrationPlaylistEntry;
  type PlaylistIndex = import("../lib/tts/narration-cache.js").NarrationPlaylistIndex;
  type SegmentCache = import("../lib/tts/narration-cache.js").NarrationSegmentCache;
  type LibraryClient = import("../lib/tts/narration-library-client.js").NarrationLibraryClient;
  type LibraryIds = import("../lib/tts/narration-library-client.js").NarrationLibraryIds;
  type FailKind = "fetch" | "exists" | "save" | "delete" | "reveal";

  function memoryCache(): SegmentCache & { blobs: Map<string, Blob> } {
    const blobs = new Map<string, Blob>();
    return {
      blobs,
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

  function memoryIndex(): PlaylistIndex {
    const chats = new Map<string, Map<string, PlaylistEntry>>();
    return {
      async list(chatId: string) {
        return [...(chats.get(chatId)?.values() ?? [])].sort((a, b) => a.narratedAt - b.narratedAt);
      },
      async upsert(chatId: string, entry: PlaylistEntry) {
        let items = chats.get(chatId);
        if (!items) {
          items = new Map();
          chats.set(chatId, items);
        }
        items.set(entry.messageId, entry);
      },
      async remove(chatId: string, messageId: string) {
        chats.get(chatId)?.delete(messageId);
      },
      async clear(chatId: string) {
        chats.delete(chatId);
      },
    };
  }

  interface FakeLibrary {
    client: LibraryClient;
    files: Map<string, Blob>;
    saved: Array<{ ids: LibraryIds; bytes: number }>;
    deleted: string[];
    revealed: string[];
    failOn: Set<FailKind>;
  }

  function fakeLibrary(): FakeLibrary {
    const files = new Map<string, Blob>();
    const saved: FakeLibrary["saved"] = [];
    const deleted: string[] = [];
    const revealed: string[] = [];
    const failOn = new Set<FailKind>();
    const keyOf = (ids: LibraryIds): string =>
      `${ids.chatId}/${ids.branchId}/${ids.messageId}/${ids.variantIndex}`;
    const client: FakeLibrary["client"] = {
      async saveRecording(ids, audio) {
        if (failOn.has("save")) throw new Error("upload down");
        saved.push({ ids, bytes: audio.size });
        files.set(keyOf(ids), audio);
        return { saved: true, leaf: "narrations/mock.ogg" };
      },
      async recordingExists(ids) {
        if (failOn.has("exists")) throw new Error("network down");
        return files.has(keyOf(ids));
      },
      async fetchRecording(ids) {
        if (failOn.has("fetch")) throw new Error("network down");
        return files.get(keyOf(ids)) ?? null;
      },
      async deleteRecording(ids) {
        if (failOn.has("delete")) throw new Error("network down");
        const k = keyOf(ids);
        const had = files.delete(k);
        if (had) deleted.push(k);
        return { deleted: had };
      },
      async revealRecording(ids) {
        if (failOn.has("reveal")) throw new Error("no manager");
        revealed.push(keyOf(ids));
        return { revealed: true };
      },
    };
    return { client, files, saved, deleted, revealed, failOn };
  }

  const META = {
    chatId: "c1",
    characterId: "ch1",
    branchId: "b1",
    variantId: "m1-v0",
    variantIndex: 0,
    snippet: "Hello",
  };

  beforeEach(() => {
    useTtsPlaybackStore.setState({ playlist: {}, lastStarted: null });
  });

  test("library hit plays the saved file with zero synthesize calls", async () => {
    const player = createFakePlayer();
    let synthCalls = 0;
    const cache = memoryCache();
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0,
      snippet: "Hello", cacheKeys: [], narratedAt: 1, inLibrary: true,
    });
    const lib = fakeLibrary();
    lib.files.set("c1/b1/m1/0", new Blob(["saved-audio"], { type: "audio/ogg" }));
    __setTtsPlaybackDepsForTests({
      player,
      synthesize: async (text: string) => {
        synthCalls += 1;
        return { blob: new Blob([text]), mime: "audio/mpeg" };
      },
      cache,
      playlistIndex: index,
      libraryClient: lib.client,
    });

    await useTtsPlaybackStore.getState().loadPlaylist("c1");
    await useTtsPlaybackStore.getState().startNarration("m1", "Hello", profile(), META);

    expect(synthCalls).toBe(0);
    expect(player.playCalls).toBe(1);
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
  });

  test("stale flag (file 404s) heals to synthesis and clears the flag", async () => {
    const player = createFakePlayer();
    let synthCalls = 0;
    const cache = memoryCache();
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0,
      snippet: "Hello", cacheKeys: [], narratedAt: 1, inLibrary: true,
    });
    const lib = fakeLibrary();
    // No file on the "server" — fetchRecording returns null (404).
    __setTtsPlaybackDepsForTests({
      player,
      synthesize: async (text: string) => {
        synthCalls += 1;
        return { blob: new Blob([text]), mime: "audio/mpeg" };
      },
      cache,
      playlistIndex: index,
      libraryClient: lib.client,
    });

    await useTtsPlaybackStore.getState().loadPlaylist("c1");
    // loadPlaylist without scope keeps the index hint…
    expect(useTtsPlaybackStore.getState().playlist["c1"]?.[0]?.inLibrary).toBe(true);
    await useTtsPlaybackStore.getState().startNarration("m1", "Hello", profile(), META);

    // …but the 404 heals the flag and synthesis serves the narration.
    expect(synthCalls).toBeGreaterThan(0);
    expect(useTtsPlaybackStore.getState().playlist["c1"]?.[0]?.inLibrary).not.toBe(true);
    expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
  });

  test("save merges segments into ONE ogg, evicts cache keys, marks the row", async () => {
    const cache = memoryCache();
    await cache.put("k1", new Blob(["seg1"]), "audio/wav");
    await cache.put("k2", new Blob(["seg2"]), "audio/wav");
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0,
      snippet: "Hello", cacheKeys: ["k1", "k2"], narratedAt: 1,
    });
    const lib = fakeLibrary();
    const merged: Blob[][] = [];
    __setTtsPlaybackDepsForTests({
      cache,
      playlistIndex: index,
      libraryClient: lib.client,
      mergeToOgg: async (blobs) => {
        merged.push(blobs);
        return new Uint8Array([1, 2, 3]);
      },
    });

    await useTtsPlaybackStore.getState().loadPlaylist("c1");
    const { leaf } = await useTtsPlaybackStore.getState().saveToLibrary(SCOPE);

    expect(leaf).toBe("narrations/mock.ogg");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveLength(2);
    expect(lib.saved).toHaveLength(1);
    expect(lib.saved[0]?.bytes).toBe(3);
    // Library replaces cache (owner decision): keys are gone…
    expect(await cache.get("k1")).toBeNull();
    expect(await cache.get("k2")).toBeNull();
    // …and the row wears the badge.
    expect(useTtsPlaybackStore.getState().playlist["c1"]?.[0]?.inLibrary).toBe(true);
  });

  test("save with an expired segment toasts and throws (no upload, flag untouched)", async () => {
    const cache = memoryCache();
    await cache.put("k1", new Blob(["seg1"]), "audio/wav");
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0,
      snippet: "Hello", cacheKeys: ["k1", "missing"], narratedAt: 1,
    });
    const lib = fakeLibrary();
    const toasts: string[] = [];
    __setTtsPlaybackDepsForTests({
      cache,
      playlistIndex: index,
      libraryClient: lib.client,
      notifyError: (_id, message) => { toasts.push(message); },
    });

    await useTtsPlaybackStore.getState().loadPlaylist("c1");
    await expect(useTtsPlaybackStore.getState().saveToLibrary(SCOPE)).rejects.toThrow(/expired/);
    expect(lib.saved).toHaveLength(0);
    expect(toasts).toHaveLength(1);
    expect(useTtsPlaybackStore.getState().playlist["c1"]?.[0]?.inLibrary).not.toBe(true);
  });

  test("drop removes the file and clears the flag, keeping the row", async () => {
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0,
      snippet: "Hello", cacheKeys: [], narratedAt: 1, inLibrary: true,
    });
    const lib = fakeLibrary();
    lib.files.set("c1/b1/m1/0", new Blob(["saved-audio"], { type: "audio/ogg" }));
    __setTtsPlaybackDepsForTests({ playlistIndex: index, libraryClient: lib.client });

    await useTtsPlaybackStore.getState().loadPlaylist("c1");
    await useTtsPlaybackStore.getState().dropLibraryRow(SCOPE);

    expect(lib.deleted).toEqual(["c1/b1/m1/0"]);
    const row = useTtsPlaybackStore.getState().playlist["c1"]?.[0];
    expect(row?.messageId).toBe("m1");
    expect(row?.inLibrary).toBe(false);
  });

  test("drop on a non-library row toasts and throws (button never renders there)", async () => {
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0,
      snippet: "Hello", cacheKeys: ["k1"], narratedAt: 1,
    });
    const lib = fakeLibrary();
    const toasts: string[] = [];
    __setTtsPlaybackDepsForTests({
      playlistIndex: index,
      libraryClient: lib.client,
      notifyError: (_id, message) => { toasts.push(message); },
    });

    await useTtsPlaybackStore.getState().loadPlaylist("c1");
    await expect(useTtsPlaybackStore.getState().dropLibraryRow(SCOPE)).rejects.toThrow(/no saved library file/);
    expect(toasts).toHaveLength(1);
  });

  test("refreshLibraryFlags reconciles per row; one row's failure keeps its hint", async () => {
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0, snippet: "One", cacheKeys: [], narratedAt: 1,
    });
    await index.upsert("c1", {
      messageId: "m2", variantId: "m2-v0", variantIndex: 0, snippet: "Two", cacheKeys: [], narratedAt: 2,
      inLibrary: true,
    });
    const lib = fakeLibrary();
    lib.files.set("c1/b1/m1/0", new Blob(["a"], { type: "audio/ogg" }));
    // m2's check throws (transient) — its index hint survives.
    const checking = lib.client.recordingExists.bind(lib.client);
    const flaky: LibraryClient = { ...lib.client };
    flaky.recordingExists = async (ids) => {
      if (ids.messageId === "m2") throw new Error("network down");
      return checking(ids);
    };
    __setTtsPlaybackDepsForTests({ playlistIndex: index, libraryClient: flaky });

    await useTtsPlaybackStore.getState().loadPlaylist("c1", { characterId: "ch1", branchId: "b1" });
    const rows = useTtsPlaybackStore.getState().playlist["c1"] ?? [];
    expect(rows.find((r) => r.messageId === "m1")?.inLibrary).toBe(true);
    expect(rows.find((r) => r.messageId === "m2")?.inLibrary).toBe(true);
  });

  test("reveal forwards the scope; a failed reveal toasts and throws", async () => {
    const index = memoryIndex();
    await index.upsert("c1", {
      messageId: "m1", variantId: "m1-v0", variantIndex: 0,
      snippet: "Hello", cacheKeys: [], narratedAt: 1, inLibrary: true,
    });
    const lib = fakeLibrary();
    const toasts: string[] = [];
    __setTtsPlaybackDepsForTests({
      playlistIndex: index,
      libraryClient: lib.client,
      notifyError: (_id, message) => { toasts.push(message); },
    });

    await useTtsPlaybackStore.getState().loadPlaylist("c1");
    await useTtsPlaybackStore.getState().revealLibraryRow(SCOPE);
    expect(lib.revealed).toEqual(["c1/b1/m1/0"]);

    lib.failOn.add("reveal");
    await expect(useTtsPlaybackStore.getState().revealLibraryRow(SCOPE)).rejects.toThrow(/no manager/);
    expect(toasts).toHaveLength(1);
  });
});


describe("TPE-18d continuous play (store chain)", () => {
  type PlaylistEntry = import("../lib/tts/narration-cache.js").NarrationPlaylistEntry;
  type PlaylistIndex = import("../lib/tts/narration-cache.js").NarrationPlaylistIndex;
  type SegmentCache = import("../lib/tts/narration-cache.js").NarrationSegmentCache;

  function memoryCache(): SegmentCache & { blobs: Map<string, Blob> } {
    const blobs = new Map<string, Blob>();
    return {
      blobs,
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

  function memoryIndex(): PlaylistIndex {
    const chats = new Map<string, Map<string, PlaylistEntry>>();
    return {
      async list(chatId: string) {
        return [...(chats.get(chatId)?.values() ?? [])].sort((a, b) => a.narratedAt - b.narratedAt);
      },
      async upsert(chatId: string, entry: PlaylistEntry) {
        let items = chats.get(chatId);
        if (!items) {
          items = new Map();
          chats.set(chatId, items);
        }
        items.set(entry.messageId, entry);
      },
      async remove(chatId: string, messageId: string) {
        chats.get(chatId)?.delete(messageId);
      },
      async clear(chatId: string) {
        chats.delete(chatId);
      },
    };
  }

  const pump = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 40 && !cond(); i += 1) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
  };

  function chainMeta(messageId: string, queue: string[]) {
    return {
      chatId: "c1",
      chainQueue: queue,
      characterId: null,
      branchId: null,
      variantId: `${messageId}-v0`,
      variantIndex: 0,
      snippet: "Shared",
    };
  }

  test("continuous chain of three cached rows advances end-to-end with a single synthesis", async () => {
    const player = createFakePlayer();
    const synthCalls: string[] = [];
    __setTtsPlaybackDepsForTests({
      player,
      synthesize: async (text: string) => {
        synthCalls.push(text);
        return { blob: new Blob([text]), mime: "audio/mpeg" };
      },
      cache: memoryCache(),
      playlistIndex: memoryIndex(),
    });
    try {
      // Same text for all three rows = same segment keys: rows two and
      // three replay from cache (zero synthesis — the owner scene).
      const text = "Shared chain line one.\n\nShared chain line two.";
      const queue = ["m1", "m2", "m3"];
      useTtsPlaybackStore.getState().setContinuous(true);

      await useTtsPlaybackStore.getState().startNarration("m1", text, profile(), chainMeta("m1", queue));
      await pump(() => useTtsPlaybackStore.getState().advanceTo?.messageId === "m2");
      expect(useTtsPlaybackStore.getState().advanceTo).toEqual({ chatId: "c1", messageId: "m2" });

      await useTtsPlaybackStore.getState().startNarration("m2", text, profile(), chainMeta("m2", queue));
      await pump(() => useTtsPlaybackStore.getState().advanceTo?.messageId === "m3");
      expect(useTtsPlaybackStore.getState().advanceTo).toEqual({ chatId: "c1", messageId: "m3" });

      await useTtsPlaybackStore.getState().startNarration("m3", text, profile(), chainMeta("m3", queue));
      await pump(() => useTtsPlaybackStore.getState().narrations["m3"]?.status === "complete");
      // Chain exhausted — nothing armed after the last row.
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(useTtsPlaybackStore.getState().advanceTo).toBeNull();

      // Two segments synthesized once for m1; m2/m3 were pure cache hits.
      expect(synthCalls).toHaveLength(2);
      expect(useTtsPlaybackStore.getState().narrations["m1"]?.status).toBe("complete");
      expect(useTtsPlaybackStore.getState().narrations["m2"]?.status).toBe("complete");
      expect(useTtsPlaybackStore.getState().narrations["m3"]?.status).toBe("complete");
    } finally {
      useTtsPlaybackStore.getState().setContinuous(false);
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("mid-chain stop breaks the chain — an armed advance dies with the lane", async () => {
    const player = createFakePlayer();
    let synthCalls = 0;
    __setTtsPlaybackDepsForTests({
      player,
      synthesize: async (text: string) => {
        synthCalls += 1;
        return { blob: new Blob([text]), mime: "audio/mpeg" };
      },
      cache: memoryCache(),
      playlistIndex: memoryIndex(),
    });
    try {
      useTtsPlaybackStore.getState().setContinuous(true);
      await useTtsPlaybackStore
        .getState()
        .startNarration("m1", "Stop me.\n\nPlease.", profile(), chainMeta("m1", ["m1", "m2"]));
      await pump(() => useTtsPlaybackStore.getState().advanceTo?.messageId === "m2");
      expect(useTtsPlaybackStore.getState().advanceTo).toEqual({ chatId: "c1", messageId: "m2" });

      // The owner scene: stop AFTER the arm, before the panel consumes it.
      useTtsPlaybackStore.getState().stopNarration();
      expect(useTtsPlaybackStore.getState().advanceTo).toBeNull();
      expect(useTtsPlaybackStore.getState().lastStarted).toBeNull();
      await new Promise<void>((r) => setTimeout(r, 150));
      expect(useTtsPlaybackStore.getState().advanceTo).toBeNull();
      expect(synthCalls).toBe(2);
    } finally {
      useTtsPlaybackStore.getState().setContinuous(false);
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("toggle off stays one-shot — a queued completion arms nothing (regression pin)", async () => {
    const player = createFakePlayer();
    __setTtsPlaybackDepsForTests({
      player,
      synthesize: async (text: string) => ({ blob: new Blob([text]), mime: "audio/mpeg" }),
      cache: memoryCache(),
      playlistIndex: memoryIndex(),
    });
    try {
      expect(useTtsPlaybackStore.getState().continuous).toBe(false);
      await useTtsPlaybackStore
        .getState()
        .startNarration("m1", "One shot.\n\nOnly.", profile(), chainMeta("m1", ["m1", "m2"]));
      await pump(() => useTtsPlaybackStore.getState().narrations["m1"]?.status === "complete");
      // Let the floating completion report land — still nothing armed.
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(useTtsPlaybackStore.getState().advanceTo).toBeNull();
    } finally {
      __setTtsPlaybackDepsForTests(null);
    }
  });

  test("chat switch clears an armed advance; same-chat reload keeps it", async () => {
    const player = createFakePlayer();
    __setTtsPlaybackDepsForTests({
      player,
      synthesize: async (text: string) => ({ blob: new Blob([text]), mime: "audio/mpeg" }),
      cache: memoryCache(),
      playlistIndex: memoryIndex(),
    });
    try {
      useTtsPlaybackStore.getState().setContinuous(true);
      await useTtsPlaybackStore
        .getState()
        .startNarration("m1", "Arm me.\n\nNow.", profile(), chainMeta("m1", ["m1", "m2"]));
      await pump(() => useTtsPlaybackStore.getState().advanceTo?.messageId === "m2");

      await useTtsPlaybackStore.getState().loadPlaylist("c1");
      expect(useTtsPlaybackStore.getState().advanceTo).toEqual({ chatId: "c1", messageId: "m2" });

      await useTtsPlaybackStore.getState().loadPlaylist("c2");
      expect(useTtsPlaybackStore.getState().advanceTo).toBeNull();
    } finally {
      useTtsPlaybackStore.getState().setContinuous(false);
      __setTtsPlaybackDepsForTests(null);
    }
  });
});
