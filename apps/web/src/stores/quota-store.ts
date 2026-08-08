/**
 * Per-provider-profile quota state.
 *
 * This store is the whole frontend surface of the quota feature: there is no
 * visual UI yet, by design. Everything a later panel needs — per-window used
 * percentage and reset time, balances, the three toggles, the last poll error —
 * is here behind selectors, so building the UI is a rendering job rather than a
 * data-plumbing one.
 *
 * Freshness comes from two independent sources: an explicit `fetchQuota` (on
 * open / after a config write) and the global SSE channel, which pushes the
 * notification events. Events carry the numbers that triggered them, so an open
 * panel updates the affected window without a refetch.
 */

import { create } from "zustand";
import type {
  ProviderQuotaCapabilityRecord,
  ProviderQuotaRecord,
} from "@vibe-tavern/api-contracts";
import {
  PROVIDER_QUOTA_KIND,
  type ProviderBalanceAmount,
  type ProviderQuotaConfig,
  type ProviderQuotaErrorKind,
  type ProviderQuotaEvent,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
} from "@vibe-tavern/domain";
import { fetchQuota, fetchQuotaCapability, updateQuotaConfig } from "../api/quota-api.js";

export type QuotaLoadStatus = "idle" | "loading" | "error" | "success";

/** Connection state of the global quota SSE channel. */
export type QuotaStreamState = "closed" | "connecting" | "open" | "error";

export interface QuotaProfileEntry {
  status: QuotaLoadStatus;
  capability: ProviderQuotaCapabilityRecord | null;
  config: ProviderQuotaConfig | null;
  snapshot: ProviderQuotaSnapshot | null;
  /** The provider's last poll failure, or null when the last poll succeeded. */
  lastError: ProviderQuotaErrorKind | null;
  /** Failure of OUR request to the backend — unrelated to `lastError`. */
  loadError: string | null;
  updatedAt: string | null;
}

interface QuotaState {
  entries: Record<string, QuotaProfileEntry>;
  streamState: QuotaStreamState;
  /** Event ids already applied, so an SSE replay after a reconnect is inert. */
  seenEventIds: string[];

  fetchCapability: (providerProfileId: string) => Promise<void>;
  fetchQuota: (providerProfileId: string) => Promise<void>;
  updateConfig: (providerProfileId: string, config: ProviderQuotaConfig) => Promise<void>;
  /** Apply an SSE event. Returns false when it was a duplicate (do not toast). */
  ingestQuotaEvent: (event: ProviderQuotaEvent) => boolean;
  setStreamState: (state: QuotaStreamState) => void;
  reset: () => void;
}

const EMPTY_ENTRY: QuotaProfileEntry = {
  status: "idle",
  capability: null,
  config: null,
  snapshot: null,
  lastError: null,
  loadError: null,
  updatedAt: null,
};

/** Bounded so a long session cannot grow the dedupe set without limit. */
const SEEN_EVENT_LIMIT = 200;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyRecord(entry: QuotaProfileEntry, record: ProviderQuotaRecord): QuotaProfileEntry {
  return {
    ...entry,
    status: "success",
    config: record.config,
    snapshot: record.snapshot,
    lastError: record.lastError,
    loadError: null,
    updatedAt: record.updatedAt,
  };
}

/**
 * Fold an event's numbers into the stored snapshot.
 *
 * Only the window the event names is touched, and only when the stored snapshot
 * is windowed and from the same adapter — an event that arrives after a preset
 * change describes a provider this entry no longer represents.
 */
function applyEventToSnapshot(
  snapshot: ProviderQuotaSnapshot | null,
  event: ProviderQuotaEvent,
): ProviderQuotaSnapshot | null {
  if (!snapshot || snapshot.kind !== PROVIDER_QUOTA_KIND.windowed) return snapshot;
  if (snapshot.capabilityId !== event.capabilityId) return snapshot;
  if (snapshot.observedAt > event.observedAt) return snapshot;

  const windows = snapshot.windows.map((window) => window.kind === event.windowKind
    ? { ...window, usedPercent: event.usedPercent, resetsAt: event.resetsAt }
    : window);

  return { ...snapshot, observedAt: event.observedAt, windows };
}

export const useQuotaStore = create<QuotaState>((set, get) => ({
  entries: {},
  streamState: "closed",
  seenEventIds: [],

  fetchCapability: async (providerProfileId) => {
    try {
      const capability = await fetchQuotaCapability(providerProfileId);
      set((state) => ({
        entries: {
          ...state.entries,
          [providerProfileId]: { ...(state.entries[providerProfileId] ?? EMPTY_ENTRY), capability },
        },
      }));
    } catch (error) {
      set((state) => ({
        entries: {
          ...state.entries,
          [providerProfileId]: {
            ...(state.entries[providerProfileId] ?? EMPTY_ENTRY),
            loadError: messageOf(error),
          },
        },
      }));
    }
  },

  fetchQuota: async (providerProfileId) => {
    set((state) => ({
      entries: {
        ...state.entries,
        [providerProfileId]: {
          ...(state.entries[providerProfileId] ?? EMPTY_ENTRY),
          status: "loading",
          loadError: null,
        },
      },
    }));

    try {
      const record = await fetchQuota(providerProfileId);
      set((state) => ({
        entries: {
          ...state.entries,
          [providerProfileId]: applyRecord(state.entries[providerProfileId] ?? EMPTY_ENTRY, record),
        },
      }));
    } catch (error) {
      set((state) => ({
        entries: {
          ...state.entries,
          [providerProfileId]: {
            ...(state.entries[providerProfileId] ?? EMPTY_ENTRY),
            status: "error",
            loadError: messageOf(error),
          },
        },
      }));
    }
  },

  updateConfig: async (providerProfileId, config) => {
    const record = await updateQuotaConfig(providerProfileId, config);
    set((state) => ({
      entries: {
        ...state.entries,
        [providerProfileId]: applyRecord(state.entries[providerProfileId] ?? EMPTY_ENTRY, record),
      },
    }));
  },

  ingestQuotaEvent: (event) => {
    if (get().seenEventIds.includes(event.eventId)) return false;

    set((state) => {
      const entry = state.entries[event.providerProfileId] ?? EMPTY_ENTRY;
      const seen = [...state.seenEventIds, event.eventId];
      return {
        seenEventIds: seen.length > SEEN_EVENT_LIMIT ? seen.slice(-SEEN_EVENT_LIMIT) : seen,
        entries: {
          ...state.entries,
          [event.providerProfileId]: {
            ...entry,
            snapshot: applyEventToSnapshot(entry.snapshot, event),
          },
        },
      };
    });
    return true;
  },

  setStreamState: (streamState) => set({ streamState }),

  reset: () => set({ entries: {}, streamState: "closed", seenEventIds: [] }),
}));

// ─── Selectors ──────────────────────────────────────────────────────────────

export function selectQuotaEntry(providerProfileId: string) {
  return (state: QuotaState): QuotaProfileEntry => state.entries[providerProfileId] ?? EMPTY_ENTRY;
}

/**
 * Windows for a profile, ready to render as gauges: each carries the used
 * percentage, the remaining percentage, and the ISO reset instant (null when
 * the window never resets).
 */
export function selectQuotaWindows(providerProfileId: string) {
  return (state: QuotaState): ReadonlyArray<ProviderQuotaWindow & { remainingPercent: number }> => {
    const snapshot = state.entries[providerProfileId]?.snapshot;
    if (!snapshot || snapshot.kind !== PROVIDER_QUOTA_KIND.windowed) return [];
    return snapshot.windows.map((window) => ({ ...window, remainingPercent: 100 - window.usedPercent }));
  };
}

/** Balances for a profile — windowed providers may carry them too. */
export function selectQuotaBalances(providerProfileId: string) {
  return (state: QuotaState): readonly ProviderBalanceAmount[] => {
    const snapshot = state.entries[providerProfileId]?.snapshot;
    if (!snapshot || snapshot.kind === PROVIDER_QUOTA_KIND.none) return [];
    return snapshot.balances ?? [];
  };
}

/** The single number a user thinks of as "my balance", or null. */
export function selectPrimaryBalance(providerProfileId: string) {
  return (state: QuotaState): ProviderBalanceAmount | null =>
    selectQuotaBalances(providerProfileId)(state).find((balance) => balance.primary) ?? null;
}
