import { AGENT_EVENT_DETAIL_CACHE_MAX_BYTES, AGENT_EVENT_DETAIL_CACHE_MAX_ENTRIES, type AgentEventDetailResponse } from "@vibe-tavern/api-contracts";
import { AgentFeedStaleError, type getAgentEventDetail } from "../../../api/agent-feed-api.js";

export interface AgentEventDetailKey {
  threadId: string;
  eventId: string;
  epoch: number;
  cursor?: string;
}
export interface AgentEventDetailSnapshot {
  status: "loading" | "ready" | "error";
  page?: AgentEventDetailResponse;
  error?: unknown;
}
interface Entry {
  snapshot: AgentEventDetailSnapshot;
  listeners: Set<() => void>;
  bytes: number;
}
const LOADING: AgentEventDetailSnapshot = Object.freeze({ status: "loading" });
export function agentEventDetailKey(key: AgentEventDetailKey): string {
  return JSON.stringify([key.threadId, key.eventId, key.epoch, key.cursor ?? null]);
}

/** One bounded cache of page references, not copied payload arrays. Active
 * pages may exceed the retention budget; only unobserved pages are evictable,
 * and oversized pages leave immediately after their last observer releases. */
export function createAgentEventDetailCache(options: { maxEntries?: number; maxBytes?: number } = {}) {
  const maxEntries = options.maxEntries ?? AGENT_EVENT_DETAIL_CACHE_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? AGENT_EVENT_DETAIL_CACHE_MAX_BYTES;
  const entries = new Map<string, Entry>(); // insertion order = LRU
  const retained = () => [...entries.values()].filter(e => e.listeners.size === 0);
  const trim = () => {
    for (const [id, entry] of entries) {
      if (entry.listeners.size > 0) continue;
      const all = [...entries.values()];
      if (entry.snapshot.status !== "ready" || entry.bytes > maxBytes || all.length > maxEntries
        || all.reduce((sum, e) => sum + e.bytes, 0) > maxBytes) entries.delete(id);
    }
  };
  const emit = (entry: Entry) => { for (const listener of entry.listeners) listener(); };
  const start = (key: AgentEventDetailKey, entry: Entry, load: typeof getAgentEventDetail) => {
    const id = agentEventDetailKey(key);
    entry.snapshot = LOADING;
    entry.bytes = 0;
    emit(entry);
    // Promise.resolve().then also contains a synchronous custom-transport throw.
    void Promise.resolve().then(() => load(key.threadId, key.eventId, key.cursor)).then(page => {
      if (entries.get(id) !== entry) return;
      if (page.threadId !== key.threadId || page.eventId !== key.eventId) throw new Error("Foreign agent event detail response");
      if (page.epoch !== key.epoch) throw new AgentFeedStaleError("Agent event detail version changed", "AGENT_EVENT_CURSOR_STALE", page.epoch);
      entry.snapshot = { status: "ready", page };
      entry.bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
      emit(entry);
      trim();
    }).catch((error: unknown) => {
      if (entries.get(id) !== entry) return;
      entry.snapshot = { status: "error", error };
      entry.bytes = 0;
      emit(entry);
      trim();
    });
  };
  return {
    getSnapshot(key: AgentEventDetailKey): AgentEventDetailSnapshot {
      return entries.get(agentEventDetailKey(key))?.snapshot ?? LOADING;
    },
    subscribe(key: AgentEventDetailKey, load: typeof getAgentEventDetail, listener: () => void): () => void {
      const id = agentEventDetailKey(key);
      let entry = entries.get(id);
      const fresh = entry === undefined;
      if (!entry) entry = { snapshot: LOADING, listeners: new Set(), bytes: 0 };
      entries.delete(id); entries.set(id, entry);
      entry.listeners.add(listener);
      if (fresh) start(key, entry, load);
      const observed = entry;
      return () => {
        observed.listeners.delete(listener);
        if (entries.get(id) === observed) trim();
      };
    },
    retry(key: AgentEventDetailKey, load: typeof getAgentEventDetail): void {
      const entry = entries.get(agentEventDetailKey(key));
      if (entry?.snapshot.status === "error") start(key, entry, load);
    },
    stats() {
      const inactive = retained();
      return { entries: entries.size, retainedEntries: inactive.length,
        retainedBytes: inactive.reduce((sum, e) => sum + e.bytes, 0) };
    },
  };
}
export type AgentEventDetailCache = ReturnType<typeof createAgentEventDetailCache>;
export const agentEventDetailCache = createAgentEventDetailCache();
