import { afterEach, describe, expect, it, mock } from "bun:test";

import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const realImageGenApi = await import("../api/image-gen-api.js");
import type { ImageGenProgressInfoValue } from "@vibe-tavern/api-contracts";

/** Captured poll calls: (profileId, abort-signal-presence) per call. */
const pollCalls: Array<{ profileId: string; hasSignal: boolean }> = [];

/** Scripted responses by call index; exhausted entries repeat the last. */
const script: Array<ImageGenProgressInfoValue | Error> = [];

mock.module("../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  fetchImageGenProgress: (profileId: string, signal?: AbortSignal) => {
    pollCalls.push({ profileId, hasSignal: signal !== undefined });
    const next = script.length > 1 ? script.shift() : script[0];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? null);
  },
}));

const { renderHook, act, waitFor } = await import("@testing-library/react");
const { useImageGenProgress } = await import("./use-image-gen-progress.js");

function snapshot(progress: number, etaRelative?: number, previewBase64?: string): ImageGenProgressInfoValue {
  return { progress, ...(etaRelative !== undefined ? { etaRelative } : {}), ...(previewBase64 !== undefined ? { previewBase64 } : {}) };
}

afterEach(() => {
  pollCalls.length = 0;
  script.length = 0;
});

describe("useImageGenProgress (PG-2)", () => {
  it("does not poll while inactive or without a profile", async () => {
    const idle = renderHook(() => useImageGenProgress(false, "p1", 1_000_000_000));
    expect(idle.result.current).toBeNull();
    const noProfile = renderHook(() => useImageGenProgress(true, null, 1_000_000_000));
    expect(noProfile.result.current).toBeNull();
    expect(pollCalls).toEqual([]);
  });

  it("fetches immediately on activation and surfaces the snapshot", async () => {
    script.push(snapshot(0.42, 7.5));
    const view = renderHook(() => useImageGenProgress(true, "p1", 1_000_000_000));
    await waitFor(() => expect(view.result.current).not.toBeNull());
    expect(view.result.current).toEqual({ progress: 0.42, etaRelative: 7.5 });
    expect(pollCalls).toEqual([{ profileId: "p1", hasSignal: true }]);
  });

  it("keeps polling on the interval cadence (injectable intervalMs)", async () => {
    script.push(snapshot(0.1), snapshot(0.5), snapshot(0.9));
    const view = renderHook(() => useImageGenProgress(true, "p1", 5));
    // Terminal-state pin (the fast cadence outruns intermediate asserts):
    // the final script entry landing proves the interval ticked past the
    // immediate first fetch.
    await waitFor(() => expect(view.result.current?.progress).toBe(0.9), { timeout: 2000 });
    expect(pollCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("a failed tick keeps the cadence alive (the next good tick lands)", async () => {
    script.push(snapshot(0.3), new Error("instance busy"), snapshot(0.8));
    const view = renderHook(() => useImageGenProgress(true, "p1", 5));
    // The error tick must neither throw nor kill the loop — reaching 0.8
    // after it is the boundary under test.
    await waitFor(() => expect(view.result.current?.progress).toBe(0.8), { timeout: 2000 });
    expect(pollCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("deactivation clears the snapshot and stops the cadence", async () => {
    script.push(snapshot(0.6));
    const view = renderHook((props: { active: boolean }) => useImageGenProgress(props.active, "p1", 5), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(view.result.current?.progress).toBe(0.6), { timeout: 2000 });
    const callsAtStop = pollCalls.length;
    await act(async () => {
      view.rerender({ active: false });
    });
    expect(view.result.current).toBeNull();
    // Give a would-be stray tick room to fire; the count must stay put.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(pollCalls.length).toBe(callsAtStop);
  });
});
