import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// Same i18n fake as TtsProfileEditor.test.tsx: the panel renders under a
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

// Auto-preview interception — via the RESETTABLE deps seam, not a module
// mock: mock.module("./use-tts-preview.js") is process-global and would leak
// a stubbed useTtsPreview into every later file in a shared bun-test process
// (observed: use-tts-preview.test.ts phantom failures in combined runs).
// The seam keeps the real hook logic; only synthesize/play are intercepted,
// and afterEach resets it to null.
import { __setTtsPreviewDepsForTests, type TtsPreviewDeps } from "./use-tts-preview.js";

import {
  __setKokoroModelDepsForTests,
  type KokoroModelClient,
  type KokoroModelDeps,
} from "./use-kokoro-model.js";
import { clearStoredKokoroVariant } from "../../../../lib/tts/kokoro/kokoro-load-options.js";

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { KokoroModelPanel } = await import("./KokoroModelPanel.js");

/**
 * Fake engine: the client surface (isLoaded + progress listeners) with a
 * scriptable loadModel (records the requested variant, resolves/rejects
 * manually), plus the activeVariant/consumeFallbackNotice getters.
 */
function makeFakeEngine(options: { alreadyLoaded?: boolean; startActive?: "gpu" | "cpu" | null } = {}) {
  let loaded = options.alreadyLoaded === true;
  const listeners = new Set<(progress: { data: unknown }) => void>();
  const client: KokoroModelClient = {
    isLoaded: () => loaded,
    onLoadProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let active: "gpu" | "cpu" | null = options.startActive ?? (loaded ? "cpu" : null);
  const deps: KokoroModelDeps & {
    client: KokoroModelClient;
    loadVariants: string[];
    emit: (data: unknown) => void;
    resolveLoad: (activeAfter?: "gpu" | "cpu") => void;
    rejectLoad: (error: Error) => void;
    pendingResolve: ((activeAfter?: "gpu" | "cpu") => void) | null;
    pendingReject: ((error: Error) => void) | null;
    nextNotice: string | null;
  } = {
    client,
    loadModel: (variant: "gpu" | "cpu") => {
      deps.loadVariants.push(variant);
      if (deps.pendingResolve === null) {
        deps.pendingResolve = () => {};
        deps.pendingReject = () => {};
      }
      return new Promise<void>((resolve, reject) => {
        deps.pendingResolve = (activeAfter) => {
          loaded = true;
          active = activeAfter ?? variant;
          resolve();
        };
        deps.pendingReject = (error) => reject(error);
      });
    },
    activeVariant: () => active,
    consumeFallbackNotice: () => {
      const notice = deps.nextNotice;
      deps.nextNotice = null;
      return notice;
    },
    webgpuAvailable: true,
    loadVariants: [],
    emit: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
    resolveLoad: (activeAfter) => deps.pendingResolve?.(activeAfter),
    rejectLoad: (error) => deps.pendingReject?.(error),
    pendingResolve: null as ((activeAfter?: "gpu" | "cpu") => void) | null,
    pendingReject: null as ((error: Error) => void) | null,
    nextNotice: null as string | null,
  };
  return deps;
}

function renderPanel() {
  return render(React.createElement(KokoroModelPanel));
}

let previewSynth: ReturnType<typeof mock>;
let previewPlay: ReturnType<typeof mock>;

beforeEach(() => {
  __setKokoroModelDepsForTests(null);
  clearStoredKokoroVariant();
  // Intercept synthesis for the whole file: download-flow tests reach the
  // ready state, and the auto-preview effect must not hit the real kokoro
  // client. Synthesize resolves a throwaway blob; play is a no-op.
  previewSynth = mock((input: { voiceId?: string }) =>
    Promise.resolve({ blob: new Blob(["x"]), mime: "audio/wav" }));
  previewPlay = mock(() => Promise.resolve());
  const deps: TtsPreviewDeps = { synthesize: previewSynth as TtsPreviewDeps["synthesize"], play: previewPlay as TtsPreviewDeps["play"] };
  __setTtsPreviewDepsForTests(deps);
});

afterEach(async () => {
  __setTtsPreviewDepsForTests(null);
  await act(async () => {});
  cleanup();
});

describe("useKokoroModel + KokoroModelPanel", () => {
  it("already-loaded client renders the ready state: active variant + switch, no download", async () => {
    const fake = makeFakeEngine({ alreadyLoaded: true, startActive: "gpu" });
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy();
    expect(view.queryByTestId("tts-kokoro-model-download-btn")).toBeNull();
    expect(view.getByTestId("tts-kokoro-model-active").textContent).toContain("tts_kokoro_variant_gpu_name");
    expect(view.getByTestId("tts-kokoro-model-switch-btn")).toBeTruthy();
  });

  it("idle: two variant cards (gpu recommended), download passes the SELECTED variant", async () => {
    const fake = makeFakeEngine();
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    const gpu = view.getByTestId("tts-kokoro-variant-gpu") as HTMLButtonElement;
    const cpu = view.getByTestId("tts-kokoro-variant-cpu") as HTMLButtonElement;
    // WebGPU available: gpu first with the recommended badge, enabled.
    expect(gpu.disabled).toBe(false);
    expect(view.getByTestId("tts-kokoro-variant-list").textContent).toContain("tts_kokoro_variant_recommended");
    // Auto selection (no stored choice, webgpu) is gpu; download forwards it.
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
    expect(fake.loadVariants).toEqual(["gpu"]);

    // Two files (model ~90MB, wasm ~25MB): aggregate counters + percent.
    act(() => {
      fake.emit({ status: "progress", file: "model.onnx", loaded: 45 * 1048576, total: 90 * 1048576 });
      fake.emit({ status: "progress", file: "ort.bin", loaded: 5 * 1048576, total: 25 * 1048576 });
    });
    await waitFor(() => {
      expect(view.getByTestId("tts-kokoro-model-downloading").textContent).toContain("43%");
      expect(view.getByTestId("tts-kokoro-model-downloading").textContent).toContain("50 / 115 MB");
    });
    // Garbage payloads (non-file events) are ignored, not crashes.
    act(() => {
      fake.emit({ status: "initiate" });
      fake.emit(null);
    });
    act(() => {
      fake.resolveLoad("gpu");
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    expect(view.getByTestId("tts-kokoro-model-active").textContent).toContain("tts_kokoro_variant_gpu_name");
  });

  it("no WebGPU: gpu card disabled with the unavailable note, cpu preselected", async () => {
    const fake = makeFakeEngine();
    fake.webgpuAvailable = false;
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    const gpu = view.getByTestId("tts-kokoro-variant-gpu") as HTMLButtonElement;
    expect(gpu.disabled).toBe(true);
    expect(view.getByTestId("tts-kokoro-variant-list").textContent).toContain("tts_kokoro_variant_gpu_unavailable");
    expect(view.getByTestId("tts-kokoro-variant-list").textContent).not.toContain("tts_kokoro_variant_recommended");

    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
    expect(fake.loadVariants).toEqual(["cpu"]);
  });

  it("cpu variant can be selected explicitly and reaches the engine on download", async () => {
    const fake = makeFakeEngine();
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-variant-cpu"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
    expect(fake.loadVariants).toEqual(["cpu"]);
    act(() => {
      fake.resolveLoad("cpu");
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    expect(view.getByTestId("tts-kokoro-model-active").textContent).toContain("tts_kokoro_variant_cpu_name");
  });

  it("ready → Сменить вариант reveals the picker; switching reloads the new variant", async () => {
    const fake = makeFakeEngine({ alreadyLoaded: true, startActive: "gpu" });
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-switch-btn"));
    });
    // Picker reappears with the download button (separate acts: each click
    // must see the previous state update flushed).
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-variant-cpu"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
    expect(fake.loadVariants).toEqual(["cpu"]);
    act(() => {
      fake.resolveLoad("cpu");
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    expect(view.getByTestId("tts-kokoro-model-active").textContent).toContain("tts_kokoro_variant_cpu_name");
    expect(view.getByTestId("tts-kokoro-model-switch-btn")).toBeTruthy();
  });

  it("gpu→cpu fallback notice is rendered once after the load", async () => {
    const fake = makeFakeEngine();
    fake.nextNotice = "adapter is blocklisted";
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    act(() => {
      fake.resolveLoad("cpu");
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    expect(view.getByTestId("tts-kokoro-model-fallback").textContent).toContain("blocklisted");
    // Second load with no notice: the line disappears.
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-switch-btn"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    act(() => {
      fake.resolveLoad("gpu");
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    expect(view.queryByTestId("tts-kokoro-model-fallback")).toBeNull();
  });

  it("load failure renders the error + Retry; retry re-sends the selected variant", async () => {
    const fake = makeFakeEngine();
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    act(() => {
      fake.rejectLoad(new Error("stalled — huggingface.co unreachable"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-error").textContent).toContain("huggingface.co"));
    // The picker stays usable from the error state; retry re-sends the selection.
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-retry-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
    expect(fake.loadVariants).toEqual(["gpu", "gpu"]);
  });

  it("auto-preview fires once after download success, not on mount or twice", async () => {
    const fake = makeFakeEngine();
    __setKokoroModelDepsForTests(fake);
    const view = renderPanel();
    expect(previewSynth).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
    expect(previewSynth).not.toHaveBeenCalled();
    act(() => {
      fake.resolveLoad("gpu");
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    await waitFor(() => expect(previewSynth).toHaveBeenCalledTimes(1));
    expect(((previewSynth.mock.calls[0] as unknown as unknown[])[0] as { voiceId: string }).voiceId).toBe("af_heart");
    // Second download should fire again once
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-switch-btn"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-variant-cpu"));
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
    act(() => {
      fake.resolveLoad("cpu");
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    await waitFor(() => expect(previewSynth).toHaveBeenCalledTimes(2));
  });
});
