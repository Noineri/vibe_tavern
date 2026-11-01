/** BR-2d3: real web stores, RPC and SSE parser against a deterministic fetch
 * boundary. No draft/save/trust store is written by review persistence. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { buildScriptAgentReviewEnvelope, experienceCopilotToolOutputSchema, type AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import { useAgentTurnStore } from "../stores/agent-turn-store.js";
import { useAgentReviewRoundStore, EMPTY_REVIEW_ROUND } from "../stores/agent-review-store.js";
import { prepareScriptAgentReviewTurn, rehydrateScriptAgentDraft, streamPersistedScriptAgent, syncPersistedScriptAgentRound } from "./script-agent-draft.js";
import { serializeBufferAgentReview } from "./buffer-agent-review-persistence.js";

const originalFetch = globalThis.fetch;
const originalTurns = useAgentTurnStore.getState();
const originalRounds = useAgentReviewRoundStore.getState();
let reviews: Map<string, AgentReviewEnvelope>;
let streamEvents: string[];
let onPost: ((id: string) => void) | undefined;
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
beforeEach(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  useAgentReviewRoundStore.setState(originalRounds, true);
  reviews = new Map();
  streamEvents = [event("finish", { finishReason: "stop" })];
  onPost = undefined;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), "http://gateway.test").pathname;
    if (path.endsWith("/api/agent-runs")) return Response.json([]);
    const id = path.match(/\/experience-copilot\/([^/]+)\/(review|stream)$/)?.[1];
    if (!id) throw new Error(`Unexpected script review request: ${path}`);
    if (path.endsWith("/stream")) {
      onPost?.(id);
      return new Response(streamEvents.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (init?.method === "PUT") reviews.set(id, JSON.parse(String(init.body)));
    if (init?.method === "DELETE") { reviews.delete(id); return Response.json({ ok: true }); }
    return Response.json(reviews.get(id) ?? null);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  useAgentReviewRoundStore.setState(originalRounds, true);
});
const proposal = { toolCallId: "code", toolName: "write_buffer", status: "done" as const, target: "code" as const, proposed: "New code" };
function seed(id: string) {
  const envelope = buildScriptAgentReviewEnvelope(null, [proposal], "Old code")!;
  reviews.set(id, envelope);
  return envelope;
}
const callbacks = (id: string) => ({
  onStatus: () => {}, onChunk: () => {},
  onToolCall: (info: { toolCallId: string; toolName: string; args: unknown }) => useAgentTurnStore.getState().upsertActivity("script", id, { ...info, status: "streaming" }),
  onToolResult: (info: { toolCallId: string; toolName: string; output: unknown; isError: boolean }) => {
    const output = experienceCopilotToolOutputSchema.parse(info.output);
    useAgentTurnStore.getState().upsertActivity("script", id, { toolCallId: info.toolCallId, toolName: info.toolName, status: info.isError ? "error" : "done", ...output });
  },
});

test("server reload recovers code and hunk progress without touching the experience namespace", async () => {
  const id = "script-reload";
  const envelope = seed(id);
  envelope.round!.acceptedRules = [0];
  envelope.round!.dismissedRules = [1];
  useAgentTurnStore.setState({ turnsByThread: { [id]: [{ ...proposal, target: "rules", proposed: "Experience" }] } });
  useAgentReviewRoundStore.setState({ roundsByThread: { [id]: { ...EMPTY_REVIEW_ROUND, rulesKey: "Experience" } } });
  await rehydrateScriptAgentDraft(id);
  expect(useAgentTurnStore.getState().getActivities("script", id)).toEqual(envelope.activities);
  expect(useAgentReviewRoundStore.getState().roundsByThread[`script:${id}`]).toEqual(envelope.round!);
  expect(useAgentTurnStore.getState().getActivities("experience", id)[0]!.proposed).toBe("Experience");
  expect(useAgentReviewRoundStore.getState().roundsByThread[id]!.rulesKey).toBe("Experience");
  useAgentTurnStore.setState({ turnsByThread: {} });
  useAgentReviewRoundStore.setState({ roundsByThread: {} });
  await rehydrateScriptAgentDraft(id);
  expect(useAgentReviewRoundStore.getState().roundsByThread[`script:${id}`]).toEqual(envelope.round!);
});

test("code and empty-code serialize natively while the experience serializer still excludes them", () => {
  expect(JSON.parse(serializeBufferAgentReview([{ ...proposal, proposed: "" }], EMPTY_REVIEW_ROUND, "script")!).activities[0].proposed).toBe("");
  expect(serializeBufferAgentReview([proposal], EMPTY_REVIEW_ROUND, "experience")).toBeNull();
});

test("prepare flushes progress before POST and a no-proposal follow-up keeps the original dangling anchor", async () => {
  const id = "script-followup";
  seed(id);
  await rehydrateScriptAgentDraft(id);
  useAgentReviewRoundStore.getState().setAcceptedHunks("script", id, "rules", [0]);
  const signal = new AbortController().signal;
  await prepareScriptAgentReviewTurn(id, signal, "Hybrid code");
  expect(reviews.get(id)!.round!.snapshots).toHaveLength(1);
  onPost = () => {
    expect(reviews.get(id)!.round!.acceptedRules).toEqual([0]);
    expect(reviews.get(id)!.round!.snapshots).toHaveLength(1);
    expect(useAgentReviewRoundStore.getState().roundsByThread[`script:${id}`]!.snapshots).toHaveLength(2);
  };
  useAgentTurnStore.getState().clearTurn("script", id);
  await streamPersistedScriptAgent(id, { content: "Explain", providerProfileId: "provider", code: "Hybrid code" }, { signal, ...callbacks(id) });
  expect(reviews.get(id)!.activities).toEqual([]);
  expect(reviews.get(id)!.round!.snapshots).toHaveLength(2);
  expect(reviews.get(id)!.round!.dangling).toEqual({ rules: "New code", baseRules: "Old code", baseVisual: "" });
  expect(reviews.get(id)!.round!.acceptedRules).toEqual([0]);
});

for (const proposed of ["Next code", ""]) {
  test(`live code result ${JSON.stringify(proposed)} persists with exactly one checkpoint through the real SSE parser`, async () => {
    const id = proposed ? "script-live-code" : "script-empty-code";
    await rehydrateScriptAgentDraft(id);
    await prepareScriptAgentReviewTurn(id, new AbortController().signal, "Old code");
    useAgentTurnStore.getState().clearTurn("script", id);
    streamEvents = [event("tool-call", { toolCallId: "write", toolName: "write_buffer", args: { target: "code", content: proposed } }), event("tool-result", { toolCallId: "write", toolName: "write_buffer", output: { target: "code", proposed, summary: "Updated" }, isError: false }), event("finish", { finishReason: "stop" })];
    await streamPersistedScriptAgent(id, { content: "Revise", providerProfileId: "provider", code: "Old code" }, callbacks(id));
    expect(reviews.get(id)!.activities[0]).toMatchObject({ target: "code", proposed, args: { target: "code", content: proposed } });
    expect(reviews.get(id)!.round!.snapshots).toEqual([{ id: 1, rules: "Old code", visual: "" }]);
    expect(reviews.get(id)!.round!.rulesKey).toBe(`Old code\0${proposed}`);
  });
}

test("clearing the script review deletes its server row without clearing another thread", async () => {
  const id = "script-clear";
  seed(id);
  const other = seed("other-script");
  await rehydrateScriptAgentDraft(id);
  useAgentTurnStore.getState().clearTurn("script", id);
  useAgentReviewRoundStore.getState().resetRound("script", id);
  await syncPersistedScriptAgentRound(id);
  expect(reviews.has(id)).toBe(false);
  expect(reviews.get("other-script")).toEqual(other);
});

test("a fast changed proposal resets old hunk progress before persistence without relying on React effects", async () => {
  const id = "script-fast-reset";
  seed(id);
  await rehydrateScriptAgentDraft(id);
  useAgentReviewRoundStore.getState().setAcceptedHunks("script", id, "rules", [0]);
  useAgentReviewRoundStore.getState().setDismissedHunks("script", id, "rules", [1]);
  await prepareScriptAgentReviewTurn(id, new AbortController().signal, "Hybrid code");
  useAgentTurnStore.getState().clearTurn("script", id);
  streamEvents = [event("tool-result", { toolCallId: "next", toolName: "write_buffer", output: { target: "code", proposed: "Revised code", summary: "Revised" }, isError: false }), event("finish", { finishReason: "stop" })];
  await streamPersistedScriptAgent(id, { content: "Revise", providerProfileId: "provider", code: "Hybrid code" }, callbacks(id));
  expect(reviews.get(id)!.round!.rulesKey).toBe("Hybrid code\0Revised code");
  expect(reviews.get(id)!.round!.acceptedRules).toEqual([]);
  expect(reviews.get(id)!.round!.dismissedRules).toEqual([]);
  expect(reviews.get(id)!.round!.dangling!.baseRules).toBe("Old code");
});
