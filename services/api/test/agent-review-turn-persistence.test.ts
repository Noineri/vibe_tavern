/** BR-2b3: real kind/core stream and SQLite, provider transport injected.
 * The oracle drives the actual web stores/serializer, not a copied envelope. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { AgentReviewRoundStore, createStoreContainer } from "@vibe-tavern/db";
import { experienceCopilotToolOutputSchema, type AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import { streamExperienceCopilot, type ExperienceCopilotStreamDeps, type ExperienceCopilotStreamEvent } from "../src/domain/interactive/copilot/experience-copilot-stream.js";
import { AgentReviewService } from "../src/domain/agent/agent-review-service.js";
import { ExperienceCopilotRunAdapter } from "../src/api/adapters/experience-copilot-run-adapter.js";
import { aggregateExperienceCopilotProposal } from "../../../apps/web/src/lib/experience-copilot-apply.js";
import { serializeDraft } from "../../../apps/web/src/lib/experience-copilot-draft.js";
import { EMPTY_REVIEW_ROUND, useAgentReviewRoundStore } from "../../../apps/web/src/stores/agent-review-store.js";
import { useAgentTurnStore } from "../../../apps/web/src/stores/agent-turn-store.js";
import { makeStreamTextDouble, type StreamTextPart } from "./provider-boundary-test-builders.js";

const originalRounds = useAgentReviewRoundStore.getState();
const originalTurns = useAgentTurnStore.getState();
beforeEach(() => {
  useAgentReviewRoundStore.setState(originalRounds, true);
  useAgentTurnStore.setState(originalTurns, true);
});
afterAll(() => {
  useAgentReviewRoundStore.setState(originalRounds, true);
  useAgentTurnStore.setState(originalTurns, true);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const call = (id: string, target: "rules" | "visual", content: string, toolName = "edit_buffer"): StreamTextPart => ({ type: "tool-call", toolCallId: id, toolName, input: { target, edits: [{ search: "Old", replace: content }] } });
const result = (id: string, target: "rules" | "visual", proposed: string, toolName = "edit_buffer"): StreamTextPart => ({ type: "tool-result", toolCallId: id, toolName, input: {}, output: { target, proposed, summary: `Changed ${target}` } });

async function setup(parts: StreamTextPart[], options: { error?: Error; abort?: AbortController; gate?: ReturnType<typeof deferred>; entered?: ReturnType<typeof deferred> } = {}) {
  const stores = await createStoreContainer(":memory:");
  let tick = 0;
  stores.agentReviewRounds = new AgentReviewRoundStore(stores.db, { clock: { now: () => new Date(Date.UTC(2026, 9, 29) + tick++ * 1000).toISOString() } });
  const script = await stores.scripts.create({ name: "Review", code: "Saved rules", scriptKind: "interactive" });
  const thread = await stores.experienceCopilot.startNewSession(script.id, "Review");
  const profile = await stores.providers.create({ name: "Provider", providerPreset: "openai", endpoint: "http://provider.test", defaultModel: "model" });
  const service = new AgentReviewService(stores);
  async function* provider() {
    options.entered?.resolve();
    await options.gate?.promise;
    for (const part of parts) yield part;
    options.abort?.abort();
    if (options.error) throw options.error;
  }
  const deps: ExperienceCopilotStreamDeps = {
    store: stores.experienceCopilot, reviews: service, agentPlans: stores.agentPlans,
    getScript: (id) => stores.scripts.getById(id),
    getBoundVisualIds: (id) => stores.scripts.getBoundVisualIds(id),
    getVisual: (id) => stores.experienceResources.getVisualById(id),
    getProviderProfile: (id) => stores.providers.getById(id),
    getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    // The generator fake (mid-stream gates, trailing abort/error) rides the
    // typed streamText double's pull-based parts source — same lazy timing
    // the erased `stream: provider()` fake had.
    streamText: makeStreamTextDouble(() => ({ parts: provider() }), "agent-review streamText"),
  };
  const request = { threadId: thread.id, content: "Revise", providerProfileId: profile.id, rules: "Old rules", visual: "Old visual" };
  return { stores, thread, service, deps, request };
}
async function collect(stream: AsyncIterable<ExperienceCopilotStreamEvent>) {
  const events: ExperienceCopilotStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Real pre-send capture → rising-edge snapshot → live activities → key effects. */
function webOracle(previous: AgentReviewEnvelope | null, buffers: { rules: string; visual: string }, events: ExperienceCopilotStreamEvent[]): AgentReviewEnvelope {
  const id = "oracle";
  useAgentReviewRoundStore.setState({ roundsByThread: { [id]: previous?.round ?? EMPTY_REVIEW_ROUND } });
  const roundActions = useAgentReviewRoundStore.getState();
  const old = aggregateExperienceCopilotProposal(previous?.activities ?? []);
  const base = previous?.round?.snapshots.at(-1);
  if (old.hasProposal) roundActions.captureDangling("experience", id, { rules: old.proposedRules, visual: old.proposedVisual, baseRules: base?.rules ?? buffers.rules, baseVisual: base?.visual ?? buffers.visual });
  roundActions.pushSnapshot("experience", id, { rules: buffers.rules, visual: buffers.visual });
  const turns = useAgentTurnStore.getState();
  turns.clearTurn("experience", id);
  for (const event of events) {
    if (event.event !== "tool-call" && event.event !== "tool-result") continue;
    const info = JSON.parse(event.data);
    if (info.toolName !== "edit_buffer" && info.toolName !== "write_buffer") continue;
    if (event.event === "tool-call") turns.upsertActivity("experience", id, { toolCallId: info.toolCallId, toolName: info.toolName, args: info.args, status: "streaming" });
    else {
      const output = experienceCopilotToolOutputSchema.safeParse(info.output);
      turns.upsertActivity("experience", id, { toolCallId: info.toolCallId, toolName: info.toolName, status: info.isError || !output.success ? "error" : "done", ...(output.success ? output.data : {}) });
    }
  }
  const activities = useAgentTurnStore.getState().turnsByThread[id] ?? [];
  const live = aggregateExperienceCopilotProposal(activities);
  const dangling = useAgentReviewRoundStore.getState().roundsByThread[id]!.dangling;
  const proposedRules = live.proposedRules ?? dangling?.rules;
  const proposedVisual = live.proposedVisual ?? dangling?.visual;
  const rulesBase = live.proposedRules === undefined ? dangling?.baseRules : buffers.rules;
  const visualBase = live.proposedVisual === undefined ? dangling?.baseVisual : buffers.visual;
  roundActions.ensureReviewKey("experience", id, "rules", proposedRules === undefined ? null : `${rulesBase ?? ""}\0${proposedRules}`);
  roundActions.ensureReviewKey("experience", id, "visual", proposedVisual === undefined ? null : `${visualBase ?? ""}\0${proposedVisual}`);
  return JSON.parse(serializeDraft(activities, useAgentReviewRoundStore.getState().roundsByThread[id]!)!);
}

describe("server-written agent review", () => {
  test("edit_buffer persists the same full envelope as the web, before finish reaches its reader", async () => {
    const h = await setup([call("r", "rules", "New"), result("r", "rules", "New rules"), call("v", "visual", "New"), result("v", "visual", "New visual")]);
    const events: ExperienceCopilotStreamEvent[] = [];
    let atFinish: AgentReviewEnvelope | null = null;
    for await (const event of streamExperienceCopilot(h.request, h.deps)) {
      events.push(event);
      if (event.event === "finish") atFinish = await h.service.get(h.thread.id);
    }
    expect(events.map((event) => event.event)).toEqual(["tool-call", "tool-result", "tool-call", "tool-result", "finish"]);
    expect(atFinish).not.toBeNull();
    expect(atFinish).toEqual(webOracle(null, h.request, events));
    expect((await h.stores.experienceCopilot.listMessages(h.thread.id)).filter((row) => row.role === "tool")).toHaveLength(2);
  });

  test("a visual-only follow-up retains rules progress and CD-8's original base, exactly like the web", async () => {
    const h = await setup([call("v2", "visual", "Revised"), result("v2", "visual", "Revised visual")]);
    const seedEvents = [
      { event: "tool-result", data: JSON.stringify({ toolCallId: "r", toolName: "write_buffer", output: { target: "rules", proposed: "New rules", summary: "Rules" } }) },
      { event: "tool-result", data: JSON.stringify({ toolCallId: "v", toolName: "write_buffer", output: { target: "visual", proposed: "New visual", summary: "Visual" } }) },
    ];
    const previous = webOracle(null, h.request, seedEvents);
    previous.round!.acceptedRules = [0];
    previous.round!.dismissedRules = [1];
    previous.round!.acceptedVisual = [2];
    await h.service.put(h.thread.id, previous);
    const request = { ...h.request, rules: "Partially accepted rules", visual: "Current visual" };
    const events = await collect(streamExperienceCopilot(request, h.deps));
    const saved = await h.service.get(h.thread.id);
    expect(saved).toEqual(webOracle(previous, request, events));
    expect(saved!.round!.acceptedRules).toEqual([0]);
    expect(saved!.round!.dismissedRules).toEqual([1]);
    expect(saved!.round!.acceptedVisual).toEqual([]);
    expect(saved!.round!.dangling!.baseRules).toBe("Old rules");
  });

  test("no-proposal turns preserve the previous envelope and updatedAt byte for byte", async () => {
    const h = await setup([{ type: "text-delta", id: "arp-advice", text: "Just advice" }]);
    const previous = webOracle(null, h.request, [{ event: "tool-result", data: JSON.stringify({ toolCallId: "r", toolName: "write_buffer", output: { target: "rules", proposed: "Pending", summary: "Rules" } }) }]);
    await h.service.put(h.thread.id, previous);
    const row = await h.stores.agentReviewRounds.get(h.thread.id);
    await collect(streamExperienceCopilot(h.request, h.deps));
    expect(await h.stores.agentReviewRounds.get(h.thread.id)).toEqual(row!);
  });

  test("read-only tools, unfinished calls, malformed outputs and failed tools never create a review", async () => {
    const h = await setup([
      call("pending", "rules", "Partial"),
      { type: "tool-result", toolCallId: "read", toolName: "run_test", input: {}, output: { target: "rules", proposed: "Not a write", summary: "Read only" } },
      { type: "tool-result", toolCallId: "bad", toolName: "edit_buffer", input: {}, output: { target: "rules", proposed: "Missing summary" } },
      { type: "tool-error", toolCallId: "error", toolName: "write_buffer", input: {}, error: new Error("Failed") },
    ]);
    const events = await collect(streamExperienceCopilot(h.request, h.deps));
    expect(events.at(-1)!.event).toBe("finish");
    expect(await h.service.get(h.thread.id)).toBeNull();
  });

  test("stored script context supplies the base when the request omits live buffers", async () => {
    const h = await setup([call("r", "rules", "Changed"), result("r", "rules", "Changed rules")]);
    const { rules: _rules, visual: _visual, ...request } = h.request;
    await collect(streamExperienceCopilot(request, h.deps));
    expect((await h.service.get(h.thread.id))!.round!.snapshots).toEqual([{ id: 1, rules: "Saved rules", visual: "" }]);
  });

  test("write_buffer and repeated calls keep browser call order with the last valid result", async () => {
    const h = await setup([
      call("a", "rules", "First", "write_buffer"), result("a", "rules", "First rules", "write_buffer"),
      call("b", "visual", "Visual"), result("b", "visual", "New visual"),
      result("a", "rules", "Revised rules", "write_buffer"),
    ]);
    const events = await collect(streamExperienceCopilot(h.request, h.deps));
    const saved = await h.service.get(h.thread.id);
    expect(saved).toEqual(webOracle(null, h.request, events));
    expect(saved!.activities.map((activity) => activity.toolCallId)).toEqual(["a", "b"]);
    expect(saved!.activities[0]!.proposed).toBe("Revised rules");
    expect(saved!.activities[0]!.args).toEqual({ target: "rules", edits: [{ search: "Old", replace: "First" }] });
  });

  test("a later failed result for the same call cannot revive its earlier valid proposal", async () => {
    const h = await setup([call("a", "rules", "First"), result("a", "rules", "First rules"), { type: "tool-error", toolCallId: "a", toolName: "edit_buffer", input: {}, error: new Error("Revised call failed") }]);
    await collect(streamExperienceCopilot(h.request, h.deps));
    expect(await h.service.get(h.thread.id)).toBeNull();
  });

  test("a review persistence failure is replayed as an error, never a successful finish", async () => {
    const h = await setup([call("r", "rules", "New"), result("r", "rules", "New rules")]);
    const deps = { ...h.deps, reviews: { get: (id: string) => h.service.get(id), put: async (): Promise<AgentReviewEnvelope> => { throw new Error("Review store unavailable"); } } };
    const runner = new ExperienceCopilotRunAdapter(h.stores.experienceCopilot, async () => async function* (threadId, body, signal) {
      yield* streamExperienceCopilot({ ...body, threadId }, deps, signal);
    });
    const events = await collect(await runner.experienceCopilotStartRun(h.thread.id, h.request));
    expect(events.some((event) => event.event === "finish")).toBe(false);
    expect(events.at(-1)!.event).toBe("error");
    expect(JSON.parse(events.at(-1)!.data).message).toContain("Review store unavailable");
    expect((await h.stores.experienceCopilot.listMessages(h.thread.id)).some((row) => row.role === "tool")).toBe(true);
  });

  for (const mode of ["abort", "error"] as const) {
    test(`a partial ${mode} turn retains its completed proposal without persisting an unfinished call`, async () => {
      const abort = new AbortController();
      const h = await setup([call("done", "rules", "New"), result("done", "rules", "New rules"), call("unfinished", "visual", "Partial")], mode === "abort" ? { abort } : { error: new Error("Provider failed") });
      const events = await collect(streamExperienceCopilot(h.request, h.deps, abort.signal));
      expect(events.at(-1)!.event).toBe(mode);
      const saved = await h.service.get(h.thread.id);
      expect(saved!.activities.map((activity) => activity.toolCallId)).toEqual(["done"]);
      expect(saved).toEqual(webOracle(null, h.request, events));
    });
  }

  test("a disconnected detached subscriber does not prevent review persistence", async () => {
    const gate = deferred();
    const entered = deferred();
    const h = await setup([call("r", "rules", "New"), result("r", "rules", "New rules")], { gate, entered });
    const runner = new ExperienceCopilotRunAdapter(h.stores.experienceCopilot, async () => async function* (threadId, body, signal) {
      yield* streamExperienceCopilot({ ...body, threadId }, h.deps, signal);
    });
    const client = new AbortController();
    const subscription = await runner.experienceCopilotStartRun(h.thread.id, h.request, client.signal);
    try {
      await entered.promise;
      client.abort();
      expect((await subscription[Symbol.asyncIterator]().next()).done).toBe(true);
      gate.resolve();
      const replay = await collect(runner.experienceCopilotSubscribeRun(h.thread.id, 0)!);
      expect(replay.at(-1)!.event).toBe("finish");
      expect((await h.service.get(h.thread.id))!.activities[0]!.proposed).toBe("New rules");
      expect(runner.agentRuns.active()).toHaveLength(0);
    } finally {
      gate.resolve();
      await collect(runner.experienceCopilotSubscribeRun(h.thread.id, 0)!);
    }
  });
});
