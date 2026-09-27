import {
  FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
  flyMemoryGetResponseSchema,
  type FlyMemoryGetResponse,
  type FlyMemoryPut,
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

export interface FlyTribunalTimer {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface FlyTribunalWiringDeps {
  createWorker: () => FlyTribunalWorker;
  loadCachedBrain: () => Promise<FlyBrainLoadState>;
  /** Legacy count-only seam retained for FT-11 test fixtures. */
  fetchPrecedentCount: (scope: FlyMemoryScope, chatId?: string) => Promise<number>;
  /** FT-12 full memory seam: weights + count hydrate before the first evaluation. */
  fetchMemory?: (scope: FlyMemoryScope, chatId?: string) => Promise<FlyMemoryGetResponse>;
  putMemory?: (memory: FlyMemoryPut) => Promise<void>;
  now?: () => number;
  timer?: FlyTribunalTimer;
  snapshot: FlyTribunalSnapshotSource;
  store: { getState: () => FlyTribunalStore };
}

const defaultSnapshotSource: FlyTribunalSnapshotSource = {
  getState: () => useSnapshotStore.getState(),
  subscribe: (listener) => useSnapshotStore.subscribe(listener),
};

const defaultTimer: FlyTribunalTimer = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle as number),
};

const defaultDeps: FlyTribunalWiringDeps = {
  createWorker: createDefaultFlyWorker,
  loadCachedBrain: () => loadCachedFlyBrain(),
  fetchPrecedentCount: fetchFlyPrecedentCount,
  fetchMemory: fetchFlyMemory,
  putMemory: putFlyMemory,
  now: () => Date.now(),
  timer: defaultTimer,
  snapshot: defaultSnapshotSource,
  store: useFlyTribunalStore,
};

/** Named training strengths: edit-save is three times an implicit keep. */
export const FLY_IMPLICIT_KEEP_STRENGTH = 0.25;
export const FLY_EDITED_SAVE_STRENGTH = FLY_IMPLICIT_KEEP_STRENGTH * 3;
export const FLY_REJECTED_STRENGTH = 0.5;
export const FLY_MEMORY_PERSIST_DEBOUNCE_MS = 400;

type EvaluationTarget = {
  messageId: string;
  variantIndex: number;
  fingerprint: string;
};

type TrainingObservation = {
  variantIndex: number;
  content: string;
  fingerprint: string;
  departed: Map<number, string>;
  settled: boolean;
};

type FlyMemoryContext = {
  key: string;
  scope: FlyMemoryScope;
  chatId?: string;
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
  private readonly trainingByMessageId = new Map<string, TrainingObservation>();
  private readonly seenUserMessageIds = new Set<string>();
  private readonly memoryExportContexts = new Map<number, FlyMemoryContext>();
  private readonly amnestyContexts = new Map<number, FlyMemoryContext>();
  private readonly lastPersistedAtByMemoryKey = new Map<string, number>();
  private persistenceTimer: unknown = null;
  private trainingPrimed = false;

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

    const memory = await this.hydrateMemory();
    if (!this.started || lifecycleId !== this.lifecycleId) return;

    const worker = this.deps.createWorker();
    this.worker = worker;
    worker.addEventListener("message", this.handleWorkerMessage);
    this.deps.store.getState().attachWorkerClient(worker);
    this.unsubscribeSnapshot = this.deps.snapshot.subscribe(this.observeSnapshot);

    const bytes = copyExactArrayBuffer(brain.bytes);
    worker.postMessage(
      {
        type: "load",
        id: 0,
        bytes,
        manifest: { types: brain.manifest.types },
        memory: memory === undefined ? undefined : {
          schemaVersion: memory.schemaVersion,
          weights: memory.weights,
          updatedAt: memory.updatedAt,
          lifetimeDays: this.deps.store.getState().settings.precedentLifetimeDays,
          nowMs: this.now(),
        },
      },
      [bytes],
    );
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
    this.trainingByMessageId.clear();
    this.seenUserMessageIds.clear();
    this.memoryExportContexts.clear();
    this.amnestyContexts.clear();
    this.lastPersistedAtByMemoryKey.clear();
    this.trainingPrimed = false;
    if (this.persistenceTimer !== null) {
      this.timer().clear(this.persistenceTimer);
      this.persistenceTimer = null;
    }
  }

  /**
   * FT-12 calls this seam only after a confirmed training event. This unit
   * never invokes it itself; the worker's `trained` acknowledgement is what
   * ticks the precedent counter and starts the training animation.
   */
  train(text: string, danCluster: FlyDanCluster, strength: number): boolean {
    if (!this.deps.store.getState().settings.trainingEnabled) return false;
    return this.submitTraining([{ text, danCluster, strength }]);
  }

  /** Reset worker weights, persist the fresh baseline, then re-silence the UI. */
  grantAmnesty(): boolean {
    if (this.worker === null || !this.brainLoaded) return false;
    const context = this.memoryContext();
    if (context === null) return false;
    const id = this.nextId();
    this.amnestyContexts.set(id, context);
    this.worker.postMessage({ type: "reset-weights", id });
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
    void this.hydrateMemory();
    if (!this.brainLoaded) return;
    const snapshot = this.deps.snapshot.getState();
    this.observeTraining(snapshot);
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
      this.schedulePersistence();
      return;
    }
    if (response.type === "memory-exported") {
      const context = this.memoryExportContexts.get(response.id);
      this.memoryExportContexts.delete(response.id);
      if (context !== undefined) void this.persistExportedMemory(context, response.schemaVersion, response.weights);
      return;
    }
    if (response.type === "weights-reset" && response.id !== undefined) {
      const context = this.amnestyContexts.get(response.id);
      this.amnestyContexts.delete(response.id);
      if (context !== undefined) {
        this.deps.store.getState().resetForAmnesty();
        void this.persistMemory(context, FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION, null, 0);
      }
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

  /**
   * Read the current scope once. On boot the returned payload is threaded into
   * the worker's load request before it emits `loaded`; later snapshot churn
   * is a no-op until the chat/scope key changes.
   */
  private async hydrateMemory(): Promise<FlyMemoryGetResponse | undefined> {
    const context = this.memoryContext();
    if (context === null || this.memoryKey === context.key) return undefined;
    this.memoryKey = context.key;

    try {
      const fetched = this.deps.fetchMemory === undefined
        ? {
          scope: context.scope,
          ...(context.chatId === undefined ? {} : { chatId: context.chatId }),
          schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
          precedentCount: await this.deps.fetchPrecedentCount(context.scope, context.chatId),
          weights: null,
          updatedAt: "",
        }
        : await this.deps.fetchMemory(context.scope, context.chatId);
      // Owner-approved full memory reset (hybrid calibration, FT-17): a stale
      // schema row hydrates as a fresh fly — zero weights, zero precedents —
      // and is immediately rewritten as an empty current-version row.
      const staleSchema = fetched.schemaVersion !== FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION;
      const memory = staleSchema
        ? {
          ...fetched,
          schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
          precedentCount: 0,
          weights: null,
          updatedAt: "",
        }
        : fetched;
      const current = this.memoryContext();
      if (this.started && current?.key === context.key) {
        this.deps.store.getState().setPrecedentCount(memory.precedentCount);
        const persistedAt = Date.parse(memory.updatedAt);
        if (Number.isFinite(persistedAt)) this.lastPersistedAtByMemoryKey.set(context.key, persistedAt);
        if (staleSchema) void this.persistMemory(context, FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION, null, 0);
        // Scope/chat switches retain the same worker instance: replace its
        // learned field before the next snapshot-driven evaluation.
        if (this.brainLoaded && this.worker !== null) {
          this.worker.postMessage({
            type: "import-memory",
            id: this.nextId(),
            memory: {
              schemaVersion: memory.schemaVersion,
              weights: memory.weights,
              updatedAt: memory.updatedAt,
              lifetimeDays: this.deps.store.getState().settings.precedentLifetimeDays,
              nowMs: this.now(),
            },
          });
        }
        return memory;
      }
    } catch (error) {
      // A memory GET failure leaves the existing UI counter intact; it must
      // never stop chat generation or turn a cache miss into a crash.
      console.warn("Fly Tribunal precedent memory hydration failed.", error);
    }
    return undefined;
  }

  /**
   * Read-only event grammar: selection changes collect departed variants;
   * the NEXT user message settles that chain and emits one contrastive batch.
   * First subscription observation only seeds history, never retrains it.
   * A content change on an already historical assistant message is the
   * strongest edit-save signal available without adding snapshot-store events.
   */
  private observeTraining(snapshot: FlyTribunalSnapshotState): void {
    const ordered = snapshot.messageOrder
      .map((id) => snapshot.messagesById[id])
      .filter((message): message is FlyTribunalSnapshotMessage => message !== undefined);
    if (!this.trainingPrimed) {
      for (const message of ordered) {
        if (message.role === "user") this.seenUserMessageIds.add(message.id);
        if (message.role === "assistant") this.seedTrainingObservation(message);
      }
      this.trainingPrimed = true;
      return;
    }

    for (let position = 0; position < ordered.length; position += 1) {
      const message = ordered[position]!;
      if (message.role !== "assistant") continue;
      const variant = activeVariant(message);
      if (variant === null) continue;
      const fingerprint = textFingerprint(variant.content);
      const existing = this.trainingByMessageId.get(message.id);
      if (existing === undefined) {
        this.trainingByMessageId.set(message.id, {
          variantIndex: variant.variantIndex,
          content: variant.content,
          fingerprint,
          departed: new Map(),
          settled: false,
        });
        continue;
      }
      if (existing.variantIndex !== variant.variantIndex) {
        existing.departed.set(existing.variantIndex, existing.content);
        existing.variantIndex = variant.variantIndex;
        existing.content = variant.content;
        existing.fingerprint = fingerprint;
        existing.settled = false;
        continue;
      }
      if (existing.fingerprint !== fingerprint) {
        existing.content = variant.content;
        existing.fingerprint = fingerprint;
        // A non-terminal assistant changed after it was already observed: the
        // only read-only signature of a saved manual/AI edit. Latest-message
        // streaming is intentionally not mistaken for an edit here.
        if (position < ordered.length - 1 && this.submitTraining([
          { text: variant.content, danCluster: "PAM", strength: FLY_EDITED_SAVE_STRENGTH },
        ])) {
          // The edit itself is the confirmed choice. When its following user
          // turn appears in this same snapshot, do not double-count it as an
          // additional implicit-continuation precedent.
          existing.settled = true;
        }
      }
    }

    for (let position = 0; position < ordered.length; position += 1) {
      const message = ordered[position]!;
      if (message.role !== "user" || this.seenUserMessageIds.has(message.id)) continue;
      this.seenUserMessageIds.add(message.id);
      const prior = ordered.slice(0, position).reverse().find((candidate) => candidate.role === "assistant");
      if (prior === undefined) continue;
      const observation = this.trainingByMessageId.get(prior.id);
      if (observation === undefined || observation.settled) continue;
      const events = [
        ...[...observation.departed.values()].map((text) => ({ text, danCluster: "PPL1" as const, strength: FLY_REJECTED_STRENGTH })),
        { text: observation.content, danCluster: "PAM" as const, strength: FLY_IMPLICIT_KEEP_STRENGTH },
      ];
      if (this.submitTraining(events)) observation.settled = true;
    }
  }

  private seedTrainingObservation(message: FlyTribunalSnapshotMessage): void {
    const variant = activeVariant(message);
    if (variant === null) return;
    this.trainingByMessageId.set(message.id, {
      variantIndex: variant.variantIndex,
      content: variant.content,
      fingerprint: textFingerprint(variant.content),
      departed: new Map(),
      settled: false,
    });
  }

  private submitTraining(events: Array<{ text: string; danCluster: FlyDanCluster; strength: number }>): boolean {
    if (!this.deps.store.getState().settings.trainingEnabled || !this.brainLoaded || this.worker === null) return false;
    const validEvents = events.filter((event) => event.text.trim().length > 0);
    if (validEvents.length === 0) return false;
    const id = this.nextId();
    this.trainingRequestIds.add(id);
    this.worker.postMessage(validEvents.length === 1
      ? { type: "train", id, ...validEvents[0]! }
      : { type: "train-batch", id, events: validEvents });
    return true;
  }

  private schedulePersistence(): void {
    if (this.deps.putMemory === undefined || this.worker === null) return;
    if (this.persistenceTimer !== null) this.timer().clear(this.persistenceTimer);
    this.persistenceTimer = this.timer().set(() => {
      this.persistenceTimer = null;
      const context = this.memoryContext();
      if (context === null || this.worker === null) return;
      const id = this.nextId();
      this.memoryExportContexts.set(id, context);
      const lastPersistedAt = this.lastPersistedAtByMemoryKey.get(context.key) ?? this.now();
      this.worker.postMessage({
        type: "export-memory",
        id,
        elapsedMs: Math.max(0, this.now() - lastPersistedAt),
        lifetimeDays: this.deps.store.getState().settings.precedentLifetimeDays,
      });
    }, FLY_MEMORY_PERSIST_DEBOUNCE_MS);
  }

  private async persistExportedMemory(context: FlyMemoryContext, schemaVersion: number, weights: string): Promise<void> {
    await this.persistMemory(context, schemaVersion, weights, this.deps.store.getState().precedentCount);
  }

  private async persistMemory(context: FlyMemoryContext, schemaVersion: number, weights: string | null, precedentCount: number): Promise<void> {
    if (this.deps.putMemory === undefined || this.memoryContext()?.key !== context.key) return;
    try {
      await this.deps.putMemory({
        scope: context.scope,
        ...(context.chatId === undefined ? {} : { chatId: context.chatId }),
        schemaVersion,
        precedentCount,
        weights,
      });
      this.lastPersistedAtByMemoryKey.set(context.key, this.now());
    } catch (error) {
      console.warn("Fly Tribunal memory persistence failed.", error);
    }
  }

  private memoryContext(): FlyMemoryContext | null {
    const snapshot = this.deps.snapshot.getState();
    const scope = this.deps.store.getState().settings.memoryScope;
    if (scope === "chat") {
      if (snapshot.activeChat === null) return null;
      return { key: `chat:${snapshot.activeChat.id}`, scope, chatId: snapshot.activeChat.id };
    }
    return { key: "global", scope };
  }

  private now(): number {
    return (this.deps.now ?? (() => Date.now()))();
  }

  private timer(): FlyTribunalTimer {
    return this.deps.timer ?? defaultTimer;
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

/**
 * FT-9 modal handler. A live session resets its worker first; when disabled
 * there is no worker to reset, so clear the current persisted scope directly.
 */
export function grantFlyTribunalAmnesty(): boolean {
  if (appWiring?.grantAmnesty() === true) return true;
  const settings = useFlyTribunalStore.getState().settings;
  const chatId = useSnapshotStore.getState().activeChat?.id;
  if (settings.memoryScope === "chat" && chatId === undefined) return false;
  useFlyTribunalStore.getState().resetForAmnesty();
  void putFlyMemory({
    scope: settings.memoryScope,
    ...(settings.memoryScope === "chat" ? { chatId } : {}),
    schemaVersion: FLY_TRIBUNAL_MEMORY_SCHEMA_VERSION,
    precedentCount: 0,
    weights: null,
  }).catch((error: unknown) => {
    console.warn("Fly Tribunal inactive amnesty persistence failed.", error);
  });
  return true;
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
  return (await fetchFlyMemory(scope, chatId)).precedentCount;
}

async function fetchFlyMemory(scope: FlyMemoryScope, chatId?: string): Promise<FlyMemoryGetResponse> {
  const query = scope === "chat" && chatId !== undefined
    ? `?${new URLSearchParams({ chatId }).toString()}`
    : "";
  const response = await fetch(`/api/fly/memory/${scope}${query}`);
  if (!response.ok) throw new Error(`Fly Tribunal memory request failed with HTTP ${response.status}.`);
  return flyMemoryGetResponseSchema.parse(await response.json());
}

async function putFlyMemory(memory: FlyMemoryPut): Promise<void> {
  const response = await fetch(`/api/fly/memory/${memory.scope}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(memory),
  });
  if (!response.ok) throw new Error(`Fly Tribunal memory update failed with HTTP ${response.status}.`);
  flyMemoryGetResponseSchema.parse(await response.json());
}
