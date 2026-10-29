/** BR-3a: actual controller, run client and SSE parser; the HTTP boundary
 * retains a numbered producer log independently of each view's reader. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import * as api from "../../../api/experience-copilot-api.js";
import { agentThreadRuns } from "../../../api/agent-run-api.js";
import type { AgentHostTransport } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { agentLiveReasoningOf, agentLiveTextOf, useAgentLiveStreamStore } from "../../../stores/agent-live-stream-store.js";
import { AgentReviewPersistence } from "../../../lib/agent-review-persistence.js";
import { useAgentController, type AgentController } from "./use-agent-controller.js";

useDomEnv();
const { act, renderHook, waitFor } = await import("@testing-library/react");
const originalFetch = globalThis.fetch;
const originalTurns = useAgentTurnStore.getState();
// LAG-3: the live turn text lives in its own per-thread store, not the hook.
const originalLive = useAgentLiveStreamStore.getState();
const liveText = (kind: string, id: string) => agentLiveTextOf(useAgentLiveStreamStore.getState(), kind, id);
const liveReasoning = (kind: string, id: string) => agentLiveReasoningOf(useAgentLiveStreamStore.getState(), kind, id);
type Run = { active: boolean; frames: string[]; readers: Set<ReadableStreamDefaultController<Uint8Array>> };
let runs: Map<string, Run>;
let requests: Array<{ method: string; path: string; body?: unknown }>;
let afterDiscovery: (() => void) | undefined;
let discoveryGate: Promise<void> | undefined;
const encoder = new TextEncoder();
function run(id: string) {
  const state: Run = { active: true, frames: [], readers: new Set() };
  runs.set(id, state);
  return state;
}
function emit(id: string, event: string, data: unknown) {
  const state = runs.get(id)!;
  const frame = `id: ${state.frames.length + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  state.frames.push(frame);
  for (const reader of state.readers) reader.enqueue(encoder.encode(frame));
  if (["finish", "error", "abort"].includes(event)) {
    state.active = false;
    for (const reader of state.readers) reader.close();
    state.readers.clear();
  }
}
function response(state: Run, after: number) {
  let reader: ReadableStreamDefaultController<Uint8Array>;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      reader = controller;
      for (const frame of state.frames.slice(after)) controller.enqueue(encoder.encode(frame));
      if (state.active) state.readers.add(controller);
      else controller.close();
    },
    cancel() { state.readers.delete(reader); },
  }), { headers: { "content-type": "text/event-stream" } });
}
beforeEach(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  useAgentLiveStreamStore.setState(originalLive, true);
  runs = new Map(); requests = []; afterDiscovery = undefined; discoveryGate = undefined;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://gateway.test");
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.pathname.endsWith("/agent-runs")) {
      await discoveryGate;
      const active = [...runs].filter(([, state]) => state.active).map(([threadId]) => ({ threadId }));
      afterDiscovery?.(); afterDiscovery = undefined;
      return Response.json(active);
    }
    const [, id, action] = url.pathname.match(/\/experience-copilot\/([^/]+)\/(stream|run|stop)$/) ?? [];
    if (!id) throw new Error(`Unhandled request: ${url.pathname}`);
    if (action === "stream") {
      if (runs.get(id)?.active) return Response.json({ error: { code: "AGENT_RUN_ACTIVE", message: "Already running" } }, { status: 409 });
      return response(run(id), 0);
    }
    if (action === "stop") {
      emit(id, "abort", {});
      return Response.json({ stopped: true });
    }
    return response(runs.get(id)!, Number(url.searchParams.get("after")));
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  useAgentLiveStreamStore.setState(originalLive, true);
});
const transport: AgentHostTransport = {
  runs: agentThreadRuns, sendStream: api.streamExperienceCopilot, answerAsk: api.answerCopilotAsk,
  deleteTurn: api.deleteCopilotTurn, editMessage: api.editCopilotMessage,
  getActiveThread: () => api.getExperienceCopilotActive("script"),
  startSession: () => api.startExperienceCopilotSession("script"),
  listSessions: () => api.listExperienceCopilotSessions("script"),
  listMessages: api.listExperienceCopilotMessages, activateSession: api.activateExperienceCopilotSession,
  renameSession: api.renameExperienceCopilotSession, setContextLinks: api.setExperienceCopilotContextLinks,
};
const stopRequests = () => requests.filter((request) => request.path.endsWith("/stop"));
const streamRequests = () => requests.filter((request) => request.path.endsWith("/stream"));

for (const kind of ["experience", "script", "sidechat-ooc"]) {
  test(`${kind}: unmount detaches, remount rebuilds once from replay, explicit stop POSTs`, async () => {
    const id = `thread-${kind}`;
    const outcomes: boolean[] = [];
    const hook = () => useAgentController({ kind, threadId: id, providerProfileId: "provider", transport, onTurnSettled: (ok) => outcomes.push(ok) });
    const first = renderHook(hook);
    let sending: Promise<void> | undefined;
    let second: ReturnType<typeof renderHook<AgentController, unknown>> | undefined;
    try {
      await waitFor(() => expect(first.result.current.isSending).toBe(false));
      await act(() => { sending = first.result.current.handleSend("Revise"); });
      await act(() => {
        emit(id, "text-delta", { delta: "Before " });
        emit(id, "reasoning-delta", { delta: "Thinking" });
        emit(id, "tool-call", { toolCallId: "write", toolName: "write_buffer", args: { target: kind === "script" ? "code" : "rules", content: "Proposal" } });
      });
      await waitFor(() => expect(liveText(kind, id)).toBe("Before "));
      first.unmount();
      await act(async () => { await sending; });
      expect(runs.get(id)!.active).toBe(true);
      expect(stopRequests()).toEqual([]);
      expect(outcomes).toEqual([]);
      emit(id, "text-delta", { delta: "After" });
      second = renderHook(hook);
      await waitFor(() => expect(liveText(kind, id)).toBe("Before After"));
      expect(liveReasoning(kind, id)).toBe("Thinking");
      expect(second.result.current.isSending).toBe(true);
      expect(useAgentTurnStore.getState().getActivities(kind, id)).toHaveLength(1);
      expect(streamRequests()).toHaveLength(1);
      await act(async () => { await second!.result.current.handleSend("Duplicate"); });
      expect(streamRequests()).toHaveLength(1);
      await act(() => { second!.result.current.handleCancel(); });
      await waitFor(() => expect(second!.result.current.isSending).toBe(false));
      expect(stopRequests().map(({ method }) => method)).toEqual(["POST"]);
      expect(outcomes).toEqual([false]);
      expect(second.result.current.turnFailure).toBeNull();
    } finally {
      first.unmount(); second?.unmount();
      if (runs.get(id)?.active) emit(id, "finish", { finishReason: "stop" });
      await sending;
    }
  });
}

test("host switch isolates late events and settles only the displayed thread", async () => {
  run("old"); run("new");
  emit("old", "text-delta", { delta: "Old" });
  emit("new", "text-delta", { delta: "New" });
  const settled: string[] = [];
  const h = renderHook(({ id }) => useAgentController({
    kind: "sidechat-ooc", threadId: id, providerProfileId: "provider", transport,
    onTurnSettled: () => settled.push(id),
  }), { initialProps: { id: "old" } });
  try {
    await waitFor(() => expect(liveText("sidechat-ooc", "old")).toBe("Old"));
    h.rerender({ id: "new" });
    await waitFor(() => expect(liveText("sidechat-ooc", "new")).toBe("New"));
    await act(() => {
      emit("old", "text-delta", { delta: " late" }); emit("old", "finish", { finishReason: "stop" });
    });
    expect(liveText("sidechat-ooc", "new")).toBe("New");
    expect(h.result.current.isSending).toBe(true);
    expect(settled).toEqual([]);
    await act(() => { emit("new", "finish", { finishReason: "stop" }); });
    await waitFor(() => expect(h.result.current.isSending).toBe(false));
    expect(settled).toEqual(["new"]);
    expect(stopRequests()).toEqual([]);
  } finally { h.unmount(); }
});

for (const preflight of [false, true]) {
for (const action of ["send", "ask", "permission", "regenerate"] as const) {
  test(`${action}: ${preflight ? "review preflight" : "409"} follows the winning run without failure or another preparation`, async () => {
    let prepared = 0;
    const outcomes: boolean[] = [];
    const persistence = new AgentReviewPersistence({
      api: { isRunning: agentThreadRuns.isRunning, get: async () => null, put: async (_id, value) => value, delete: async () => {} },
      read: () => null, apply: () => {}, readLegacy: () => null, removeLegacy: () => {},
    });
    // Another client wins immediately after this client's idle discovery.
    afterDiscovery = () => { run("thread"); emit("thread", "text-delta", { delta: "Winner" }); };
    const h = renderHook(() => useAgentController({
      kind: "sidechat-ooc", threadId: "thread", providerProfileId: "provider", transport,
      prepareTurn: (id, signal) => { prepared++; return preflight ? persistence.prepare(id, signal) : undefined; },
      onTurnSettled: (ok) => outcomes.push(ok),
      threadMessages: [{ id: "prior", role: "assistant", content: "Previous reply", threadId: "thread", createdAt: "2026-10-29T00:00:00.000Z", toolCallsJson: null, toolCallId: null, reasoning: null, reasoningDurationMs: null }],
    }));
    let pending: Promise<void> | undefined;
    try {
      await waitFor(() => expect(h.result.current.isSending).toBe(false));
      await act(() => {
        pending = action === "send" ? h.result.current.handleSend("Refused")
          : action === "ask" ? h.result.current.handleAnswer("ask", { text: "Yes" })
          : action === "permission" ? h.result.current.handleAnswer("permission", { decision: "allow" })
          : h.result.current.handleRegenerate();
      });
      await waitFor(() => expect(liveText("sidechat-ooc", "thread")).toBe("Winner"));
      expect(h.result.current.pendingUserContent).toBe("");
      expect(h.result.current.pendingAskAnswer).toBeNull();
      expect(h.result.current.pendingPermissionAnswer).toBeNull();
      expect(h.result.current.turnFailure).toBeNull();
      expect(prepared).toBe(1);
      expect(streamRequests()).toHaveLength(preflight ? 0 : 1);
      if (action === "regenerate") expect(h.result.current.hiddenRegeneratedIds).toBeNull();
      await act(async () => { emit("thread", "finish", { finishReason: "stop" }); await pending; });
      expect(outcomes).toEqual([true]);
    } finally {
      h.unmount();
      if (runs.get("thread")?.active) emit("thread", "finish", { finishReason: "stop" });
      await pending;
    }
  });
}
}

test("an existing run that finishes between discovery and GET remains replayable", async () => {
  run("thread"); emit("thread", "text-delta", { delta: "Completed" });
  afterDiscovery = () => { emit("thread", "finish", { finishReason: "stop" }); };
  const outcomes: boolean[] = [];
  const h = renderHook(() => useAgentController({
    kind: "sidechat-ooc", threadId: "thread", providerProfileId: null, transport,
    onTurnSettled: (ok) => outcomes.push(ok),
  }));
  try {
    await waitFor(() => expect(outcomes).toEqual([true]));
    expect(h.result.current.isSending).toBe(false);
    expect(streamRequests()).toEqual([]);
  } finally { h.unmount(); }
});

test("idle discovery creates no false generating edge and an early send waits rather than being dropped", async () => {
  let discover!: () => void;
  discoveryGate = new Promise<void>((resolve) => { discover = resolve; });
  const h = renderHook(() => useAgentController({ kind: "script", threadId: "thread", providerProfileId: "provider", transport }));
  let pending: Promise<void> | undefined;
  try {
    expect(h.result.current.isSending).toBe(false);
    await act(() => { pending = h.result.current.handleSend("Early send"); });
    expect(streamRequests()).toEqual([]);
    await act(() => { discover(); });
    await waitFor(() => expect(streamRequests()).toHaveLength(1));
    expect(h.result.current.isSending).toBe(true);
    await act(async () => { emit("thread", "finish", { finishReason: "stop" }); await pending; });
    expect(h.result.current.isSending).toBe(false);
  } finally {
    discover(); h.unmount();
    if (runs.get("thread")?.active) emit("thread", "finish", { finishReason: "stop" });
    await pending;
  }
});

test("a reattached provider error keeps the same category and failed outcome without a stop", async () => {
  run("thread");
  const outcomes: boolean[] = [];
  const h = renderHook(() => useAgentController({
    kind: "sidechat-ooc", threadId: "thread", providerProfileId: null, transport,
    onTurnSettled: (ok) => outcomes.push(ok),
  }));
  try {
    await waitFor(() => expect(h.result.current.isSending).toBe(true));
    await act(() => { emit("thread", "error", { message: "Provider refused", category: "authentication" }); });
    await waitFor(() => expect(outcomes).toEqual([false]));
    expect(h.result.current.turnFailure).toEqual({ category: "authentication" });
    expect(h.result.current.isSending).toBe(false);
    expect(stopRequests()).toEqual([]);
  } finally { h.unmount(); }
});
