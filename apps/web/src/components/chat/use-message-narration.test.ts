import { describe, expect, test, beforeEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import { useTtsPlaybackStore, __setTtsPlaybackDepsForTests } from "../../stores/tts-playback-store.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";

function profile(overrides: Partial<TtsProfileRecord> = {}): TtsProfileRecord {
  return {
    id: "p1",
    name: "Default",
    backend: "kokoro",
    config: {},
    hasStoredApiKey: false,
    providerRef: null,
    autoKeyProviderName: null,
    voiceId: "af_heart",
    narratorVoiceId: null,
    lang: "en",
    sortOrder: 0,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const pDefault = profile({ id: "p1", isDefault: true, name: "Default", sortOrder: 0 });
const pChar = profile({ id: "p2", isDefault: false, name: "CharVoice", sortOrder: 1 });

let currentData: { profiles: TtsProfileRecord[]; links: Array<{ ttsProfileId: string; targetType: "character" | "persona"; targetId: string; mode: "voice" | "disabled" }> } | null = null;

// Mock voice-map-data before importing the hook
const realVoiceMapData = await import("../../lib/tts/voice-map-data.js");
mock.module("../../lib/tts/voice-map-data.js", () => ({
  ...realVoiceMapData,
  useVoiceMapData: () => ({
    data: currentData,
    refresh: async () => {},
  }),
  refreshVoiceMapData: async () => {},
}));

const { render, act, cleanup } = await import("@testing-library/react");
const { useMessageNarration } = await import("./use-message-narration.js");

const originalStart = useTtsPlaybackStore.getState().startNarration;
const originalStop = useTtsPlaybackStore.getState().stopNarration;

beforeEach(() => {
  useTtsPlaybackStore.setState({
    narrations: {},
    rate: 1,
    autoNarrate: false,
    startNarration: originalStart,
    stopNarration: originalStop,
  } as never);
  __setTtsPlaybackDepsForTests(null);
  currentData = null;
  cleanup();
});

describe("useMessageNarration", () => {
  test("available=true when resolution is profile (assistant path)", async () => {
    currentData = {
      profiles: [pDefault, pChar],
      links: [{ ttsProfileId: "p2", targetType: "character", targetId: "char1", mode: "voice" }],
    };
    let hook: any = null;
    function Probe() {
      hook = (useMessageNarration as any)("m1", "char1", null, () => "hello");
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe));
    });
    expect(hook?.available).toBe(true);
    expect(hook?.narrating).toBe(false);
  });

  test("available=false for disabled, none, and loading", async () => {
    // disabled
    currentData = {
      profiles: [pDefault],
      links: [{ ttsProfileId: "p1", targetType: "character", targetId: "char1", mode: "disabled" }],
    };
    let hook1: any = null;
    function Probe1() {
      hook1 = (useMessageNarration as any)("m1", "char1", null, () => "hello");
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe1));
    });
    expect(hook1?.available).toBe(false);
    cleanup();

    // none (no default, no links)
    currentData = {
      profiles: [profile({ id: "p2", isDefault: false })],
      links: [],
    };
    let hook2: any = null;
    function Probe2() {
      hook2 = (useMessageNarration as any)("m2", "char1", null, () => "hello");
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe2));
    });
    expect(hook2?.available).toBe(false);
    cleanup();

    // loading (null data)
    currentData = null;
    let hook3: any = null;
    function Probe3() {
      hook3 = (useMessageNarration as any)("m3", "char1", null, () => "hello");
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe3));
    });
    expect(hook3?.available).toBe(false);
  });

  test("onNarrate toggles start vs stop", async () => {
    currentData = {
      profiles: [pDefault],
      links: [],
    };
    const startMock = mock(async () => {});
    const stopMock = mock(() => {});
    // Inject fake player/synthesize so startNarration doesn't need real audio
    const fakePlayer = {
      play: async () => "ended" as const,
      skipCurrent: () => {},
      pause: () => {},
      resume: () => {},
      setRate: () => {},
      dispose: () => {},
    };
    const fakeSynthesize = mock(async (text: string) => ({ blob: new Blob([text], { type: "audio/mpeg" }), mime: "audio/mpeg" }));
    __setTtsPlaybackDepsForTests({ player: fakePlayer as never, synthesize: fakeSynthesize as never });

    const origStart = useTtsPlaybackStore.getState().startNarration;
    const origStop = useTtsPlaybackStore.getState().stopNarration;
    let startCalled = false;
    let stopCalled = false;
    useTtsPlaybackStore.setState({
      startNarration: async (...args: unknown[]) => {
        startCalled = true;
        return origStart(...(args as [string, string, TtsProfileRecord]));
      },
      stopNarration: () => {
        stopCalled = true;
        return origStop();
      },
    } as never);

    let hook: any = null;
    function Probe() {
      hook = (useMessageNarration as any)("m1", null, null, () => "Hello world");
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe));
    });
    expect(hook?.available).toBe(true);
    // Not narrating -> onNarrate should start
    await act(async () => {
      hook!.onNarrate();
    });
    // Give the async start a tick
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(startCalled).toBe(true);

    // Simulate narrating state
    useTtsPlaybackStore.setState({
      narrations: { m1: { status: "playing", total: 1, played: 0 } },
    } as never);
    // Re-render to pick up narrating=true
    await act(async () => {
      render(React.createElement(Probe));
    });
    // Need fresh hook instance after re-render? Probe captures latest
    // The hook now should report narrating true
    expect(hook?.narrating).toBe(true);
    await act(async () => {
      hook!.onNarrate();
    });
    expect(stopCalled).toBe(true);

    // Restore
    useTtsPlaybackStore.setState({ narrations: {} } as never);
    __setTtsPlaybackDepsForTests(null);
  });

  test("narration text passed through prepareNarrationText (codeblock stripped)", async () => {
    currentData = {
      profiles: [pDefault],
      links: [],
    };
    let capturedText: string | null = null;
    const fakePlayer = {
      play: async () => "ended" as const,
      skipCurrent: () => {},
      pause: () => {},
      resume: () => {},
      setRate: () => {},
      dispose: () => {},
    };
    const fakeSynthesize = mock(async (text: string) => {
      capturedText = text;
      return { blob: new Blob([text], { type: "audio/mpeg" }), mime: "audio/mpeg" };
    });
    __setTtsPlaybackDepsForTests({ player: fakePlayer as never, synthesize: fakeSynthesize as never });

    let hook: any = null;
    function Probe() {
      hook = (useMessageNarration as any)("m1", null, null, () => "Hello ```code block``` world *action*");
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe));
    });
    await act(async () => {
      hook!.onNarrate();
      await new Promise((r) => setTimeout(r, 20));
    });
    // prepareNarrationText with skipCodeblocks/stripHtml/stripAsteriskActions should remove codeblock and action
    expect(capturedText).not.toBeNull();
    expect(capturedText as unknown as string).not.toContain("code block");
    expect(capturedText as unknown as string).not.toContain("action");
    expect(capturedText as unknown as string).toContain("Hello");
    expect(capturedText as unknown as string).toContain("world");
    __setTtsPlaybackDepsForTests(null);
  });
});
