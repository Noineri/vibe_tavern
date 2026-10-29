/** BR-2c2: coordinator DI boundary; all ordering is parked, never timed. */
import { expect, test } from "bun:test";
import { buildAgentReviewEnvelope, type AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import { AgentReviewPersistence, type AgentReviewPersistenceDeps } from "./agent-review-persistence.js";

const buffers = { rules: "Old rules", visual: "Old visual" };
function envelope(proposed = "New rules"): AgentReviewEnvelope {
  return buildAgentReviewEnvelope(null, [{ toolCallId: "write", toolName: "write_buffer", status: "done", target: "rules", proposed }], buffers)!;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(seed: AgentReviewEnvelope | null = null) {
  const server = new Map<string, AgentReviewEnvelope>();
  if (seed) server.set("thread", structuredClone(seed));
  const local = new Map<string, AgentReviewEnvelope>();
  const legacy = new Map<string, AgentReviewEnvelope>();
  const running = new Set<string>();
  const writes: Array<{ id: string; envelope: AgentReviewEnvelope | null }> = [];
  const deps: AgentReviewPersistenceDeps = {
    api: {
      get: async (id) => structuredClone(server.get(id) ?? null),
      put: async (id, value) => { writes.push({ id, envelope: value }); server.set(id, structuredClone(value)); return value; },
      delete: async (id) => { writes.push({ id, envelope: null }); server.delete(id); },
      isRunning: async (id) => running.has(id),
    },
    read: (id) => local.get(id) ?? null,
    apply: (id, value) => { if (value) local.set(id, structuredClone(value)); else local.delete(id); },
    readLegacy: (id) => legacy.get(id) ?? null,
    removeLegacy: (id) => { legacy.delete(id); },
  };
  return { server, local, legacy, running, writes, deps, persistence: new AgentReviewPersistence(deps) };
}

test("a fresh coordinator restores activities, original bases and accept/dismiss progress from the server", async () => {
  const seed = envelope();
  seed.round!.acceptedRules = [0];
  seed.round!.dismissedRules = [1];
  const h = fixture(seed);
  await h.persistence.hydrate("thread");
  expect(h.local.get("thread")).toEqual(seed);
  expect(h.writes).toEqual([]);
});

test("legacy upload succeeds before key removal and occurs only once across reloads", async () => {
  const h = fixture();
  h.legacy.set("thread", envelope());
  const entered = gate();
  const release = gate();
  const put = h.deps.api.put;
  h.deps.api.put = async (id, value) => { entered.resolve(); await release.promise; return put(id, value); };
  const loading = h.persistence.hydrate("thread");
  try {
    await entered.promise;
    expect(h.legacy.has("thread")).toBe(true);
    release.resolve();
    await loading;
    expect(h.legacy.has("thread")).toBe(false);
    expect(h.server.get("thread")).toEqual(envelope());
    await new AgentReviewPersistence(h.deps).hydrate("thread");
    expect(h.writes).toHaveLength(1);
  } finally { release.resolve(); await loading; }
});

test("failed migration retains the key and can retry without poisoning the lane", async () => {
  const h = fixture();
  const degraded = { ...envelope(), round: null };
  h.legacy.set("thread", degraded);
  const put = h.deps.api.put;
  h.deps.api.put = async () => { throw new Error("Upload failed"); };
  await expect(h.persistence.hydrate("thread")).rejects.toThrow("Upload failed");
  expect(h.legacy.get("thread")).toEqual(degraded);
  h.deps.api.put = put;
  await h.persistence.hydrate("thread");
  expect(h.local.get("thread")!.round).toBeNull();
  expect(h.legacy.has("thread")).toBe(false);
});

test("existing server data wins over legacy and stale in-memory proposals", async () => {
  const h = fixture(envelope("Server"));
  h.legacy.set("thread", envelope("Legacy"));
  h.local.set("thread", envelope("Stale memory"));
  await h.persistence.hydrate("thread");
  expect(h.local.get("thread")!.activities[0]!.proposed).toBe("Server");
  expect(h.legacy.has("thread")).toBe(false);
  expect(h.writes).toEqual([]);
});

test("pre-hydration effects cannot DELETE a saved review; resolved state deletes after hydration", async () => {
  const h = fixture(envelope());
  await h.persistence.sync("thread");
  expect(h.writes).toEqual([]);
  await h.persistence.hydrate("thread");
  h.local.delete("thread");
  await h.persistence.sync("thread");
  expect(h.server.has("thread")).toBe(false);
  expect(h.writes).toEqual([{ id: "thread", envelope: null }]);
});

test("prepare drains older writes, then freezes snapshot/proposal writes until the watched turn settles", async () => {
  const h = fixture(envelope());
  await h.persistence.hydrate("thread");
  h.local.get("thread")!.round!.acceptedRules = [0];
  const entered = gate();
  const release = gate();
  const put = h.deps.api.put;
  h.deps.api.put = async (id, value) => { entered.resolve(); await release.promise; return put(id, value); };
  const saving = h.persistence.sync("thread");
  let prepared = false;
  const preparing = h.persistence.prepare("thread", new AbortController().signal).then(() => { prepared = true; });
  try {
    await entered.promise;
    expect(prepared).toBe(false);
    release.resolve();
    await saving;
    await preparing;
    expect(h.server.get("thread")!.round!.acceptedRules).toEqual([0]);
    const next = buildAgentReviewEnvelope(h.server.get("thread")!, [{ ...envelope().activities[0]!, toolCallId: "next", proposed: "Next" }], buffers)!;
    h.local.set("thread", next);
    await h.persistence.sync("thread");
    h.persistence.start("thread");
    await h.persistence.sync("thread");
    expect(h.writes).toHaveLength(1);
    h.server.set("thread", structuredClone(next)); // Producer commits before finish.
    await h.persistence.finish("thread", true);
    expect(h.server.get("thread")!.round!.snapshots).toHaveLength(2);
    expect(h.writes).toHaveLength(1); // No duplicated client snapshot write.
  } finally { release.resolve(); await saving; await preparing; }
});

test("a detached subscription cannot overwrite the producer, even after abort and a local edit", async () => {
  const h = fixture(envelope());
  await h.persistence.hydrate("thread");
  const controller = new AbortController();
  await h.persistence.prepare("thread", controller.signal);
  h.persistence.start("thread");
  h.running.add("thread");
  controller.abort();
  await h.persistence.finish("thread", false);
  h.local.set("thread", envelope("Partial stale client"));
  await h.persistence.sync("thread");
  expect(h.writes).toHaveLength(0);
  h.server.set("thread", envelope("Server completed"));
  h.running.delete("thread");
  await h.persistence.sync("thread");
  expect(h.local.get("thread")!.activities[0]!.proposed).toBe("Server completed");
  expect(h.writes).toHaveLength(0);
});

test("a run discovered on mount suppresses legacy upload and recovers its result when idle", async () => {
  const h = fixture();
  h.running.add("thread");
  h.legacy.set("thread", envelope("Legacy"));
  await h.persistence.hydrate("thread");
  await h.persistence.sync("thread");
  expect(h.legacy.has("thread")).toBe(true);
  expect(h.writes).toHaveLength(0);
  h.server.set("thread", envelope("Background result"));
  h.running.delete("thread");
  await h.persistence.hydrate("thread");
  expect(h.local.get("thread")!.activities[0]!.proposed).toBe("Background result");
  expect(h.legacy.has("thread")).toBe(false);
});

test("a changed server predecessor wins instead of uploading a stale idle review", async () => {
  const h = fixture(envelope());
  await h.persistence.hydrate("thread");
  h.local.get("thread")!.round!.acceptedRules = [1];
  h.server.set("thread", envelope("Background replacement"));
  await h.persistence.sync("thread");
  expect(h.local.get("thread")!.activities[0]!.proposed).toBe("Background replacement");
  expect(h.writes).toHaveLength(0);
});

test("a failed ordered write prevents turn preparation and remains retryable", async () => {
  const h = fixture(envelope());
  await h.persistence.hydrate("thread");
  h.local.get("thread")!.round!.dismissedRules = [0];
  const put = h.deps.api.put;
  h.deps.api.put = async () => { throw new Error("Save failed"); };
  await expect(h.persistence.prepare("thread", new AbortController().signal)).rejects.toThrow("Save failed");
  h.deps.api.put = put;
  await h.persistence.prepare("thread", new AbortController().signal);
  expect(h.server.get("thread")!.round!.dismissedRules).toEqual([0]);
});

test("cancelling a prepared but unopened turn releases the lane without clearing the review", async () => {
  const h = fixture(envelope());
  await h.persistence.hydrate("thread");
  const controller = new AbortController();
  await h.persistence.prepare("thread", controller.signal);
  controller.abort();
  h.local.get("thread")!.round!.acceptedRules = [0];
  await h.persistence.sync("thread");
  expect(h.server.get("thread")!.round!.acceptedRules).toEqual([0]);
});

test("different threads have independent lanes while a PUT is parked", async () => {
  const h = fixture(envelope());
  await h.persistence.hydrate("thread");
  h.local.get("thread")!.round!.acceptedRules = [0];
  h.legacy.set("other", envelope("Other"));
  const entered = gate();
  const release = gate();
  const put = h.deps.api.put;
  h.deps.api.put = async (id, value) => { if (id === "thread") { entered.resolve(); await release.promise; } return put(id, value); };
  const saving = h.persistence.sync("thread");
  try {
    await entered.promise;
    await h.persistence.hydrate("other");
    expect(h.local.get("other")!.activities[0]!.proposed).toBe("Other");
    expect(h.server.get("thread")!.round!.acceptedRules).toEqual([]);
  } finally { release.resolve(); await saving; }
});

test("a fast watched finish may precede registry idle; later synchronization still keeps its local checkpoint", async () => {
  const h = fixture(envelope());
  await h.persistence.hydrate("thread");
  await h.persistence.prepare("thread", new AbortController().signal);
  h.persistence.start("thread");
  h.running.add("thread");
  const next = buildAgentReviewEnvelope(h.server.get("thread")!, [{ ...envelope().activities[0]!, proposed: "Next" }], buffers)!;
  h.local.set("thread", next);
  h.server.set("thread", structuredClone(next));
  await h.persistence.finish("thread", true);
  expect(h.writes).toHaveLength(0);
  h.running.delete("thread");
  await h.persistence.sync("thread");
  expect(h.local.get("thread")!.round!.snapshots).toHaveLength(2);
  expect(h.writes).toHaveLength(0);
});

test("failed hydration never authorizes writes; a concurrent local mutation is not overwritten by its response", async () => {
  const h = fixture(envelope());
  const entered = gate();
  const release = gate();
  const get = h.deps.api.get;
  h.deps.api.get = async (id) => { entered.resolve(); await release.promise; return get(id); };
  const loading = h.persistence.hydrate("thread");
  const rejected = loading.then(() => null, (error: unknown) => error);
  try {
    await entered.promise;
    h.local.set("thread", envelope("Changed locally"));
    release.resolve();
    expect(await rejected).toBeInstanceOf(Error);
    expect(h.local.get("thread")!.activities[0]!.proposed).toBe("Changed locally");
    await h.persistence.sync("thread");
    expect(h.writes).toHaveLength(0);
  } finally { release.resolve(); await loading.catch(() => undefined); }
});
