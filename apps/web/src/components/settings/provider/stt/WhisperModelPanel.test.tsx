/**
 * useWhisperModel + WhisperModelPanel tests (audit P5) — a PORT of
 * KokoroModelPanel.test.tsx with the SAME boundaries, through the deps
 * seam (never mock.module on the hook — process-global leak rule). Ported
 * boundaries: ready-with-active, idle cards + download forwards the
 * selection, progress aggregation, garbage-payload tolerance, switch from
 * ready, error + retry. Dropped kokoro-only boundaries (pre-approved P5
 * deviations): WebGPU gating, gpu→cpu fallback notice, auto-preview.
 * Added STT-specific boundary: Download/Switch PERSISTS the pick into
 * config.model via the form hook (the kokoro twin persists its variant).
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// Same i18n fake as KokoroModelPanel.test.tsx: the panel renders under a
// raw-key t (interpolated params appended after ":"). Registered BEFORE the
// component import so the panel picks up the mocked context.
const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params === "object") {
        return `${key}:${Object.values(params).map(String).join(":")}`;
      }
      return key;
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

import {
  __setWhisperModelDepsForTests,
  type WhisperModelClient,
  type WhisperModelDeps,
} from "./use-whisper-model.js";
import { __setWhisperLaneProbeForTests } from "../../../../lib/stt/whisper-client-instance.js";
import { DEFAULT_WHISPER_MODEL_ID, STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileForm } from "./use-stt-profiles.js";

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { WhisperModelPanel } = await import("./WhisperModelPanel.js");

const TINY_EN = "onnx-community/whisper-tiny.en";
const BASE = "onnx-community/whisper-base";
const SMALL = "onnx-community/whisper-small";

function makeForm(configModel: string = BASE): SttProfileForm {
  return {
    id: "p1",
    name: "Browser",
    backend: STT_BACKENDS.WhisperBrowser,
    config: { model: configModel },
    apiKey: "",
    autoKeyProviderName: null,
    hasStoredApiKey: false,
    emotionAnnotation: false,
  };
}

/**
 * Fake engine: the client surface (isLoaded + progress listeners) with a
 * scriptable loadModel (records the requested model id, resolves/rejects
 * manually), plus the activeModel getter.
 */
function makeFakeEngine(options: { alreadyLoaded?: boolean; startActive?: string | null } = {}) {
  let loaded = options.alreadyLoaded === true;
  const listeners = new Set<(progress: { data: unknown }) => void>();
  const client: WhisperModelClient = {
    isLoaded: () => loaded,
    onLoadProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let active: string | null = options.startActive ?? (loaded ? BASE : null);
  const deps: WhisperModelDeps & {
    client: WhisperModelClient;
    loadModels: string[];
    emit: (data: unknown) => void;
    resolveLoad: (activeAfter?: string) => void;
    rejectLoad: (error: Error) => void;
    pendingResolve: ((activeAfter?: string) => void) | null;
    pendingReject: ((error: Error) => void) | null;
  } = {
    client,
    loadModel: (modelId: string) => {
      deps.loadModels.push(modelId);
      if (deps.pendingResolve === null) {
        deps.pendingResolve = () => {};
        deps.pendingReject = () => {};
      }
      return new Promise<void>((resolve, reject) => {
        deps.pendingResolve = (activeAfter) => {
          loaded = true;
          active = activeAfter ?? modelId;
          resolve();
        };
        deps.pendingReject = (error) => reject(error);
      });
    },
    activeModel: () => active,
    loadModels: [],
    emit: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
    resolveLoad: (activeAfter) => deps.pendingResolve?.(activeAfter),
    rejectLoad: (error) => deps.pendingReject?.(error),
    pendingResolve: null as ((activeAfter?: string) => void) | null,
    pendingReject: null as ((error: Error) => void) | null,
  };
  return deps;
}

function renderPanel(configModel: string = BASE, setForm = mock((_patch: unknown) => {})) {
  const stt = { setForm };
  return {
    view: render(React.createElement(WhisperModelPanel, { form: makeForm(configModel), stt: stt as never })),
    setForm,
  };
}

beforeEach(() => {
  __setWhisperModelDepsForTests(null);
});

afterEach(async () => {
  __setWhisperModelDepsForTests(null);
  await act(async () => {});
  cleanup();
});

describe("useWhisperModel + WhisperModelPanel", () => {
  it("already-loaded client renders the ready state: active model + switch, no download", async () => {
    const fake = makeFakeEngine({ alreadyLoaded: true, startActive: SMALL });
    __setWhisperModelDepsForTests(fake);
    const { view } = renderPanel();
    expect(view.getByTestId("stt-whisper-model-ready")).toBeTruthy();
    expect(view.queryByTestId("stt-whisper-model-download-btn")).toBeNull();
    expect(view.getByTestId("stt-whisper-model-active").textContent).toContain("Whisper Small (multilingual)");
    expect(view.getByTestId("stt-whisper-model-switch-btn")).toBeTruthy();
  });

  it("idle: three roster cards (default + english-only badges), download passes the SELECTED model", async () => {
    const fake = makeFakeEngine();
    __setWhisperModelDepsForTests(fake);
    const { view } = renderPanel();
    expect(view.getByTestId("stt-whisper-model-onnx-community-whisper-tiny-en")).toBeTruthy();
    expect(view.getByTestId("stt-whisper-model-onnx-community-whisper-base")).toBeTruthy();
    expect(view.getByTestId("stt-whisper-model-onnx-community-whisper-small")).toBeTruthy();
    // Default badge on the roster default, english-only badge on tiny.en.
    expect(view.getByTestId("stt-whisper-model-list").textContent).toContain("stt_whisper_model_default");
    expect(view.getByTestId("stt-whisper-model-list").textContent).toContain("stt_whisper_model_english_only");
    // Initial selection (no stored choice drift — config holds the default)
    // forwards the default on download.
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-downloading")).toBeTruthy());
    expect(fake.loadModels).toEqual([DEFAULT_WHISPER_MODEL_ID]);

    // Two files: aggregate counters + percent.
    act(() => {
      fake.emit({ status: "progress", file: "model.onnx", loaded: 45 * 1048576, total: 90 * 1048576 });
      fake.emit({ status: "progress", file: "ort.bin", loaded: 5 * 1048576, total: 25 * 1048576 });
    });
    await waitFor(() => {
      expect(view.getByTestId("stt-whisper-model-downloading").textContent).toContain("43%");
      expect(view.getByTestId("stt-whisper-model-downloading").textContent).toContain("50 / 115 MB");
    });
    // Garbage payloads (non-file events) are ignored, not crashes.
    act(() => {
      fake.emit({ status: "initiate" });
      fake.emit(null);
    });
    act(() => {
      fake.resolveLoad(BASE);
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-ready")).toBeTruthy());
    expect(view.getByTestId("stt-whisper-model-active").textContent).toContain("Whisper Base (multilingual)");
  });

  it("an explicitly selected card reaches the engine on download and persists into config.model", async () => {
    const fake = makeFakeEngine();
    __setWhisperModelDepsForTests(fake);
    const { view, setForm } = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-onnx-community-whisper-tiny-en"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-downloading")).toBeTruthy());
    expect(fake.loadModels).toEqual([TINY_EN]);
    // The pick persists through the form hook (the kokoro persist twin).
    expect(setForm).toHaveBeenCalledWith({ config: { model: TINY_EN } });
    act(() => {
      fake.resolveLoad(TINY_EN);
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-ready")).toBeTruthy());
    expect(view.getByTestId("stt-whisper-model-active").textContent).toContain("Whisper Tiny (English)");
  });

  it("ready → Сменить модель reveals the picker; switching reloads the new model", async () => {
    const fake = makeFakeEngine({ alreadyLoaded: true, startActive: BASE });
    __setWhisperModelDepsForTests(fake);
    const { view } = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-switch-btn"));
    });
    // Picker reappears with the download button (separate acts: each click
    // must see the previous state update flushed).
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-onnx-community-whisper-small"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-downloading")).toBeTruthy());
    expect(fake.loadModels).toEqual([SMALL]);
    act(() => {
      fake.resolveLoad(SMALL);
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-ready")).toBeTruthy());
    expect(view.getByTestId("stt-whisper-model-active").textContent).toContain("Whisper Small (multilingual)");
    expect(view.getByTestId("stt-whisper-model-switch-btn")).toBeTruthy();
  });

  it("load failure renders the error + Retry; retry re-sends the selected model", async () => {
    const fake = makeFakeEngine();
    __setWhisperModelDepsForTests(fake);
    const { view } = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-download-btn"));
    });
    act(() => {
      fake.rejectLoad(new Error("stalled — mirror unreachable"));
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-error").textContent).toContain("mirror unreachable"));
    // The picker stays usable from the error state; retry re-sends the selection.
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-retry-btn"));
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-downloading")).toBeTruthy());
    expect(fake.loadModels).toEqual([BASE, BASE]);
  });

  it("DUAL-WRITER PIN: a level-2 config.model change resyncs the panel selection (not mid-choice)", async () => {
    const fake = makeFakeEngine();
    __setWhisperModelDepsForTests(fake);
    // Level-1 panel mounted while config still holds BASE…
    const { view, setForm } = renderPanel(BASE);
    const baseBtn = view.getByTestId("stt-whisper-model-onnx-community-whisper-base");
    const smallBtn = view.getByTestId("stt-whisper-model-onnx-community-whisper-small");
    expect(baseBtn.className).toContain("border-accent");
    expect(smallBtn.className).not.toContain("border-accent");
    // …then the user picks SMALL in the level-2 roster dropdown (it writes
    // config.model — a new form object flows in as a prop).
    await act(async () => {
      view.rerender(
        React.createElement(WhisperModelPanel, {
          form: makeForm(SMALL),
          stt: { setForm } as never,
        }),
      );
    });
    // The panel follows the level-2 pick: the SMALL card is highlighted…
    const smallAfter = view.getByTestId("stt-whisper-model-onnx-community-whisper-small");
    expect(smallAfter.className).toContain("border-accent");
    // …and Download forwards SMALL — not the stale BASE — and persists SMALL.
    await act(async () => {
      fireEvent.click(view.getByTestId("stt-whisper-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-downloading")).toBeTruthy());
    expect(fake.loadModels).toEqual([SMALL]);
    expect(setForm).toHaveBeenCalledWith({ config: { model: SMALL } });
    // Mid-choice is exempt: once the user clicks a card HERE, the level-2
    // value no longer overwrites their in-panel selection.
    act(() => {
      fake.resolveLoad(SMALL);
    });
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-ready")).toBeTruthy());
  });
});

describe("WhisperModelPanel GPU lane display (owner 2026-09-05)", () => {
  afterEach(() => {
    __setWhisperLaneProbeForTests(null);
  });

  it("default (no WebGPU): CPU badge + q8 size on the cards", () => {
    const { view } = renderPanel(BASE);
    // One lane badge per roster card (3 cards).
    const badges = view.getAllByTestId("stt-whisper-model-lane");
    expect(badges.length).toBe(3);
    for (const badge of badges) expect(badge.textContent).toBe("stt_whisper_lane_cpu");
    expect(view.getByTestId("stt-whisper-model-onnx-community-whisper-base").textContent).toContain(
      "stt_whisper_model_size:80",
    );
  });

  it("WebGPU lane: GPU badge + the fp16 size (the set that will actually download)", () => {
    __setWhisperLaneProbeForTests(() => "webgpu");
    const { view } = renderPanel(BASE);
    for (const badge of view.getAllByTestId("stt-whisper-model-lane")) {
      expect(badge.textContent).toBe("stt_whisper_lane_gpu");
    }
    expect(view.getByTestId("stt-whisper-model-onnx-community-whisper-base").textContent).toContain(
      "stt_whisper_model_size:146",
    );
  });
});
