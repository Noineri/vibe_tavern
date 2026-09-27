import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { FlyBrainManifest } from "@vibe-tavern/api-contracts";
import {
  selectFlyVerdict,
  useFlyTribunalStore,
} from "../../stores/fly-tribunal-store.js";
import type { FlyEvaluation } from "./fly-engine-core.js";
import {
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
});
