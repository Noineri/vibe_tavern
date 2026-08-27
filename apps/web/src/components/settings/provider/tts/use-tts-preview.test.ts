import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_BACKEND } from "@vibe-tavern/domain";
import {
  __setTtsPreviewDepsForTests,
  type TtsPreviewInput,
  type TtsPreviewState,
} from "./use-tts-preview.js";

const { render, cleanup, act } = await import("@testing-library/react");
const { useTtsPreview } = await import("./use-tts-preview.js");

/**
 * Intermediate hook states are observed by driving the async chain through
 * MANUALLY-RESOLVED promises, one act() flush per phase. Immediately-resolving
 * mocks let React coalesce generating/playing/idle into a single commit (only
 * the final state renders), which would hide the transitions under test.
 */
/** Deferred with synchronously-assigned resolve/reject (the Promise executor
 *  runs at construction, so both are usable immediately after makeDeferred). */
function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness() {
  const states: TtsPreviewState[] = [];
  const errors: Array<string | null> = [];
  const capture: { preview?: (input: TtsPreviewInput) => void } = {};
  const downloadPcts: Array<number | null> = [];
  const synthDeferred = makeDeferred<{ blob: Blob; mime: string }>();
  const playDeferred = makeDeferred<void>();
  const synthesize = mock((_input: TtsPreviewInput) => synthDeferred.promise);
  const play = mock((_blob: Blob, _mime: string) => playDeferred.promise);
  let progressSink: ((pct: number | null) => void) | null = null;
  const subscribeLoadProgress = mock((cb: (pct: number | null) => void) => {
    progressSink = cb;
    return () => {
      progressSink = null;
    };
  });
  __setTtsPreviewDepsForTests({ synthesize, play, subscribeLoadProgress });
  render(
    React.createElement(
      function HookProbe(): null {
        const { state, error, downloadPct, preview } = useTtsPreview();
        states.push(state);
        errors.push(error);
        downloadPcts.push(downloadPct);
        capture.preview = preview;
        return null;
      },
    ),
  );
  return {
    states,
    errors,
    downloadPcts,
    capture,
    emitProgress: (pct: number | null): void => {
      progressSink?.(pct);
    },
    resolveSynthesize: synthDeferred.resolve,
    rejectSynthesize: synthDeferred.reject,
    resolvePlay: playDeferred.resolve,
    rejectPlay: playDeferred.reject,
    synthesize,
    play,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

beforeEach(() => {
  __setTtsPreviewDepsForTests(null);
});

afterEach(async () => {
  __setTtsPreviewDepsForTests(null);
  await act(async () => {});
  cleanup();
});

describe("useTtsPreview", () => {
  it("kokoro unsaved profile: synthesizes from form values, states go generating → playing → idle", async () => {
    const h = makeHarness();

    await act(async () => {
      h.capture.preview?.({ backend: TTS_BACKEND.Kokoro, voiceId: "af_heart", speed: 1.2, config: null });
    });
    await flush();
    expect(h.states).toContain("generating");
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    // The injected synthesize receives the FORM's voice + speed.
    expect(h.synthesize.mock.calls[0][0].voiceId).toBe("af_heart");
    expect(h.synthesize.mock.calls[0][0].speed).toBe(1.2);
    expect(h.synthesize.mock.calls[0][0].config).toBeNull();

    await act(async () => {
      h.resolveSynthesize({ blob: new Blob(["wav"], { type: "audio/wav" }), mime: "audio/wav" });
    });
    await flush();
    expect(h.states).toContain("playing");
    expect(h.play).toHaveBeenCalledTimes(1);
    expect(h.play.mock.calls[0][1]).toBe("audio/wav");

    await act(async () => {
      h.resolvePlay();
    });
    await flush();
    expect(h.states[h.states.length - 1]).toBe("idle");
    expect(h.errors[h.errors.length - 1]).toBeNull();
  });

  it("server backend happy path (unsaved ok): synthesize receives the form config, ends idle", async () => {
    const h = makeHarness();

    await act(async () => {
      h.capture.preview?.({ backend: TTS_BACKEND.OpenAiCompatible, voiceId: "alloy", speed: 1, config: { endpoint: "http://localhost:8880/v1" } });
    });
    await flush();
    expect(h.states).toContain("generating");
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    expect(h.synthesize.mock.calls[0][0].config).toEqual({ endpoint: "http://localhost:8880/v1" });

    await act(async () => {
      h.resolveSynthesize({ blob: new Blob(["mp3"], { type: "audio/mpeg" }), mime: "audio/mpeg" });
    });
    await flush();
    expect(h.states).toContain("playing");

    await act(async () => {
      h.resolvePlay();
    });
    await flush();
    expect(h.states[h.states.length - 1]).toBe("idle");
  });

  it("synthesize throws → back to idle with the error message", async () => {
    const h = makeHarness();

    await act(async () => {
      h.capture.preview?.({ backend: TTS_BACKEND.Gemini, voiceId: "kore", speed: 1, config: { apiKey: "k" } });
    });
    await flush();
    expect(h.states).toContain("generating");

    await act(async () => {
      h.rejectSynthesize(new Error("engine exploded"));
    });
    await flush();
    expect(h.play).not.toHaveBeenCalled();
    expect(h.states[h.states.length - 1]).toBe("idle");
    expect(h.errors[h.errors.length - 1]).toBe("engine exploded");
  });

  it("server backend with null config → error set, synthesize NOT called", async () => {
    const h = makeHarness();

    await act(async () => {
      h.capture.preview?.({ backend: TTS_BACKEND.ElevenLabs, voiceId: "rachel", speed: 1, config: null });
    });
    await flush();

    expect(h.synthesize).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
    // Never left idle — the guard fires before the generating state.
    expect(h.states.every((s) => s === "idle")).toBe(true);
    expect(h.errors[h.errors.length - 1]).not.toBeNull();
  });

  it("play rejects → back to idle with the error set", async () => {
    const h = makeHarness();

    await act(async () => {
      h.capture.preview?.({ backend: TTS_BACKEND.Kokoro, voiceId: "af_heart", speed: 1, config: null });
    });
    await flush();
    await act(async () => {
      h.resolveSynthesize({ blob: new Blob(["x"]), mime: "audio/wav" });
    });
    await flush();
    expect(h.states).toContain("playing");

    await act(async () => {
      h.rejectPlay(new Error("playback failed"));
    });
    await flush();
    expect(h.states[h.states.length - 1]).toBe("idle");
    expect(h.errors[h.errors.length - 1]).toBe("playback failed");
  });

  it('surfaces kokoro model-download percent while generating and clears it when done', async () => {
    const h = makeHarness();
    act(() => {
      h.capture.preview?.({ backend: TTS_BACKEND.Kokoro, voiceId: 'af_heart', speed: 1, config: null });
    });
    await flush();
    expect(h.states).toContain('generating');
    // Model download progress arrives mid-generate — the button label source.
    act(() => {
      h.emitProgress(37);
    });
    await flush();
    expect(h.downloadPcts).toContain(37);
    h.resolveSynthesize({ blob: new Blob(['x']), mime: 'audio/wav' });
    await flush();
    h.resolvePlay();
    await flush();
    expect(h.states[h.states.length - 1]).toBe('idle');
    // Cleared after the run — no stale percent on the next preview.
    expect(h.downloadPcts[h.downloadPcts.length - 1]).toBeNull();
  });

});
