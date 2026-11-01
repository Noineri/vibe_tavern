import { afterAll, beforeEach, expect, test } from "bun:test";
import { buildAgentReviewEnvelope, buildScriptAgentReviewEnvelope, type AgentReviewEnvelope, type AgentToolActivity } from "@vibe-tavern/api-contracts";
import { createBufferAgentReviewPersistence } from "./buffer-agent-review-persistence.js";
import { useAgentTurnStore } from "../stores/agent-turn-store.js";
import { useAgentReviewRoundStore } from "../stores/agent-review-store.js";
import { agentThreadKey } from "./agent-host-registry.js";

const originalFetch = globalThis.fetch;
const originalTurns = useAgentTurnStore.getState();
const originalRounds = useAgentReviewRoundStore.getState();
beforeEach(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  useAgentReviewRoundStore.setState(originalRounds, true);
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  useAgentReviewRoundStore.setState(originalRounds, true);
});

for (const kind of ["experience", "script"] as const) {
  for (const detached of [false, true]) {
    test(`${kind} ${detached ? "detached" : "completed"} replay never uploads a partial round or appends a checkpoint`, async () => {
      const id = `replay-${kind}-${detached}`;
      const activity: AgentToolActivity = { toolCallId: "write", toolName: "write_buffer", status: "done", target: kind === "script" ? "code" : "rules", proposed: "Producer proposal" };
      const envelope = kind === "script" ? buildScriptAgentReviewEnvelope(null, [activity], "Producer base")! : buildAgentReviewEnvelope(null, [activity], { rules: "Producer base", visual: "Visual" })!;
      let server: AgentReviewEnvelope | null = null;
      let running = true;
      const writes: string[] = [];
      const signal = new AbortController();
      globalThis.fetch = (async (input, init) => {
        const url = new URL(String(input), "http://gateway.test");
        if (init?.method === "PUT" || init?.method === "DELETE") writes.push(init.method);
        if (url.pathname.endsWith("/agent-runs")) return Response.json(running ? [{ threadId: id }] : []);
        if (url.pathname.endsWith("/review")) return Response.json(server);
        if (!url.pathname.endsWith("/run")) throw new Error(`Unexpected replay request: ${url.pathname}`);
        server = envelope;
        running = detached;
        if (detached) signal.abort();
        return new Response(`id: 1\nevent: tool-result\ndata: ${JSON.stringify({ toolCallId: "write", toolName: "write_buffer", output: { target: activity.target, proposed: "Partial browser projection", summary: "Partial" } })}\n\nid: 2\nevent: finish\ndata: {"finishReason":"stop"}\n\n`);
      }) as typeof fetch;
      const persistence = createBufferAgentReviewPersistence(kind);
      await persistence.runs.subscribe(id, 0, {
        signal: signal.signal, onStatus: () => {}, onChunk: () => {},
        onToolResult: () => useAgentTurnStore.getState().upsertActivity(kind, id, { ...activity, proposed: "Partial browser projection" }),
      }).catch((error: unknown) => { if (!signal.signal.aborted) throw error; });
      if (detached) {
        expect(writes).toEqual([]);
        running = false;
        await persistence.sync(id);
      }
      expect(useAgentTurnStore.getState().getActivities(kind, id)).toEqual(envelope.activities);
      expect(useAgentReviewRoundStore.getState().roundsByThread[agentThreadKey(kind, id)]).toEqual(envelope.round!);
      expect(writes).toEqual([]);
      expect(envelope.round!.snapshots).toHaveLength(1);
    });
  }
}
