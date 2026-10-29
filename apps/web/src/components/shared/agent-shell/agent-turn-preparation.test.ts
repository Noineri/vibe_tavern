/** BR-2c1: real controller + RPC/SSE parser, parked host preparation at DI. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import * as api from "../../../api/experience-copilot-api.js";
import type { AgentHostTransport } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentController, type AgentController } from "./use-agent-controller.js";

useDomEnv();
const { act, renderHook } = await import("@testing-library/react");
const originalFetch = globalThis.fetch;
const originalTurns = useAgentTurnStore.getState();
let requests: Array<{ threadId: string; body: unknown }> = [];
beforeEach(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  requests = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ threadId: String(input).split("/").at(-2)!, body: JSON.parse(String(init?.body)) });
    return new Response('event: finish\ndata: {"finishReason":"stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
});
const transport: AgentHostTransport = {
  sendStream: api.streamExperienceCopilot, answerAsk: api.answerCopilotAsk,
  deleteTurn: api.deleteCopilotTurn, editMessage: api.editCopilotMessage,
  getActiveThread: (owner) => api.getExperienceCopilotActive(owner.kind === "script" ? owner.scriptId : "unused"),
  startSession: (owner) => api.startExperienceCopilotSession(owner.kind === "script" ? owner.scriptId : "unused"),
  listSessions: (owner) => api.listExperienceCopilotSessions(owner.kind === "script" ? owner.scriptId : "unused"),
  listMessages: api.listExperienceCopilotMessages, activateSession: api.activateExperienceCopilotSession,
  renameSession: api.renameExperienceCopilotSession, setContextLinks: api.setExperienceCopilotContextLinks,
};
function parked() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const actions = {
  send: (ctrl: AgentController) => ctrl.handleSend("Revise"),
  ask: (ctrl: AgentController) => ctrl.handleAnswer("ask", { text: "Yes" }),
  permission: (ctrl: AgentController) => ctrl.handleAnswer("permission", { decision: "allow" }),
  regenerate: (ctrl: AgentController) => ctrl.handleRegenerate(),
};
const prior = { toolCallId: "prior", toolName: "write_buffer", status: "done" as const, target: "rules" as const, proposed: "Pending" };

for (const [name, dispatch] of Object.entries(actions)) {
  test(`${name} waits before clearing or POSTing and refuses a duplicate during preparation`, async () => {
    const gate = parked();
    let preparations = 0;
    useAgentTurnStore.getState().upsertActivity("experience", "thread", prior);
    const h = renderHook(() => useAgentController({
      kind: "experience", threadId: "thread", providerProfileId: "provider", transport,
      prepareTurn: async (id, signal) => {
        expect(id).toBe("thread");
        expect(signal.aborted).toBe(false);
        preparations++;
        await gate.promise;
      },
    }));
    let pending!: Promise<void>;
    try {
      await act(() => { pending = dispatch(h.result.current); });
      await act(async () => { await actions.send(h.result.current); });
      expect(preparations).toBe(1);
      expect(requests).toHaveLength(0);
      expect(useAgentTurnStore.getState().getActivities("experience", "thread")).toEqual([prior]);
      await act(async () => { gate.resolve(); await pending; });
      expect(requests).toHaveLength(1);
      expect(useAgentTurnStore.getState().getActivities("experience", "thread")).toEqual([]);
      expect(h.result.current.isSending).toBe(false);
    } finally {
      await act(async () => { gate.resolve(); await pending; });
      h.unmount();
    }
  });
}

for (const mode of ["cancel", "failure", "switch", "unmount"] as const) {
  test(`preparation ${mode} leaves the review intact and never opens a stream`, async () => {
    const gate = parked();
    const outcomes: boolean[] = [];
    useAgentTurnStore.getState().upsertActivity("experience", "thread", prior);
    const h = renderHook(({ threadId }) => useAgentController({
      kind: "experience", threadId, providerProfileId: "provider", transport,
      prepareTurn: () => gate.promise, onTurnSettled: (ok) => outcomes.push(ok),
    }), { initialProps: { threadId: "thread" } });
    let pending!: Promise<void>;
    try {
      await act(() => { pending = h.result.current.handleSend("Revise"); });
      await act(async () => {
        if (mode === "cancel") h.result.current.handleCancel();
        if (mode === "switch") h.rerender({ threadId: "other" });
        if (mode === "unmount") h.unmount();
      });
      await act(async () => {
        if (mode === "failure") gate.reject(new Error("Review save failed"));
        else gate.resolve();
        await pending;
      });
      expect(requests).toHaveLength(0);
      expect(outcomes).toEqual([false]);
      expect(useAgentTurnStore.getState().getActivities("experience", "thread")).toEqual([prior]);
      expect(h.result.current.isSending).toBe(false);
    } finally {
      await act(async () => { gate.resolve(); await pending; });
      h.unmount();
    }
  });
}
