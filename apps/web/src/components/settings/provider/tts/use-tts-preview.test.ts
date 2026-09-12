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
  const synthDeferreds: Array<ReturnType<typeof makeDeferred<{ blob: Blob; mime: string }>>> = [];
  const playDeferreds: Array<ReturnType<typeof makeDeferred<void>>> = [];
  const synthesize = mock((_input: TtsPreviewInput) => {
    const d = makeDeferred<{ blob: Blob; mime: string }>();
    synthDeferreds.push(d);
    return d.promise;
  });
  const play = mock((_blob: Blob, _mime: string) => {
    const d = makeDeferred<void>();
    playDeferreds.push(d);
    return d.promise;
  });
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
    resolveSynthesize: (v: { blob: Blob; mime: string }) => {
      const d = synthDeferreds.shift();
      d?.resolve(v);
    },
    rejectSynthesize: (e: Error) => {
      const d = synthDeferreds.shift();
      d?.reject(e);
    },
    resolvePlay: () => {
      const d = playDeferreds.shift();
      d?.resolve();
    },
    rejectPlay: (e: Error) => {
      const d = playDeferreds.shift();
      d?.reject(e);
    },
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

  it("dual-voice remote: narrator set → two synthesize calls with voiceIds in order (narrator first)", async () => {
    const h = makeHarness();
    await act(async () => {
      h.capture.preview?.({
        backend: TTS_BACKEND.OpenAiCompatible,
        voiceId: "alloy",
        narratorVoiceId: "verse",
        speed: 1,
        config: { endpoint: "https://x/v1" },
      });
    });
    await flush();
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    expect(h.synthesize.mock.calls[0][0].voiceId).toBe("verse");
    expect(h.synthesize.mock.calls[0][0].text).toBe("Hello! This is the narrator. ");
    await act(async () => {
      h.resolveSynthesize({ blob: new Blob(["a"], { type: "audio/mpeg" }), mime: "audio/mpeg" });
    });
    await flush();
    expect(h.play).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.resolvePlay();
    });
    await flush();
    expect(h.synthesize).toHaveBeenCalledTimes(2);
    expect(h.synthesize.mock.calls[1][0].voiceId).toBe("alloy");
    expect(h.synthesize.mock.calls[1][0].text).toBe('"And this is the character."');
    await act(async () => {
      h.resolveSynthesize({ blob: new Blob(["b"], { type: "audio/mpeg" }), mime: "audio/mpeg" });
    });
    await flush();
    expect(h.play).toHaveBeenCalledTimes(2);
    await act(async () => {
      h.resolvePlay();
    });
    await flush();
    expect(h.states[h.states.length - 1]).toBe("idle");
  });

  it("dual-voice remote single voice when narrator null → one call", async () => {
    const h = makeHarness();
    await act(async () => {
      h.capture.preview?.({
        backend: TTS_BACKEND.OpenAiCompatible,
        voiceId: "alloy",
        narratorVoiceId: null,
        speed: 1,
        config: { endpoint: "https://x/v1" },
      });
    });
    await flush();
    expect(h.synthesize).toHaveBeenCalledTimes(1);
    expect(h.synthesize.mock.calls[0][0].voiceId).toBe("alloy");
    await act(async () => {
      h.resolveSynthesize({ blob: new Blob(["x"], { type: "audio/mpeg" }), mime: "audio/mpeg" });
    });
    await flush();
    await act(async () => {
      h.resolvePlay();
    });
    await flush();
    expect(h.synthesize).toHaveBeenCalledTimes(1);
  });

  it("surfaces kokoro model-download percent while generating and clears it when done", async () => {
    const h = makeHarness();
    act(() => {
      h.capture.preview?.({ backend: TTS_BACKEND.Kokoro, voiceId: "af_heart", speed: 1, config: null });
    });
    await flush();
    expect(h.states).toContain("generating");
    act(() => {
      h.emitProgress(37);
    });
    await flush();
    expect(h.downloadPcts).toContain(37);
    await act(async () => {
      h.resolveSynthesize({ blob: new Blob(["x"]), mime: "audio/wav" });
    });
    await flush();
    await act(async () => {
      h.resolvePlay();
    });
    await flush();
    expect(h.states[h.states.length - 1]).toBe("idle");
    expect(h.downloadPcts[h.downloadPcts.length - 1]).toBeNull();
  });
});
