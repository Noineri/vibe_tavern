/** BR-2d2: real script/core stream, review service/routes and SQLite.
 * Only provider transport and the deliberate store-failure case use DI. */
import { expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { AgentReviewRoundStore, createStoreContainer } from "@vibe-tavern/db";
import { buildScriptAgentReviewEnvelope, type AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import { AgentReviewService } from "../src/domain/agent/agent-review-service.js";
import { streamScriptAgentTurn, type ScriptAgentStreamDeps } from "../src/domain/agent/script-agent/script-agent-stream.js";
import { ExperienceCopilotRunAdapter } from "../src/api/adapters/experience-copilot-run-adapter.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";

const call = (id: string, toolName = "write_buffer") => ({ type: "tool-call", toolCallId: id, toolName, input: { target: "code", content: "New code" } });
const result = (id: string, proposed: string, toolName = "write_buffer") => ({ type: "tool-result", toolCallId: id, toolName, output: { target: "code", proposed, summary: "Updated code" } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup(parts: unknown[], options: { kind?: "prompt" | "dice"; abort?: AbortController; error?: Error; gate?: ReturnType<typeof deferred>; entered?: ReturnType<typeof deferred> } = {}) {
  const stores = await createStoreContainer(":memory:");
  let tick = 0;
  stores.agentReviewRounds = new AgentReviewRoundStore(stores.db, { clock: { now: () => new Date(Date.UTC(2026, 9, 29) + tick++ * 1000).toISOString() } });
  const script = await stores.scripts.create({ name: "Review", scriptKind: options.kind ?? "prompt", code: "Stored code" });
  const thread = await stores.experienceCopilot.startNewSession(script.id, "Review");
  const profile = await stores.providers.create({ name: "Provider", providerPreset: "openai", endpoint: "http://provider.test", defaultModel: "model" });
  const reviews = new AgentReviewService(stores);
  async function* provider() {
    options.entered?.resolve();
    await options.gate?.promise;
    for (const part of parts) yield part;
    options.abort?.abort();
    if (options.error) throw options.error;
  }
  const deps: ScriptAgentStreamDeps = {
    stores, store: stores.experienceCopilot, reviews, agentPlans: stores.agentPlans,
    getScript: (id) => stores.scripts.getById(id),
    getContextCards: async () => ({ ownerNames: [], cards: [] }),
    getProviderProfile: (id) => stores.providers.getById(id), getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    streamText: (() => ({ stream: provider(), finishReason: Promise.resolve("stop"), usage: Promise.resolve(undefined) })) as unknown as ScriptAgentStreamDeps["streamText"],
  };
  const request = { threadId: thread.id, providerProfileId: profile.id, content: "Revise", code: "Live code" };
  return { stores, script, thread, reviews, deps, request };
}
async function collect(stream: AsyncIterable<{ event: string; data: string }>) {
  const events: Array<{ event: string; data: string }> = [];
  for await (const event of stream) events.push(event);
  return events;
}

for (const kind of ["prompt", "dice"] as const) {
  test(`${kind} stream commits native code proposals before finish without saving or enabling the script`, async () => {
    const h = await setup([call("write"), result("write", "New code")], { kind });
    let saved: AgentReviewEnvelope | null = null;
    for await (const event of streamScriptAgentTurn(h.request, h.deps)) {
      if (event.event === "finish") saved = await h.reviews.get(h.thread.id);
    }
    expect(saved).not.toBeNull();
    expect(saved!.activities).toEqual([{ toolCallId: "write", toolName: "write_buffer", status: "done", args: { target: "code", content: "New code" }, target: "code", proposed: "New code", summary: "Updated code" }]);
    expect(saved!.round!.snapshots).toEqual([{ id: 1, rules: "Live code", visual: "" }]);
    expect(saved!.round!.rulesKey).toBe("Live code\0New code");
    expect(await h.stores.scripts.getById(h.script.id)).toEqual(h.script);
    const app = createExperienceCopilotRoutes(new ExperienceCopilotAdapter(h.stores));
    const path = `/api/experience-copilot/${h.thread.id}/review`;
    expect(await (await app.request(path)).json()).toEqual(saved!);
    const updated = { ...saved!, round: { ...saved!.round!, acceptedRules: [0], dismissedRules: [1] } };
    const response = await app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(updated) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updated);
    expect(await h.reviews.get(h.thread.id)).toEqual(updated);
  });
}

test("edit_buffer can intentionally propose empty code, using stored code when no live buffer is supplied", async () => {
  const h = await setup([call("delete", "edit_buffer"), result("delete", "", "edit_buffer")]);
  const { code: _code, ...request } = h.request;
  await collect(streamScriptAgentTurn(request, h.deps));
  const saved = await h.reviews.get(h.thread.id);
  expect(saved!.activities[0]!.proposed).toBe("");
  expect(saved!.round!.snapshots[0]!.rules).toBe("Stored code");
  expect(saved!.round!.rulesKey).toBe("Stored code\0");
});

test("follow-up captures the original base and resets progress only for a changed code key", async () => {
  const h = await setup([call("next"), result("next", "Next code")]);
  const previous = buildScriptAgentReviewEnvelope(null, [{ toolCallId: "old", toolName: "write_buffer", status: "done", target: "code", proposed: "Pending" }], "Original")!;
  previous.round!.acceptedRules = [0];
  previous.round!.dismissedRules = [1];
  await h.reviews.put(h.thread.id, previous);
  await collect(streamScriptAgentTurn(h.request, h.deps));
  const saved = await h.reviews.get(h.thread.id);
  expect(saved!.round!.dangling).toEqual({ rules: "Pending", baseRules: "Original", baseVisual: "" });
  expect(saved!.round!.snapshots).toHaveLength(2);
  expect(saved!.round!.acceptedRules).toEqual([]);
  expect(saved!.round!.dismissedRules).toEqual([]);
});

test("no-proposal/read-only/malformed/failed/incomplete results preserve the previous row and timestamp", async () => {
  const h = await setup([
    { type: "text-delta", text: "Advice" }, call("unfinished"),
    result("read", "Not a write", "run_script_test"),
    { type: "tool-result", toolCallId: "bad", toolName: "edit_buffer", output: { target: "code", proposed: "Missing summary" } },
    { type: "tool-error", toolCallId: "failed", toolName: "write_buffer", error: new Error("Failed") },
    { type: "tool-result", toolCallId: "wrong-target", toolName: "write_buffer", output: { target: "rules", proposed: "Wrong kind", summary: "Not code" } },
  ]);
  const previous = buildScriptAgentReviewEnvelope(null, [{ toolCallId: "old", toolName: "write_buffer", status: "done", target: "code", proposed: "Pending" }], "Original")!;
  await h.reviews.put(h.thread.id, previous);
  const before = await h.stores.agentReviewRounds.get(h.thread.id);
  await collect(streamScriptAgentTurn(h.request, h.deps));
  expect(await h.stores.agentReviewRounds.get(h.thread.id)).toEqual(before!);
});

for (const mode of ["abort", "error"] as const) {
  test(`partial ${mode} persists only its completed proposal before the unchanged terminal event`, async () => {
    const abort = new AbortController();
    const h = await setup([call("done"), result("done", "Completed code"), call("unfinished")], mode === "abort" ? { abort } : { error: new Error("Provider failed") });
    const events = await collect(streamScriptAgentTurn(h.request, h.deps, abort.signal));
    expect(events.at(-1)!.event).toBe(mode);
    expect((await h.reviews.get(h.thread.id))!.activities.map((activity) => activity.toolCallId)).toEqual(["done"]);
  });
}

test("disconnecting a real run subscriber does not stop script review persistence", async () => {
  const gate = deferred();
  const entered = deferred();
  const h = await setup([call("write"), result("write", "Detached code")], { gate, entered });
  const runner = new ExperienceCopilotRunAdapter(h.stores.experienceCopilot, async () => async function* (threadId, body, signal) {
    yield* streamScriptAgentTurn({ ...body, threadId }, h.deps, signal);
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
    expect((await h.reviews.get(h.thread.id))!.activities[0]!.proposed).toBe("Detached code");
  } finally { gate.resolve(); await collect(runner.experienceCopilotSubscribeRun(h.thread.id, 0)!); }
});

test("a review save failure emits a run error, never a successful finish", async () => {
  const h = await setup([call("write"), result("write", "New code")]);
  const deps: ScriptAgentStreamDeps = { ...h.deps, reviews: { get: (id) => h.reviews.get(id), put: async () => { throw new Error("Review save unavailable"); } } };
  const runner = new ExperienceCopilotRunAdapter(h.stores.experienceCopilot, async () => async function* (threadId, body, signal) {
    yield* streamScriptAgentTurn({ ...body, threadId }, deps, signal);
  });
  const events = await collect(await runner.experienceCopilotStartRun(h.thread.id, h.request));
  expect(events.some((event) => event.event === "finish")).toBe(false);
  expect(events.at(-1)!.event).toBe("error");
  expect(JSON.parse(events.at(-1)!.data).message).toContain("Review save unavailable");
});
