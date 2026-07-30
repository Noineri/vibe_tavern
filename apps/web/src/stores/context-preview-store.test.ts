/**
 * Context-preview cache store.
 *
 * Pins the branch-scoped cache that replaced the `contextPreview` field on the
 * snapshot store: fetch + dedup, per-chat / per-entry invalidation, and the
 * request-generation guard that rejects a late/aborted result so a slow
 * assembly can never overwrite a newer branch's value. The cache key is
 * `${chatId}::${branchId}` — switching branches changes the key, which is what
 * keeps fork/activate/delete correct without explicit invalidation.
 *
 * `fetchContextPreview` (the network call) is mocked via the spread-real-then-
 * override pattern so the rest of chat-api stays genuine.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";

type FetchImpl = (chatId: string, branchId: string, signal?: AbortSignal) => Promise<{ target: { chatId: string; branchId: string }; preview: AssemblePromptResponse | null }>;
let mockFetch: FetchImpl | null = null;
const realChatApi = await import("../api/chat-api.js");
mock.module("../api/chat-api.js", () => {
	return {
		...realChatApi,
		fetchContextPreview: ((chatId: string, branchId: string, signal?: AbortSignal) =>
			mockFetch ? mockFetch(chatId, branchId, signal) : realChatApi.fetchContextPreview(chatId as never, branchId as never, signal)) as FetchImpl,
	};
});
const { useContextPreviewStore } = await import("./context-preview-store.js");

function makePreview(total: number): AssemblePromptResponse {
  return { layers: [], tokenAccounting: { total } } as unknown as AssemblePromptResponse;
}
function resp(branchId: string, preview: AssemblePromptResponse | null) {
  return { target: { chatId: "chat-1", branchId }, preview };
}

const entry = (branchId: string) =>
  useContextPreviewStore.getState().entries[`chat-1::${branchId}`];

describe("context-preview cache — fetch + dedup", () => {
  beforeEach(() => {
    useContextPreviewStore.setState({ entries: {} });
    mockFetch = null;
  });

  test("fetch transitions idle → loading → success and stores the branch-scoped preview", async () => {
    const p = makePreview(42);
    mockFetch = async (_c, branchId) => resp(branchId, p);

    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    expect(entry("brA")?.status).toBe("success");
    expect(entry("brA")?.preview).toBe(p);
  });

  test("fetch is a no-op once an entry is already success (dedup)", async () => {
    let calls = 0;
    mockFetch = async (_c, branchId) => { calls++; return resp(branchId, makePreview(1)); };

    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    await useContextPreviewStore.getState().fetch("chat-1", "brA"); // skipped
    expect(calls).toBe(1);
  });

  test("concurrent identical calls issue ONE network request (in-flight dedup)", async () => {
    let calls = 0;
    mockFetch = async (_c, branchId) => { calls++; return resp(branchId, makePreview(1)); };

    // Do NOT await the first before issuing the second — both see the loading
    // entry the first created, so only the first actually fetches.
    const a = useContextPreviewStore.getState().fetch("chat-1", "brA");
    const b = useContextPreviewStore.getState().fetch("chat-1", "brA");
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });

  test("fetch records the error message on failure and allows a retry", async () => {
    mockFetch = async () => { throw new Error("network down"); };
    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    expect(entry("brA")?.status).toBe("error");
    expect(entry("brA")?.error).toBe("network down");

    let calls = 0;
    mockFetch = async (_c, branchId) => { calls++; return resp(branchId, makePreview(1)); };
    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    expect(calls).toBe(1); // retried after the error
  });
});

describe("context-preview cache — invalidation", () => {
  beforeEach(() => {
    useContextPreviewStore.setState({ entries: {} });
    mockFetch = null;
  });

  test("invalidateEntry drops one branch's entry, forcing a refetch", async () => {
    let calls = 0;
    mockFetch = async (_c, branchId) => { calls++; return resp(branchId, makePreview(1)); };
    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    expect(calls).toBe(1);

    useContextPreviewStore.getState().invalidateEntry("chat-1", "brA");
    expect(entry("brA")).toBeUndefined();

    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    expect(calls).toBe(2); // refetched after invalidation
  });

  test("invalidateChat drops every branch entry for that chat, leaving other chats alone", async () => {
    mockFetch = async (_c, branchId) => resp(branchId, makePreview(1));
    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    await useContextPreviewStore.getState().fetch("chat-2", "brX");

    useContextPreviewStore.getState().invalidateChat("chat-1");
    expect(entry("brA")).toBeUndefined();
    expect(useContextPreviewStore.getState().entries[`chat-2::brX`]).toBeDefined();
  });
});

describe("context-preview cache — stale / aborted result rejection", () => {
  beforeEach(() => {
    useContextPreviewStore.setState({ entries: {} });
    mockFetch = null;
  });

  test("a superseded request's late result is NOT written (generation guard)", async () => {
    // First fetch resolves slowly; before it resolves, the entry is invalidated
    // and a second fetch takes over. The first request's controller is aborted
    // and its generation is stale, so when it finally resolves it must NOT
    // overwrite the second fetch's preview.
    const previewFast = makePreview(2);
    let resolveSlow: (v: { target: { chatId: string; branchId: string }; preview: AssemblePromptResponse | null }) => void = () => {};
    const slowPromise = new Promise<{ target: { chatId: string; branchId: string }; preview: AssemblePromptResponse | null }>((r) => { resolveSlow = r; });
    let calls = 0;
    mockFetch = async (_c, branchId) => {
      calls++;
      return calls === 1 ? slowPromise : resp(branchId, previewFast);
    };

    const first = useContextPreviewStore.getState().fetch("chat-1", "brA"); // loading, pending
    expect(entry("brA")?.status).toBe("loading");

    // Invalidate (drops the entry) then refetch — the second fetch aborts the
    // first's controller and bumps the generation.
    useContextPreviewStore.getState().invalidateEntry("chat-1", "brA");
    await useContextPreviewStore.getState().fetch("chat-1", "brA");
    expect(entry("brA")?.preview).toBe(previewFast);

    // Now release the slow request — it must be rejected as aborted/stale.
    resolveSlow(resp("brA", makePreview(999)));
    await first; // let the aborted branch settle
    expect(entry("brA")?.preview).toBe(previewFast); // NOT overwritten by 999
  });
});
