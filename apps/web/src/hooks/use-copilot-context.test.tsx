/**
 * useCopilotContext tests (CM-8) — pins the per-thread context state contract:
 * fetch on mount + thread switch (reset first), live `applyMetrics`, compact
 * flow (POST → metrics + onCompacted, error propagates, re-entrancy guard), and
 * the auto-compact toggle (optimistic PATCH, revert + rethrow on failure).
 *
 * The API boundary is mocked at the FETCH level (the same `fetchRouter`
 * pattern as ExperienceCopilotShell.test.tsx), NOT via `mock.module`: module
 * mocks are process-global in bun:test and poisoned the Shell test's own
 * fetch-router in a shared-process combined run (the last known interference
 * in the copilot catalog). With the real RPC wrappers running against a
 * mocked fetch, this file is safe to combine with any other copilot test file
 * in one `bun test` process.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

// RTL dynamic + below useDomEnv() (the dom-env contract — a static import can
// evaluate before the window registers and then poisons fireEvent-driven
// files later in a shared-process combined run).
const { renderHook, act, waitFor } = await import("@testing-library/react");

const { useCopilotContext } = await import("./use-copilot-context.js");

function metrics(total: number): ExperienceCopilotContextMetrics {
  return {
    systemTokens: 100,
    digestTokens: 100,
    historyTokens: 200,
    attachedTokens: 0,
    totalTokens: total,
    budgetTokens: 10000,
    reserveTokens: 1000,
    source: "estimate",
    measuredAt: "2026-08-15T00:00:00.000Z",
  };
}

type ContextState = { metrics: ExperienceCopilotContextMetrics | null; autoCompact: boolean };

/** Mutable router state, reset between tests. */
const router = {
  contextFor: (_threadId: string): ContextState => ({ metrics: null, autoCompact: true }),
  compactError: null as { status: number; message: string } | null,
  patchError: null as { status: number; message: string } | null,
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function errorResponse(error: { status: number; message: string }): Response {
  return new Response(JSON.stringify({ error: { message: error.message } }), {
    status: error.status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeDigest(threadId: string) {
  return { id: "d1", threadId, role: "digest", content: "summary", toolCallsJson: null, toolCallId: "u3", createdAt: "" };
}

const fetchRouter = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const contextMatch = path.match(/\/api\/experience-copilot\/([^/]+)\/context$/);
  if (contextMatch) {
    const threadId = contextMatch[1]!;
    if (method === "GET") return jsonResponse(router.contextFor(threadId));
    if (method === "PATCH") {
      if (router.patchError) return errorResponse(router.patchError);
      const body = JSON.parse(String(init?.body ?? "{}")) as { autoCompact?: boolean };
      return jsonResponse({ metrics: null, autoCompact: body.autoCompact ?? true });
    }
  }
  if (method === "POST" && /\/api\/experience-copilot\/([^/]+)\/compact$/.test(path)) {
    if (router.compactError) return errorResponse(router.compactError);
    const threadId = path.match(/\/api\/experience-copilot\/([^/]+)\/compact$/)?.[1] ?? "";
    return jsonResponse({ digest: makeDigest(threadId), metrics: metrics(500) });
  }
  return errorResponse({ status: 404, message: `unrouted ${method} ${path}` });
});

globalThis.fetch = fetchRouter as unknown as typeof fetch;

/** Router calls matching method + path pattern. */
function apiCalls(method: "GET" | "PATCH" | "POST", pattern: RegExp) {
  return fetchRouter.mock.calls.filter(([input, init]) => {
    const m = (init?.method ?? "GET").toUpperCase();
    const path = new URL(String(input), "http://gateway.test").pathname;
    return m === method && pattern.test(path);
  });
}

/** Parsed JSON body of one router call. */
function bodyOf(call: (typeof fetchRouter.mock.calls)[number]): unknown {
  const [, init] = call;
  return JSON.parse(String(init?.body ?? "{}"));
}

beforeEach(() => {
  fetchRouter.mockClear();
  router.contextFor = () => ({ metrics: null, autoCompact: true });
  router.compactError = null;
  router.patchError = null;
});

describe("useCopilotContext", () => {
  it("fetches context on mount and exposes the resolved state", async () => {
    router.contextFor = () => ({ metrics: metrics(1234), autoCompact: false });

    const { result } = renderHook(() => useCopilotContext({ threadId: "t1" }));

    await waitFor(() => expect(result.current.metrics).toEqual(metrics(1234)));
    expect(apiCalls("GET", /\/api\/experience-copilot\/t1\/context$/)).toHaveLength(1);
    expect(result.current.autoCompact).toBe(false);
  });

  it("resets state and refetches on thread switch", async () => {
    router.contextFor = (t) =>
      t === "t1" ? { metrics: metrics(111), autoCompact: false } : { metrics: metrics(222), autoCompact: true };

    const { result, rerender } = renderHook(
      ({ threadId }) => useCopilotContext({ threadId }),
      { initialProps: { threadId: "t1" } },
    );

    await waitFor(() => expect(result.current.metrics).toEqual(metrics(111)));

    rerender({ threadId: "t2" });
    await waitFor(() => expect(result.current.metrics).toEqual(metrics(222)));
    expect(result.current.autoCompact).toBe(true);
    expect(apiCalls("GET", /\/api\/experience-copilot\/t2\/context$/)).toHaveLength(1);
  });

  it("applyMetrics overwrites the metrics in place (live SSE feed)", async () => {
    const { result } = renderHook(() => useCopilotContext({ threadId: "t1" }));
    await waitFor(() => expect(apiCalls("GET", /\/context$/)).toHaveLength(1));

    act(() => result.current.applyMetrics(metrics(9999)));
    expect(result.current.metrics).toEqual(metrics(9999));
  });

  it("compact POSTs, bumps metrics, and calls onCompacted", async () => {
    const onCompacted = mock();
    const { result } = renderHook(() => useCopilotContext({ threadId: "t1", onCompacted }));
    await waitFor(() => expect(apiCalls("GET", /\/context$/)).toHaveLength(1));

    await act(async () => {
      await result.current.compact();
    });

    const posts = apiCalls("POST", /\/api\/experience-copilot\/t1\/compact$/);
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({});
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
    await waitFor(() => expect(apiCalls("GET", /\/context$/)).toHaveLength(1));

    await act(async () => {
      await result.current.compact();
    });
    let posts = apiCalls("POST", /\/api\/experience-copilot\/t1\/compact$/);
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({ providerProfileId: "p9", model: "m9" });

    // A later compact after the selection changed picks up the NEW pair (ref, not stale closure).
    rerender({ sel: { providerProfileId: "p10" } });
    await act(async () => {
      await result.current.compact();
    });
    posts = apiCalls("POST", /\/api\/experience-copilot\/t1\/compact$/);
    expect(posts).toHaveLength(2);
    expect(bodyOf(posts[1]!)).toEqual({ providerProfileId: "p10" });
  });

  it("compact propagates the error and clears the compacting flag", async () => {
    router.compactError = { status: 400, message: "Nothing to compact" };

    const { result } = renderHook(() => useCopilotContext({ threadId: "t1" }));
    await waitFor(() => expect(apiCalls("GET", /\/context$/)).toHaveLength(1));

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
    await waitFor(() => expect(apiCalls("GET", /\/context$/)).toHaveLength(1));

    // Success path.
    await act(async () => {
      await result.current.setAutoCompact(false);
    });
    const patches = apiCalls("PATCH", /\/api\/experience-copilot\/t1\/context$/);
    expect(patches).toHaveLength(1);
    expect(bodyOf(patches[0]!)).toEqual({ autoCompact: false });
    expect(result.current.autoCompact).toBe(false);

    // Failure path reverts + rethrows.
    router.patchError = { status: 500, message: "boom" };
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
