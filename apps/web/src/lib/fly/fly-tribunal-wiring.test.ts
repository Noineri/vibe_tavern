import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
  type FlyBrainManifest,
} from "@vibe-tavern/api-contracts";
import {
  selectFlyVerdict,
  useFlyTribunalStore,
} from "../../stores/fly-tribunal-store.js";
import type { FlyEvaluation } from "./fly-engine-core.js";
import {
  FLY_EDITED_SAVE_STRENGTH,
  FLY_IMPLICIT_KEEP_STRENGTH,
  FlyTribunalWiring,
  type FlyTribunalSnapshotMessage,
  type FlyTribunalSnapshotSource,
  type FlyTribunalSnapshotState,
  type FlyTribunalWorker,
} from "./fly-tribunal-wiring.js";
import type { FlyWorkerRequest, FlyWorkerResponse } from "./fly-worker.js";

/**
 * Fly Tribunal wiring (FLY_TRIBUNAL_PLAN FT-11).
 *
 * L1 checklist:
 * 1. Paths: none.
 * 2. Restores: the real Zustand Fly store is restored after every test and
 *    again afterAll; worker/snapshot are local fakes, no globals patched.
 * 3. Determinism: fake worker responses are emitted synchronously; no waits.
 * 4. Platform: no paths or OS assumptions.
 * 5. Shared worker pool: dependency injection only, no module mocks/registries.
 * 6. Stable state: assertions read terminal sent requests and settled store data.
 */

const originalFlyStore = useFlyTribunalStore.getState();

class FakeWorker implements FlyTribunalWorker {
  readonly requests: FlyWorkerRequest[] = [];
  private readonly listeners = new Set<EventListener>();

  postMessage(request: FlyWorkerRequest): void {
    this.requests.push(request);
  }

  addEventListener(_type: "message", listener: EventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: EventListener): void {
    this.listeners.delete(listener);
  }

  emit(response: FlyWorkerResponse): void {
    const event = new MessageEvent<FlyWorkerResponse>("message", { data: response });
    for (const listener of this.listeners) listener(event);
  }
}

class FakeTimer {
  private next = 0;
  private readonly callbacks = new Map<number, () => void>();

  set = (callback: () => void, _delayMs: number): unknown => {
    const id = this.next;
    this.next += 1;
    this.callbacks.set(id, callback);
    return id;
  };

  clear = (handle: unknown): void => {
    if (typeof handle === "number") this.callbacks.delete(handle);
  };

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

class FakeSnapshot implements FlyTribunalSnapshotSource {
  private readonly listeners = new Set<() => void>();

  constructor(private state: FlyTribunalSnapshotState) {}

  getState(): FlyTribunalSnapshotState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMessage(message: FlyTribunalSnapshotMessage): void {
    this.state = {
      ...this.state,
      messagesById: { ...this.state.messagesById, [message.id]: message },
    };
    this.notify();
  }

  appendMessage(message: FlyTribunalSnapshotMessage): void {
    this.state = {
      ...this.state,
      messageOrder: [...this.state.messageOrder, message.id],
      messagesById: { ...this.state.messagesById, [message.id]: message },
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function manifest(): FlyBrainManifest {
  return {
    format: "fly-brain-manifest/1",
    generatedAt: "2026-09-27T00:00:00.000Z",
    generator: "test",
    source: { dataset: "mcns", version: "1.0", access: "test", license: "CC-BY-4.0", attribution: "test" },
    binary: {
      file: "connectome.bin.gz",
      formatVersion: 1,
      sha256: "0".repeat(64),
      sizeBytes: 1,
      neuronCount: 1,
      edgeCount: 1,
    },
    weights: { unit: "test", aggregation: "test", excitatory: [], inhibitory: [], unknownDefaultsTo: "test" },
    groups: [],
    countsByGroup: {},
    types: [""],
  };
}

function userMessage(id: string, content = "continue"): FlyTribunalSnapshotMessage {
  return { id, role: "user", content, selectedVariantIndex: null, variants: [] };
}

function assistantMessage(
  id: string,
  selectedVariantIndex: number,
  variants: Array<{ variantIndex: number; content: string; isSelected?: boolean }>,
): FlyTribunalSnapshotMessage {
  return {
    id,
    role: "assistant",
    content: variants.find((variant) => variant.variantIndex === selectedVariantIndex)?.content ?? "",
    selectedVariantIndex,
    variants,
  };
}

function makeSnapshot(message: FlyTribunalSnapshotMessage): FakeSnapshot {
  return new FakeSnapshot({
    activeChat: { id: "chat_1" },
    messageOrder: [message.id],
    messagesById: { [message.id]: message },
  });
}

function readyBrain() {
  return {
    status: "ready" as const,
    source: "cache" as const,
    manifest: manifest(),
    bytes: new Uint8Array([1, 2, 3]),
  };
}

function evaluation(confidence = 0.8): FlyEvaluation {
  return {
    confidence,
    registry: [{ ngram: "violet lantern", channel: 3, count: 1, activation: 1 }],
    drivingSpans: [{ ngram: "violet lantern", channel: 3, activation: 1, activeKcGlobalIndexes: [4] }],
    activeKcIndexes: [2],
    activeKcGlobalIndexes: [4],
    mbonReadout: [],
    gfSpikeCount: 0,
  };
}

function evaluateRequests(worker: FakeWorker): Extract<FlyWorkerRequest, { type: "evaluate" }>[] {
  return worker.requests.filter((request): request is Extract<FlyWorkerRequest, { type: "evaluate" }> => request.type === "evaluate");
}

function enableTribunal(): void {
  const store = useFlyTribunalStore.getState();
  store.applySettings({ ...store.settings, enabled: true });
}

function resetFlyStore(): void {
  useFlyTribunalStore.setState(originalFlyStore, true);
}

afterEach(() => resetFlyStore());
afterAll(() => resetFlyStore());

describe("FlyTribunalWiring", () => {
  test("loads the cached brain, hydrates memory, evaluates the shown assistant, and dedupes repeat snapshots", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [{ variantIndex: 0, content: "violet lantern", isSelected: true }]));
    const memoryCalls: Array<{ scope: string; chatId?: string }> = [];
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async (scope, chatId) => {
        memoryCalls.push({ scope, chatId });
        return 24;
      },
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    expect(worker.requests.map((request) => request.type)).toEqual(["load"]);
    expect(memoryCalls).toEqual([{ scope: "chat", chatId: "chat_1" }]);
    expect(useFlyTribunalStore.getState().precedentCount).toBe(24);

    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    expect(evaluateRequests(worker).map((request) => request.text)).toEqual(["violet lantern"]);

    snapshot.setMessage(snapshot.getState().messagesById.m1!);
    expect(evaluateRequests(worker)).toHaveLength(1);
    wiring.stop();
  });

  test("threads persisted sparse weights into worker load before its first evaluation", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [{ variantIndex: 0, content: "violet lantern", isSelected: true }]));
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 0,
      fetchMemory: async () => ({
        scope: "chat",
        chatId: "chat_1",
        schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
        precedentCount: 7,
        weights: "H4sIAAAAAAAA/2NgYGBgAgAAAP//AwAV6QEAAAA=",
        updatedAt: "2026-09-27T00:00:00.000Z",
      }),
      now: () => Date.parse("2026-09-28T00:00:00.000Z"),
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    const load = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "load" }> => request.type === "load");
    if (load === undefined || load.memory === undefined) throw new Error("expected memory on load");
    expect(load.memory).toEqual({
      schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
      weights: "H4sIAAAAAAAA/2NgYGBgAgAAAP//AwAV6QEAAAA=",
      updatedAt: "2026-09-27T00:00:00.000Z",
      lifetimeDays: 14,
      nowMs: Date.parse("2026-09-28T00:00:00.000Z"),
    });
    expect(useFlyTribunalStore.getState().precedentCount).toBe(7);
    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    expect(evaluateRequests(worker)).toHaveLength(1);
    wiring.stop();
  });

  test("a stale schema row hydrates as a fresh fly and persists an empty current-version row", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const putBodies: unknown[] = [];
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [{ variantIndex: 0, content: "violet lantern", isSelected: true }]));
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 0,
      fetchMemory: async () => ({
        scope: "chat",
        chatId: "chat_1",
        schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION - 1,
        precedentCount: 9,
        weights: "H4sIAAAAAAAA/2NgYGBgAgAAAP//AwAV6QEAAAA=",
        updatedAt: "2026-09-27T00:00:00.000Z",
      }),
      putMemory: async (memory) => { putBodies.push(memory); },
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    await Promise.resolve();
    // FT-17 owner-approved full reset: stale rows count as zero precedents.
    expect(useFlyTribunalStore.getState().precedentCount).toBe(0);
    const load = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "load" }> => request.type === "load");
    if (load === undefined || load.memory === undefined) throw new Error("expected memory on load");
    expect(load.memory).toEqual({
      schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
      weights: null,
      updatedAt: "",
      lifetimeDays: 14,
      nowMs: load.memory.nowMs,
    });
    expect(putBodies).toEqual([
      {
        scope: "chat",
        chatId: "chat_1",
        schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
        precedentCount: 0,
        weights: null,
      },
    ]);
    wiring.stop();
  });

  test("a shown variant switch and saved-text update each re-evaluate the current variant", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [
      { variantIndex: 0, content: "first answer", isSelected: true },
      { variantIndex: 1, content: "second answer" },
    ]));
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 0,
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    snapshot.setMessage(assistantMessage("m1", 1, [
      { variantIndex: 0, content: "first answer" },
      { variantIndex: 1, content: "second answer", isSelected: true },
    ]));
    snapshot.setMessage(assistantMessage("m1", 1, [
      { variantIndex: 0, content: "first answer" },
      { variantIndex: 1, content: "saved edited answer", isSelected: true },
    ]));

    const requests = evaluateRequests(worker);
    expect(requests.map((request) => request.text)).toEqual([
      "first answer",
      "second answer",
      "saved edited answer",
    ]);
    const staleVariantResponse = requests[1];
    const currentVariantResponse = requests[2];
    if (staleVariantResponse === undefined || currentVariantResponse === undefined) {
      throw new Error("expected both pre-save and post-save variant evaluations");
    }
    worker.emit({ type: "evaluated", id: staleVariantResponse.id, result: evaluation(0.1) });
    expect(selectFlyVerdict(useFlyTribunalStore.getState(), "m1", 1)).toBeUndefined();
    worker.emit({ type: "evaluated", id: currentVariantResponse.id, result: evaluation(0.9) });
    expect(selectFlyVerdict(useFlyTribunalStore.getState(), "m1", 1)?.confidence).toBe(0.9);
    wiring.stop();
  });

  test("an evaluated response writes the verdict and active transient into the FT-8 sink", async () => {
    enableTribunal();
    useFlyTribunalStore.getState().setPrecedentCount(25);
    const worker = new FakeWorker();
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [{ variantIndex: 0, content: "violet lantern", isSelected: true }]));
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 25,
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    const request = evaluateRequests(worker)[0]!;
    worker.emit({ type: "evaluated", id: request.id, result: evaluation() });

    expect(selectFlyVerdict(useFlyTribunalStore.getState(), "m1", 0)?.confidence).toBe(0.8);
    expect(useFlyTribunalStore.getState().transientState).toBe("alert");
    wiring.stop();
    expect(selectFlyVerdict(useFlyTribunalStore.getState(), "m1", 0)).toBeUndefined();
    expect(useFlyTribunalStore.getState().precedentCount).toBe(25);
  });

  test("the exposed FT-12 training seam increments only after the worker confirms training", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [{ variantIndex: 0, content: "violet lantern", isSelected: true }]));
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 0,
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    expect(wiring.train("violet lantern", "PPL1", 0.5)).toBe(true);
    const train = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "train" }> => request.type === "train");
    if (train === undefined) throw new Error("expected a training request");

    worker.emit({ type: "trained", id: train.id, result: evaluation() });
    expect(useFlyTribunalStore.getState().precedentCount).toBe(1);
    expect(useFlyTribunalStore.getState().transientState).toBe("notes-a-precedent");
    wiring.stop();
  });

  test("settles a swipe chain on the next user message as one contrastive precedent", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [
      { variantIndex: 0, content: "rejected answer", isSelected: true },
      { variantIndex: 1, content: "kept answer" },
    ]));
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 0,
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    snapshot.setMessage(assistantMessage("m1", 1, [
      { variantIndex: 0, content: "rejected answer" },
      { variantIndex: 1, content: "kept answer", isSelected: true },
    ]));
    expect(worker.requests.some((request) => request.type === "train-batch")).toBe(false);

    snapshot.appendMessage(userMessage("u2"));
    const batch = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "train-batch" }> => request.type === "train-batch");
    if (batch === undefined) throw new Error("expected settled contrastive training batch");
    expect(batch.events).toEqual([
      { text: "rejected answer", danCluster: "PPL1", strength: 0.5 },
      { text: "kept answer", danCluster: "PAM", strength: FLY_IMPLICIT_KEEP_STRENGTH },
    ]);
    worker.emit({ type: "trained", id: batch.id, result: null });
    expect(useFlyTribunalStore.getState().precedentCount).toBe(1);
    wiring.stop();
  });

  test("historical saved edits use the stronger PAM weight and training-off sends nothing", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const original = assistantMessage("m1", 0, [{ variantIndex: 0, content: "before edit", isSelected: true }]);
    const snapshot = new FakeSnapshot({
      activeChat: { id: "chat_1" },
      messageOrder: ["u1", "m1", "u2"],
      messagesById: { u1: userMessage("u1"), m1: original, u2: userMessage("u2") },
    });
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 0,
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    snapshot.setMessage(assistantMessage("m1", 0, [{ variantIndex: 0, content: "final saved edit", isSelected: true }]));
    const edited = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "train" }> => request.type === "train");
    if (edited === undefined) throw new Error("expected edited-save training request");
    expect(edited.strength).toBe(FLY_EDITED_SAVE_STRENGTH);
    expect(FLY_EDITED_SAVE_STRENGTH).toBeGreaterThan(FLY_IMPLICIT_KEEP_STRENGTH);

    useFlyTribunalStore.getState().applySettings({ ...useFlyTribunalStore.getState().settings, trainingEnabled: false });
    expect(wiring.train("must not learn", "PPL1", 0.5)).toBe(false);
    expect(worker.requests.filter((request) => request.type === "train")).toHaveLength(1);
    wiring.stop();
  });

  test("debounced export persists one confirmed precedent and amnesty clears the scope", async () => {
    enableTribunal();
    const worker = new FakeWorker();
    const timer = new FakeTimer();
    const putBodies: unknown[] = [];
    const snapshot = makeSnapshot(assistantMessage("m1", 0, [{ variantIndex: 0, content: "violet lantern", isSelected: true }]));
    const wiring = new FlyTribunalWiring({
      createWorker: () => worker,
      loadCachedBrain: async () => readyBrain(),
      fetchPrecedentCount: async () => 25,
      putMemory: async (memory) => { putBodies.push(memory); },
      timer,
      now: () => 1_000,
      snapshot,
      store: useFlyTribunalStore,
    });

    await wiring.start();
    worker.emit({ type: "loaded", id: 0, neuronCount: 1, edgeCount: 1 });
    expect(wiring.train("violet lantern", "PPL1", 0.5)).toBe(true);
    const training = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "train" }> => request.type === "train");
    if (training === undefined) throw new Error("expected direct training request");
    worker.emit({ type: "trained", id: training.id, result: evaluation() });
    timer.flush();
    const exportRequest = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "export-memory" }> => request.type === "export-memory");
    if (exportRequest === undefined) throw new Error("expected debounced export request");
    worker.emit({ type: "memory-exported", id: exportRequest.id, schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION, weights: "H4sIAAAAAAAA/2NgYGBgAgAAAP//AwAV6QEAAAA=" });
    await Promise.resolve();
    expect(putBodies).toEqual([
      {
        scope: "chat",
        chatId: "chat_1",
        schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
        precedentCount: 26,
        weights: "H4sIAAAAAAAA/2NgYGBgAgAAAP//AwAV6QEAAAA=",
      },
    ]);

    expect(wiring.grantAmnesty()).toBe(true);
    const reset = worker.requests.find((request): request is Extract<FlyWorkerRequest, { type: "reset-weights" }> => request.type === "reset-weights");
    if (reset === undefined) throw new Error("expected amnesty reset request");
    worker.emit({ type: "weights-reset", id: reset.id });
    await Promise.resolve();
    expect(useFlyTribunalStore.getState().precedentCount).toBe(0);
    expect(useFlyTribunalStore.getState().consumeJustFellSilent()).toBe(true);
    expect(putBodies).toEqual([
      {
        scope: "chat",
        chatId: "chat_1",
        schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
        precedentCount: 26,
        weights: "H4sIAAAAAAAA/2NgYGBgAgAAAP//AwAV6QEAAAA=",
      },
      {
        scope: "chat",
        chatId: "chat_1",
        schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
        precedentCount: 0,
        weights: null,
      },
    ]);
    wiring.stop();
  });
});
