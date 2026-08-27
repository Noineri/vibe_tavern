import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import {
  __setKokoroModelDepsForTests,
  type KokoroModelClient,
} from "./use-kokoro-model.js";
import { KokoroModelPanel } from "./KokoroModelPanel.js";

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");

/** Fake client: isLoaded flag, scripted load, manual progress emission. */
function makeFakeClient(options: { alreadyLoaded?: boolean } = {}) {
  let loaded = options.alreadyLoaded === true;
  let loadPromise: Promise<void> | null = null;
  const listeners = new Set<(progress: { data: unknown }) => void>();
  const client: KokoroModelClient = {
    isLoaded: () => loaded,
    load: () => {
      if (loadPromise === null) {
        loadPromise = new Promise<void>((resolve, reject) => {
          fake.resolveLoad = () => {
            loaded = true;
            loadPromise = null; // mirror the real client: settled load is not cached
            resolve();
          };
          fake.rejectLoad = (error: Error) => {
            loadPromise = null; // a failed load retries cleanly on the next call
            reject(error);
          };
        });
      }
      return loadPromise;
    },
    onLoadProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const fake = {
    client,
    emit: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
    resolveLoad: (): void => {},
    rejectLoad: (_error: Error): void => {},
  };
  return fake;
}

function renderPanel() {
  return render(React.createElement(KokoroModelPanel));
}

beforeEach(() => {
  __setKokoroModelDepsForTests(null);
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

describe("useKokoroModel + KokoroModelPanel", () => {
  it("already-loaded client renders the ready state without any download", async () => {
    const fake = makeFakeClient({ alreadyLoaded: true });
    __setKokoroModelDepsForTests({ client: fake.client });
    const view = renderPanel();
    expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy();
    expect(view.queryByTestId("tts-kokoro-model-download-btn")).toBeNull();
  });

  it("idle: explicit download button; click starts the load and shows live aggregated progress", async () => {
    const fake = makeFakeClient();
    const originalLoad = fake.client.load;
    let loadCalls = 0;
    fake.client.load = () => {
      loadCalls += 1;
      return originalLoad();
    };
    __setKokoroModelDepsForTests({ client: fake.client });
    const view = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
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
      fake.resolveLoad();
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-ready")).toBeTruthy());
    expect(loadCalls).toBe(1);
  });

  it("load failure renders the error + Retry; retry path goes back to downloading", async () => {
    const fake = makeFakeClient();
    __setKokoroModelDepsForTests({ client: fake.client });
    const view = renderPanel();
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-download-btn"));
    });
    act(() => {
      fake.rejectLoad(new Error("stalled — huggingface.co unreachable"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-error").textContent).toContain("huggingface.co"));
    await act(async () => {
      fireEvent.click(view.getByTestId("tts-kokoro-model-retry-btn"));
    });
    await waitFor(() => expect(view.getByTestId("tts-kokoro-model-downloading")).toBeTruthy());
  });
});
