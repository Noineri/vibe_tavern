/**
 * useCopilotContext tests (CM-8) — pins the per-thread context state contract:
 * fetch on mount + thread switch (reset first), live `applyMetrics`, compact
 * flow (POST → metrics + onCompacted, error propagates, re-entrancy guard), and
 * the auto-compact toggle (optimistic PATCH, revert + rethrow on failure).
 *
 * The API functions are mocked at the module boundary (SAFE: capture the real
 * module first, spread `...real`) so the hook's exact call contract is what is
 * asserted — no HTTP, no store machinery.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const realApi = await import("../api/experience-copilot-api.js");

const getExperienceCopilotContext = mock(async (_threadId: string) => ({
  metrics: null as ExperienceCopilotContextMetrics | null,
  autoCompact: true,
}));
const patchExperienceCopilotContext = mock(async (_threadId: string, _body: { autoCompact: boolean }) => ({
  metrics: null as ExperienceCopilotContextMetrics | null,
  autoCompact: _body.autoCompact,
}));
const compactExperienceCopilot = mock(async (_threadId: string) => ({
  digest: { id: "d1", threadId: _threadId, role: "digest", content: "summary", toolCallsJson: null, toolCallId: "u3", createdAt: "" },
  metrics: metrics(500),
}));

mock.module("../api/experience-copilot-api.js", () => ({
  ...realApi,
  getExperienceCopilotContext,
  patchExperienceCopilotContext,
  compactExperienceCopilot,
}));

const { useCopilotContext } = await import("./use-copilot-context.js");

function metrics(total: number): ExperienceCopilotContextMetrics {
  return {
    systemTokens: 100,
    digestTokens: 100,
    historyTokens: 200,
    totalTokens: total,
    budgetTokens: 10000,
    reserveTokens: 1000,
    source: "estimate",
    measuredAt: "2026-08-15T00:00:00.000Z",
  };
}

afterEach(() => {
  getExperienceCopilotContext.mockReset();
  getExperienceCopilotContext.mockImplementation(async () => ({ metrics: null, autoCompact: true }));
  patchExperienceCopilotContext.mockReset();
  patchExperienceCopilotContext.mockImplementation(async (_t, body) => ({ metrics: null, autoCompact: body.autoCompact }));
  compactExperienceCopilot.mockReset();
  compactExperienceCopilot.mockImplementation(async (t) => ({
    digest: { id: "d1", threadId: t, role: "digest", content: "summary", toolCallsJson: null, toolCallId: "u3", createdAt: "" },
    metrics: metrics(500),
  }));
});

describe("useCopilotContext", () => {
  it("fetches context on mount and exposes the resolved state", async () => {
    getExperienceCopilotContext.mockImplementation(async () => ({ metrics: metrics(1234), autoCompact: false }));

    const { result } = renderHook(() => useCopilotContext({ threadId: "t1" }));

    await waitFor(() => expect(result.current.metrics).toEqual(metrics(1234)));
    expect(getExperienceCopilotContext).toHaveBeenCalledWith("t1");
    expect(result.current.autoCompact).toBe(false);
  });

  it("resets state and refetches on thread switch", async () => {
    getExperienceCopilotContext.mockImplementation(async (t) =>
      t === "t1" ? { metrics: metrics(111), autoCompact: false } : { metrics: metrics(222), autoCompact: true },
    );

    const { result, rerender } = renderHook(
      ({ threadId }) => useCopilotContext({ threadId }),
      { initialProps: { threadId: "t1" } },
    );

    await waitFor(() => expect(result.current.metrics).toEqual(metrics(111)));

    rerender({ threadId: "t2" });
    await waitFor(() => expect(result.current.metrics).toEqual(metrics(222)));
    expect(result.current.autoCompact).toBe(true);
    expect(getExperienceCopilotContext).toHaveBeenCalledWith("t2");
  });

  it("applyMetrics overwrites the metrics in place (live SSE feed)", async () => {
    const { result } = renderHook(() => useCopilotContext({ threadId: "t1" }));
    await waitFor(() => expect(getExperienceCopilotContext).toHaveBeenCalled());

    act(() => result.current.applyMetrics(metrics(9999)));
    expect(result.current.metrics).toEqual(metrics(9999));
  });

  it("compact POSTs, bumps metrics, and calls onCompacted", async () => {
    const onCompacted = mock();
    const { result } = renderHook(() => useCopilotContext({ threadId: "t1", onCompacted }));
    await waitFor(() => expect(getExperienceCopilotContext).toHaveBeenCalled());

    await act(async () => {
      await result.current.compact();
    });

    expect(compactExperienceCopilot).toHaveBeenCalledWith("t1", {});
    expect(result.current.metrics).toEqual(metrics(500));
    expect(onCompacted).toHaveBeenCalledTimes(1);
  });

  it("compact forwards the current provider/model selection (not the thread's last-used pair)", async () => {
    // Regression: without the forwarding, the backend silently compacted with
    // the provider of the PREVIOUS turn while the user had another selected.
    const { result, rerender } = renderHook(
      ({ sel }: { sel?: { providerProfileId?: string; model?: string } }) =>
        useCopilotContext({ threadId: "t1", compactProvider: sel }),
      { initialProps: { sel: { providerProfileId: "p9", model: "m9" } as { providerProfileId?: string; model?: string } } },
    );
    await waitFor(() => expect(getExperienceCopilotContext).toHaveBeenCalled());

    await act(async () => {
      await result.current.compact();
    });
    expect(compactExperienceCopilot).toHaveBeenCalledWith("t1", { providerProfileId: "p9", model: "m9" });

    // A later compact after the selection changed picks up the NEW pair (ref, not stale closure).
    rerender({ sel: { providerProfileId: "p10" } });
    await act(async () => {
      await result.current.compact();
    });
    expect(compactExperienceCopilot).toHaveBeenLastCalledWith("t1", { providerProfileId: "p10" });
  });

  it("compact propagates the error and clears the compacting flag", async () => {
    compactExperienceCopilot.mockImplementation(async () => {
      throw new Error("Nothing to compact");
    });

    const { result } = renderHook(() => useCopilotContext({ threadId: "t1" }));
    await waitFor(() => expect(getExperienceCopilotContext).toHaveBeenCalled());

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.compact();
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Nothing to compact");
    expect(result.current.isCompacting).toBe(false);
  });

  it("setAutoCompact PATCHes optimistically and reverts + rethrows on failure", async () => {
    const { result } = renderHook(() => useCopilotContext({ threadId: "t1", onCompacted: undefined }));
    await waitFor(() => expect(getExperienceCopilotContext).toHaveBeenCalled());

    // Success path.
    await act(async () => {
      await result.current.setAutoCompact(false);
    });
    expect(patchExperienceCopilotContext).toHaveBeenCalledWith("t1", { autoCompact: false });
    expect(result.current.autoCompact).toBe(false);

    // Failure path reverts + rethrows.
    patchExperienceCopilotContext.mockImplementation(async () => {
      throw new Error("boom");
    });
    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.setAutoCompact(true);
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(result.current.autoCompact).toBe(false);
  });
});
