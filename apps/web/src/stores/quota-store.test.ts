/**
 * Contracts for the quota store — the entire frontend surface of the quota
 * feature until a UI is built on top of it.
 *
 * Pins what a later panel will depend on: per-window used/remaining percentages
 * and reset instants, the primary balance, config round-trips, and the SSE
 * dedupe that keeps a reconnect from double-toasting.
 *
 * The HTTP layer is mocked with the spread-real-then-override pattern
 * (mock.module is process-global), so every other export of quota-api stays
 * genuine.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  PROVIDER_BALANCE_KIND,
  PROVIDER_BALANCE_UNIT,
  PROVIDER_QUOTA_EVENT_KIND,
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_WINDOW_KIND,
  QUOTA_LOW_REMAINING_CROSSING,
  QUOTA_RESET_DETECTION,
  type ProviderQuotaConfig,
  type ProviderQuotaLowRemainingEvent,
  type ProviderQuotaWindowResetEvent,
  type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import type { ProviderQuotaCapabilityRecord, ProviderQuotaRecord } from "@vibe-tavern/api-contracts";

const PROFILE = "prov_1";

let capabilityImpl: ((id: string) => Promise<ProviderQuotaCapabilityRecord>) | null = null;
let quotaImpl: ((id: string) => Promise<ProviderQuotaRecord>) | null = null;
let updateImpl: ((id: string, config: ProviderQuotaConfig) => Promise<ProviderQuotaRecord>) | null = null;
let updateCalls: Array<{ id: string; config: ProviderQuotaConfig }> = [];

const realQuotaApi = await import("../api/quota-api.js");
mock.module("../api/quota-api.js", () => ({
  ...realQuotaApi,
  fetchQuotaCapability: (id: string) => capabilityImpl
    ? capabilityImpl(id)
    : Promise.reject(new Error("no capability impl")),
  fetchQuota: (id: string) => quotaImpl ? quotaImpl(id) : Promise.reject(new Error("no quota impl")),
  updateQuotaConfig: (id: string, config: ProviderQuotaConfig) => {
    updateCalls.push({ id, config });
    return updateImpl ? updateImpl(id, config) : Promise.reject(new Error("no update impl"));
  },
}));

const {
  useQuotaStore,
  selectQuotaEntry,
  selectQuotaWindows,
  selectQuotaBalances,
  selectPrimaryBalance,
} = await import("./quota-store.js");

const WINDOWED_CONFIG: ProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.windowed,
  displayEnabled: true,
  lowQuotaEnabled: true,
  lowQuotaRemainingPercent: 20,
  resetNotifyEnabled: true,
  pollIntervalMinutes: 5,
};

function snapshot(usedPercent: number, observedAt = "2026-08-07T10:00:00.000Z"): WindowedProviderQuotaSnapshot {
  return {
    kind: PROVIDER_QUOTA_KIND.windowed,
    providerProfileId: PROFILE,
    capabilityId: "zai",
    capabilityVersion: 1,
    observedAt,
    windows: [
      { kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "5h", usedPercent, resetsAt: "2026-08-07T14:00:00.000Z" },
      { kind: PROVIDER_QUOTA_WINDOW_KIND.weekly, label: "Weekly", usedPercent: 10, resetsAt: "2026-08-11T00:00:00.000Z" },
    ],
    balances: [
      { kind: PROVIDER_BALANCE_KIND.available, unit: PROVIDER_BALANCE_UNIT.usd, amount: "12.34", primary: true },
      { kind: PROVIDER_BALANCE_KIND.granted, unit: PROVIDER_BALANCE_UNIT.usd, amount: "2.00", primary: false },
    ],
  };
}

function record(overrides: Partial<ProviderQuotaRecord> = {}): ProviderQuotaRecord {
  return {
    providerProfileId: PROFILE,
    config: WINDOWED_CONFIG,
    snapshot: snapshot(50),
    lastError: null,
    updatedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

function lowRemaining(overrides: Partial<ProviderQuotaLowRemainingEvent> = {}): ProviderQuotaLowRemainingEvent {
  return {
    kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
    eventId: "evt-low-1",
    providerProfileId: PROFILE,
    capabilityId: "zai",
    windowKind: PROVIDER_QUOTA_WINDOW_KIND.session,
    windowLabel: "5h",
    usedPercent: 95,
    remainingPercent: 5,
    thresholdPercent: 20,
    resetsAt: "2026-08-07T14:00:00.000Z",
    crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
    observedAt: "2026-08-07T11:00:00.000Z",
    ...overrides,
  };
}

function windowReset(): ProviderQuotaWindowResetEvent {
  return {
    kind: PROVIDER_QUOTA_EVENT_KIND.windowReset,
    eventId: "evt-reset-1",
    providerProfileId: PROFILE,
    capabilityId: "zai",
    windowKind: PROVIDER_QUOTA_WINDOW_KIND.session,
    windowLabel: "5h",
    usedPercent: 3,
    remainingPercent: 97,
    resetsAt: "2026-08-07T19:00:00.000Z",
    detection: QUOTA_RESET_DETECTION.boundaryAdvancedWithUsageDrop,
    observedAt: "2026-08-07T14:05:00.000Z",
  };
}

beforeEach(() => {
  useQuotaStore.getState().reset();
  capabilityImpl = null;
  quotaImpl = null;
  updateImpl = null;
  updateCalls = [];
});

describe("loading", () => {
  test("an unknown profile reads as an empty idle entry, not undefined", () => {
    const entry = selectQuotaEntry("prov_unknown")(useQuotaStore.getState());
    expect(entry.status).toBe("idle");
    expect(entry.snapshot).toBeNull();
    expect(entry.config).toBeNull();
  });

  test("fetchQuota stores the config, snapshot and error together", async () => {
    quotaImpl = async () => record({ lastError: "http" });
    await useQuotaStore.getState().fetchQuota(PROFILE);

    const entry = selectQuotaEntry(PROFILE)(useQuotaStore.getState());
    expect(entry.status).toBe("success");
    expect(entry.config).toEqual(WINDOWED_CONFIG);
    expect(entry.lastError).toBe("http");
    expect(entry.loadError).toBeNull();
  });

  test("a failed fetch records loadError without clobbering a previous snapshot", async () => {
    quotaImpl = async () => record();
    await useQuotaStore.getState().fetchQuota(PROFILE);

    quotaImpl = async () => { throw new Error("network down"); };
    await useQuotaStore.getState().fetchQuota(PROFILE);

    const entry = selectQuotaEntry(PROFILE)(useQuotaStore.getState());
    expect(entry.status).toBe("error");
    expect(entry.loadError).toBe("network down");
    expect(entry.snapshot).not.toBeNull();
  });

  test("fetchCapability stores the capability alongside the rest", async () => {
    capabilityImpl = async () => ({
      providerProfileId: PROFILE,
      kind: PROVIDER_QUOTA_KIND.windowed,
      capabilityId: "zai",
      capabilityVersion: 1,
      pollIntervalMs: 300_000,
      reason: null,
    });
    await useQuotaStore.getState().fetchCapability(PROFILE);
    expect(selectQuotaEntry(PROFILE)(useQuotaStore.getState()).capability?.capabilityId).toBe("zai");
  });

  test("updateConfig sends the config and applies the returned record", async () => {
    const next: ProviderQuotaConfig = { ...WINDOWED_CONFIG, lowQuotaRemainingPercent: 35 };
    updateImpl = async () => record({ config: next });

    await useQuotaStore.getState().updateConfig(PROFILE, next);

    expect(updateCalls).toEqual([{ id: PROFILE, config: next }]);
    expect(selectQuotaEntry(PROFILE)(useQuotaStore.getState()).config).toEqual(next);
  });
});

describe("selectors", () => {
  beforeEach(async () => {
    quotaImpl = async () => record();
    await useQuotaStore.getState().fetchQuota(PROFILE);
  });

  test("windows expose used AND remaining percentages plus the reset instant", () => {
    const windows = selectQuotaWindows(PROFILE)(useQuotaStore.getState());
    expect(windows).toEqual([
      { kind: "session", label: "5h", usedPercent: 50, remainingPercent: 50, resetsAt: "2026-08-07T14:00:00.000Z" },
      { kind: "weekly", label: "Weekly", usedPercent: 10, remainingPercent: 90, resetsAt: "2026-08-11T00:00:00.000Z" },
    ]);
  });

  test("balances come through on a windowed snapshot, with one primary", () => {
    expect(selectQuotaBalances(PROFILE)(useQuotaStore.getState())).toHaveLength(2);
    expect(selectPrimaryBalance(PROFILE)(useQuotaStore.getState())).toEqual({
      kind: PROVIDER_BALANCE_KIND.available,
      unit: PROVIDER_BALANCE_UNIT.usd,
      amount: "12.34",
      primary: true,
    });
  });

  test("a none snapshot yields no windows and no balances", async () => {
    quotaImpl = async () => record({
      snapshot: { kind: PROVIDER_QUOTA_KIND.none, providerProfileId: PROFILE, reason: "not_exposed" },
    });
    await useQuotaStore.getState().fetchQuota(PROFILE);

    expect(selectQuotaWindows(PROFILE)(useQuotaStore.getState())).toEqual([]);
    expect(selectQuotaBalances(PROFILE)(useQuotaStore.getState())).toEqual([]);
    expect(selectPrimaryBalance(PROFILE)(useQuotaStore.getState())).toBeNull();
  });
});

describe("ingestQuotaEvent", () => {
  beforeEach(async () => {
    quotaImpl = async () => record();
    await useQuotaStore.getState().fetchQuota(PROFILE);
  });

  test("returns true once and false for a replay of the same event id", () => {
    expect(useQuotaStore.getState().ingestQuotaEvent(lowRemaining())).toBe(true);
    expect(useQuotaStore.getState().ingestQuotaEvent(lowRemaining())).toBe(false);
  });

  test("folds the event's numbers into the named window only", () => {
    useQuotaStore.getState().ingestQuotaEvent(lowRemaining());

    const windows = selectQuotaWindows(PROFILE)(useQuotaStore.getState());
    expect(windows[0]).toMatchObject({ kind: "session", usedPercent: 95, remainingPercent: 5 });
    expect(windows[1]).toMatchObject({ kind: "weekly", usedPercent: 10 });
  });

  test("a reset event advances the window's resetsAt", () => {
    useQuotaStore.getState().ingestQuotaEvent(windowReset());
    expect(selectQuotaWindows(PROFILE)(useQuotaStore.getState())[0]).toMatchObject({
      usedPercent: 3,
      resetsAt: "2026-08-07T19:00:00.000Z",
    });
  });

  test("an event older than the stored snapshot is ignored", () => {
    useQuotaStore.getState().ingestQuotaEvent(lowRemaining({
      eventId: "evt-stale",
      observedAt: "2026-08-07T09:00:00.000Z",
    }));
    expect(selectQuotaWindows(PROFILE)(useQuotaStore.getState())[0]).toMatchObject({ usedPercent: 50 });
  });

  test("an event from a different adapter does not rewrite the snapshot", () => {
    useQuotaStore.getState().ingestQuotaEvent(lowRemaining({ eventId: "evt-other", capabilityId: "kimi" }));
    expect(selectQuotaWindows(PROFILE)(useQuotaStore.getState())[0]).toMatchObject({ usedPercent: 50 });
  });

  test("an event for a profile with nothing loaded is still deduped", () => {
    const event = lowRemaining({ eventId: "evt-unloaded", providerProfileId: "prov_other" });
    expect(useQuotaStore.getState().ingestQuotaEvent(event)).toBe(true);
    expect(useQuotaStore.getState().ingestQuotaEvent(event)).toBe(false);
    expect(selectQuotaEntry("prov_other")(useQuotaStore.getState()).snapshot).toBeNull();
  });

  test("the dedupe set stays bounded", () => {
    for (let i = 0; i < 250; i++) {
      useQuotaStore.getState().ingestQuotaEvent(lowRemaining({ eventId: `evt-${i}` }));
    }
    expect(useQuotaStore.getState().seenEventIds.length).toBeLessThanOrEqual(200);
  });
});

describe("stream state", () => {
  test("round-trips and resets", () => {
    useQuotaStore.getState().setStreamState("open");
    expect(useQuotaStore.getState().streamState).toBe("open");
    useQuotaStore.getState().reset();
    expect(useQuotaStore.getState().streamState).toBe("closed");
  });
});
