import {
  flyMemoryGetResponseSchema,
  type FlyMemoryScope,
} from "@vibe-tavern/api-contracts";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import {
  useFlyTribunalStore,
  type FlyTribunalStore,
  type FlyWorkerClient,
} from "../../stores/fly-tribunal-store.js";
import { getSharedFlyWorker } from "./fly-client-instance.js";
import { loadCachedFlyBrain, type FlyBrainLoadState } from "./fly-brain-download.js";
import type { FlyDanCluster } from "./fly-engine-core.js";
import type { FlyWorkerRequest, FlyWorkerResponse } from "./fly-worker.js";

/**
 * Runtime wiring for Fly Tribunal (FLY_TRIBUNAL_PLAN FT-11).
 *
 * Lifecycle: AppShell starts this singleton only while the persisted tribunal
 * setting is enabled AND FT-9 has confirmed a cached brain. It owns the raw
 * Worker conversation; the FT-8 Zustand store remains a dumb UI sink.
 *
 * Chat seams, intentionally read-only:
 * - assistant landing and saved manual/AI edits call `syncSnapshot()`, which
 *   changes `messagesById` and notifies this public Zustand subscription;
 * - an optimistic swipe calls the existing `snapshotStore.selectVariant()`,
 *   which changes the shown variant and likewise notifies this subscription.
 * No snapshot-store action or canonical state is changed here.
 */

export interface FlyTribunalSnapshotVariant {
  variantIndex: number;
  content: string;
  isSelected?: boolean;
}

export interface FlyTribunalSnapshotMessage {
  id: string;
  role: string;
  content: string;
  selectedVariantIndex: number | null;
  variants: FlyTribunalSnapshotVariant[];
}

export interface FlyTribunalSnapshotState {
  activeChat: { id: string } | null;
  messageOrder: string[];
  messagesById: Record<string, FlyTribunalSnapshotMessage>;
}

export interface FlyTribunalSnapshotSource {
  getState: () => FlyTribunalSnapshotState;
  subscribe: (listener: () => void) => () => void;
}

/** Worker subset needed by the wiring module; tests provide a local fake. */
export interface FlyTribunalWorker extends FlyWorkerClient {
  addEventListener: (type: "message", listener: EventListener) => void;
  removeEventListener: (type: "message", listener: EventListener) => void;
}

export interface FlyTribunalWiringDeps {
  createWorker: () => FlyTribunalWorker;
  loadCachedBrain: () => Promise<FlyBrainLoadState>;
  fetchPrecedentCount: (scope: FlyMemoryScope, chatId?: string) => Promise<number>;
  snapshot: FlyTribunalSnapshotSource;
  store: { getState: () => FlyTribunalStore };
}

const defaultSnapshotSource: FlyTribunalSnapshotSource = {
  getState: () => useSnapshotStore.getState(),
  subscribe: (listener) => useSnapshotStore.subscribe(listener),
};

const defaultDeps: FlyTribunalWiringDeps = {
  createWorker: createDefaultFlyWorker,
  loadCachedBrain: () => loadCachedFlyBrain(),
  fetchPrecedentCount: fetchFlyPrecedentCount,
  snapshot: defaultSnapshotSource,
  store: useFlyTribunalStore,
};

type EvaluationTarget = {
  messageId: string;
  variantIndex: number;
  fingerprint: string;
};

/**
 * A single enabled-and-ready tribunal session. `start()` loads only a
 * sha-verified Cache API brain (FT-6); it never downloads at message time.
 */
export class FlyTribunalWiring {
  private worker: FlyTribunalWorker | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private started = false;
  private brainLoaded = false;
  private lifecycleId = 0;
  private requestId = 1;
  private memoryKey: string | null = null;
  private readonly lastFingerprintByVariant = new Map<string, string>();
  private readonly evaluationsByRequestId = new Map<number, EvaluationTarget>();
  private readonly trainingRequestIds = new Set<number>();

  constructor(private readonly deps: FlyTribunalWiringDeps = defaultDeps) {}

  /** Start after AppShell has established enabled + cached-brain readiness. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const lifecycleId = ++this.lifecycleId;
    const brain = await this.deps.loadCachedBrain();
    if (!this.started || lifecycleId !== this.lifecycleId) return;
    if (brain.status !== "ready") {
      this.started = false;
      return;
    }

    const worker = this.deps.createWorker();
    this.worker = worker;
    worker.addEventListener("message", this.handleWorkerMessage);
    this.deps.store.getState().attachWorkerClient(worker);
    this.unsubscribeSnapshot = this.deps.snapshot.subscribe(this.observeSnapshot);

    const bytes = copyExactArrayBuffer(brain.bytes);
    worker.postMessage(
      { type: "load", id: 0, bytes, manifest: { types: brain.manifest.types } },
      [bytes],
    );
    await this.hydratePrecedentCount();
  }

  /** Stop listeners and release the loaded worker brain; snapshot data stays untouched. */
  stop(): void {
    if (!this.started && this.worker === null) return;
    this.started = false;
    this.brainLoaded = false;
    this.lifecycleId += 1;
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    if (this.worker !== null) {
      this.worker.removeEventListener("message", this.handleWorkerMessage);
      this.worker.postMessage({ type: "dispose" });
    }
    if (this.deps.store.getState().workerClient === this.worker) {
      this.deps.store.getState().attachWorkerClient(null);
    }
    this.deps.store.getState().clearDerivedVerdicts();
    this.worker = null;
    this.memoryKey = null;
    this.lastFingerprintByVariant.clear();
    this.evaluationsByRequestId.clear();
    this.trainingRequestIds.clear();
  }

  /**
   * FT-12 calls this seam only after a confirmed training event. This unit
   * never invokes it itself; the worker's `trained` acknowledgement is what
   * ticks the precedent counter and starts the training animation.
   */
  train(text: string, danCluster: FlyDanCluster, strength: number): boolean {
    if (!this.brainLoaded || this.worker === null || !text.trim()) return false;
    const id = this.nextId();
    this.trainingRequestIds.add(id);
    this.worker.postMessage({ type: "train", id, text, danCluster, strength });
    return true;
  }

  /** Public test/future seam; normal callers rely on the snapshot subscription. */
  evaluateShownAssistantVariant(message: FlyTribunalSnapshotMessage): boolean {
    if (!this.started || !this.brainLoaded || this.worker === null) return false;
    if (message.role !== "assistant" || !this.deps.store.getState().settings.enabled) return false;
    const variant = activeVariant(message);
    if (variant === null || !variant.content.trim()) return false;

    const key = verdictKey(message.id, variant.variantIndex);
    const fingerprint = textFingerprint(variant.content);
    if (this.lastFingerprintByVariant.get(key) === fingerprint) return false;

    const id = this.nextId();
    this.lastFingerprintByVariant.set(key, fingerprint);
    this.evaluationsByRequestId.set(id, {
      messageId: message.id,
      variantIndex: variant.variantIndex,
      fingerprint,
    });
    this.worker.postMessage({ type: "evaluate", id, text: variant.content });
    return true;
  }

  private readonly observeSnapshot = (): void => {
    if (!this.started) return;
    void this.hydratePrecedentCount();
    if (!this.brainLoaded) return;
    const snapshot = this.deps.snapshot.getState();
    for (const messageId of snapshot.messageOrder) {
      const message = snapshot.messagesById[messageId];
      if (message !== undefined) this.evaluateShownAssistantVariant(message);
    }
  };

  private readonly handleWorkerMessage: EventListener = (event): void => {
    const response = (event as MessageEvent<FlyWorkerResponse>).data;
    if (response.type === "loaded") {
      this.brainLoaded = true;
      this.observeSnapshot();
      return;
    }
    if (response.type === "evaluated") {
      const target = this.evaluationsByRequestId.get(response.id);
      if (target === undefined) return;
      this.evaluationsByRequestId.delete(response.id);
      if (this.lastFingerprintByVariant.get(verdictKey(target.messageId, target.variantIndex)) !== target.fingerprint) {
        return;
      }
      this.deps.store.getState().recordEvaluation(target.messageId, target.variantIndex, response.result);
      return;
    }
    if (response.type === "trained" && response.id !== undefined && this.trainingRequestIds.delete(response.id)) {
      this.deps.store.getState().recordPrecedent();
      return;
    }
    if (response.type === "error" && response.id !== undefined) {
      const target = this.evaluationsByRequestId.get(response.id);
      if (target !== undefined) {
        this.evaluationsByRequestId.delete(response.id);
        const key = verdictKey(target.messageId, target.variantIndex);
        if (this.lastFingerprintByVariant.get(key) === target.fingerprint) {
          this.lastFingerprintByVariant.delete(key);
        }
      }
      this.trainingRequestIds.delete(response.id);
    }
  };

  private async hydratePrecedentCount(): Promise<void> {
    const snapshot = this.deps.snapshot.getState();
    const settings = this.deps.store.getState().settings;
    const chatId = snapshot.activeChat?.id;
    if (settings.memoryScope === "chat" && chatId === undefined) return;
    const key = settings.memoryScope === "chat" ? `chat:${chatId}` : "global";
    if (this.memoryKey === key) return;
    this.memoryKey = key;

    try {
      const precedentCount = await this.deps.fetchPrecedentCount(settings.memoryScope, chatId);
      const currentSnapshot = this.deps.snapshot.getState();
      const currentSettings = this.deps.store.getState().settings;
      const currentKey = currentSettings.memoryScope === "chat"
        ? currentSnapshot.activeChat === null ? null : `chat:${currentSnapshot.activeChat.id}`
        : "global";
      if (this.started && currentKey === key) {
        this.deps.store.getState().setPrecedentCount(precedentCount);
      }
    } catch (error) {
      // A memory GET failure leaves the existing UI counter intact; settings
      // load errors already surface separately and this must never stop chat.
      console.warn("Fly Tribunal precedent memory hydration failed.", error);
    }
  }

  private nextId(): number {
    const id = this.requestId;
    this.requestId += 1;
    return id;
  }
}

let appWiring: FlyTribunalWiring | null = null;

/** AppShell's enabled-and-ready effect starts the one app-lifetime wiring session. */
export function startFlyTribunalWiring(): Promise<void> {
  if (appWiring === null) appWiring = new FlyTribunalWiring();
  return appWiring.start();
}

/** AppShell cleanup on disable, cached-brain removal, scope change, or unmount. */
export function stopFlyTribunalWiring(): void {
  appWiring?.stop();
  appWiring = null;
}

function activeVariant(message: FlyTribunalSnapshotMessage): FlyTribunalSnapshotVariant | null {
  if (message.variants.length === 0) {
    return message.content ? { variantIndex: 0, content: message.content } : null;
  }
  if (message.selectedVariantIndex !== null) {
    const selected = message.variants.find((variant) => variant.variantIndex === message.selectedVariantIndex);
    if (selected !== undefined) return selected;
  }
  return message.variants.find((variant) => variant.isSelected) ?? message.variants[0] ?? null;
}

function verdictKey(messageId: string, variantIndex: number): string {
  return JSON.stringify([messageId, variantIndex]);
}

/** Non-cryptographic FNV-1a fingerprint: dedupe only, never a security boundary. */
function textFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function copyExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Adapt the browser's overloaded Worker API to the narrower store/test seam. */
function createDefaultFlyWorker(): FlyTribunalWorker {
  const worker = getSharedFlyWorker();
  return {
    postMessage: (request, transfer) => {
      if (transfer === undefined) worker.postMessage(request);
      else worker.postMessage(request, transfer);
    },
    addEventListener: (type, listener) => worker.addEventListener(type, listener),
    removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
  };
}

async function fetchFlyPrecedentCount(scope: FlyMemoryScope, chatId?: string): Promise<number> {
  const query = scope === "chat" && chatId !== undefined
    ? `?${new URLSearchParams({ chatId }).toString()}`
    : "";
  const response = await fetch(`/api/fly/memory/${scope}${query}`);
  if (!response.ok) throw new Error(`Fly Tribunal memory request failed with HTTP ${response.status}.`);
  return flyMemoryGetResponseSchema.parse(await response.json()).precedentCount;
}
