import { describe, expect, test, beforeEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import { useTtsPlaybackStore, __setTtsPlaybackDepsForTests } from "../../stores/tts-playback-store.js";
import type { TtsProfileRecord } from "../../api/tts-api.js";
import { TTS_NARRATION_MODE_KEY, persistTtsNarrationMode } from "../../lib/local-storage.js";

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
  window.localStorage.removeItem(TTS_NARRATION_MODE_KEY);
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

  test("narration text honors the D26 mode pref (default full: codeblock dropped, asterisk content KEPT)", async () => {
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
      hook = (useMessageNarration as any)("m1", null, null, () => "Hello ```code block``` world *shaking* **nervously**");
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe));
    });
    await act(async () => {
      hook!.onNarrate();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Default (no stored pref) = "full": codeblock stripped, asterisk MARKERS
    // stripped, span content KEPT — the v1 silent-cut remediation (D26).
    expect(capturedText).not.toBeNull();
    const text = capturedText as unknown as string;
    expect(text).not.toContain("code block");
    expect(text).toContain("shaking");
    expect(text).toContain("nervously");
    expect(text).not.toContain("*");
    __setTtsPlaybackDepsForTests(null);
  });

  test("stored mode drives the pipeline: quoted-dialogue speaks only the quoted line", async () => {
    currentData = {
      profiles: [pDefault],
      links: [],
    };
    persistTtsNarrationMode("quoted-dialogue");
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
      hook = (useMessageNarration as any)("m1", null, null, () => 'He whispered "don\u2019t *ever* come back" and left');
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe));
    });
    await act(async () => {
      hook!.onNarrate();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Quoted mode: only the quoted dialogue; the * markers inside the quote
    // are stripped but "ever" survives (order: markers before quotedOnly).
    expect(capturedText as unknown as string).toBe("don’t ever come back");
    __setTtsPlaybackDepsForTests(null);
  });
});

// ── TPE-1: annotation tags survive the mode pipeline ─────────────────────────

describe("useMessageNarration — TTS annotation tags (TPE-1)", () => {
  test("tags in the narration source pass through quoted-dialogue mode instead of being dropped", async () => {
    currentData = { profiles: [pDefault], links: [] };
    persistTtsNarrationMode("quoted-dialogue");
    let capturedText: unknown = null;
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
    useTtsPlaybackStore.setState({
      startNarration: async (...args: unknown[]) => {
        capturedText = args[1];
        return origStart(...(args as [string, string, TtsProfileRecord]));
      },
    } as never);

    let hook: any = null;
    function Probe() {
      hook = (useMessageNarration as any)("m1", null, null, () => 'She [laugh] softly. "Wait, don’t *ever* go."');
      return null;
    }
    await act(async () => {
      render(React.createElement(Probe));
    });
    await act(async () => {
      hook!.onNarrate();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Quoted mode keeps the dialogue; the laugh (anchor dropped by the
    // quote filter) falls to the end instead of vanishing.
    expect(capturedText as unknown as string).toBe("Wait, don’t ever go. [laugh]");
    __setTtsPlaybackDepsForTests(null);
  });
});
