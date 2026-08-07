import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_LOW_QUOTA_REMAINING_PERCENT,
  DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
  PROVIDER_BALANCE_KIND,
  PROVIDER_BALANCE_UNIT,
  PROVIDER_QUOTA_ERROR_KIND,
  PROVIDER_QUOTA_EVENT_KIND,
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_WINDOW_KIND,
  QUOTA_LOW_REMAINING_CROSSING,
  type BalanceProviderQuotaSnapshot,
  type ProviderQuotaLowRemainingEvent,
  type QuotaTransitionState,
  type WindowedProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import { createDb } from "../src/db-connection.js";
import { providerQuotaEvents, providerQuotaSettings, providerQuotaSnapshots } from "../src/db-schema.js";
import { QuotaStore } from "../src/stores/quota-store.js";
import { ProviderStore } from "../src/stores/provider-store.js";
import type { AppDb } from "../src/db-connection.js";

const BASE_CREATE = {
  providerPreset: "zai" as const,
  endpoint: "https://api.z.ai/api/paas/v4",
  apiKey: "sk-test",
  defaultModel: "glm-4.6",
  contextBudget: null as null,
  temperature: 1, topP: 1, minP: 0, topK: 0, topA: 0,
  typicalP: 1, tfsZ: 1, repeatLastN: 0,
  mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
  dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2,
  drySequenceBreakers: null as null,
  xtcThreshold: 0.1, xtcProbability: 0,
  frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
  maxTokens: 2000,
  stopSequences: null as null, logitBias: null as null, seed: null as null,
  reasoningEffort: "auto" as const,
  showReasoning: false, streamResponse: true, customSamplers: false,
};

function windowedSnapshot(providerProfileId: string, usedPercent: number): WindowedProviderQuotaSnapshot {
  return {
    kind: PROVIDER_QUOTA_KIND.windowed,
    providerProfileId,
    capabilityId: "zai",
    capabilityVersion: 1,
    observedAt: "2026-08-07T10:00:00.000Z",
    windows: [
      {
        kind: PROVIDER_QUOTA_WINDOW_KIND.session,
        label: "GLM Coding Pro — 5h",
        usedPercent,
        resetsAt: "2026-08-07T14:00:00.000Z",
      },
    ],
  };
}

function transitionState(usedPercent: number): QuotaTransitionState {
  return {
    capabilityId: "zai",
    capabilityVersion: 1,
    thresholdPercent: 10,
    observedAt: "2026-08-07T10:00:00.000Z",
    windows: {
      [PROVIDER_QUOTA_WINDOW_KIND.session]: {
        lastUsedPercent: usedPercent,
        lastResetsAt: "2026-08-07T14:00:00.000Z",
        lowQuotaLatched: false,
      },
    },
  };
}

function lowRemainingEvent(providerProfileId: string, eventId: string): ProviderQuotaLowRemainingEvent {
  return {
    kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
    eventId,
    providerProfileId,
    capabilityId: "zai",
    windowKind: PROVIDER_QUOTA_WINDOW_KIND.session,
    windowLabel: "GLM Coding Pro — 5h",
    usedPercent: 95,
    remainingPercent: 5,
    thresholdPercent: 10,
    resetsAt: "2026-08-07T14:00:00.000Z",
    crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
    observedAt: "2026-08-07T10:00:00.000Z",
  };
}

describe("QuotaStore", () => {
  let db: AppDb;
  let store: QuotaStore;
  let providers: ProviderStore;
  let profileId: string;

  beforeEach(async () => {
    db = await createDb(":memory:");
    store = new QuotaStore(db);
    providers = new ProviderStore(db);
    const created = await providers.create({ name: "ZAI", ...BASE_CREATE });
    profileId = created.id;
  });

  // ─── Settings ─────────────────────────────────────────────────────────────

  test("getSettings returns null before anything is written", async () => {
    expect(await store.getSettings(profileId)).toBeNull();
  });

  test("windowed toggles round-trip", async () => {
    const written = await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: 25,
      resetNotifyEnabled: true,
      pollIntervalMinutes: 2,
    });
    expect(written.config).toEqual({
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: 25,
      resetNotifyEnabled: true,
      pollIntervalMinutes: 2,
    });
    expect((await store.getSettings(profileId))?.config).toEqual(written.config);
  });

  test("upsert is idempotent on the profile id and keeps createdAt", async () => {
    const first = await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: false,
      lowQuotaRemainingPercent: 10,
      resetNotifyEnabled: false,
      pollIntervalMinutes: 5,
    });
    const second = await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: false,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: 40,
      resetNotifyEnabled: true,
      pollIntervalMinutes: 1,
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(await db.select().from(providerQuotaSettings).all()).toHaveLength(1);
    expect(second.config).toEqual({
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: false,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: 40,
      resetNotifyEnabled: true,
      pollIntervalMinutes: 1,
    });
  });

  test("switching windowed → balance clears the notification columns", async () => {
    await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: 30,
      resetNotifyEnabled: true,
      pollIntervalMinutes: 5,
    });
    const switched = await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.balance,
      displayEnabled: true,
      pollIntervalMinutes: 4,
    });

    expect(switched.config).toEqual({
      kind: PROVIDER_QUOTA_KIND.balance,
      displayEnabled: true,
      pollIntervalMinutes: 4,
    });
    const row = await db.select().from(providerQuotaSettings).get();
    expect(row?.lowQuotaEnabled).toBeNull();
    expect(row?.lowQuotaRemainingPercent).toBeNull();
    expect(row?.resetNotifyEnabled).toBeNull();
  });

  test("a windowed row with NULL notification columns reads back as the kind defaults", async () => {
    await db.insert(providerQuotaSettings).values({
      providerProfileId: profileId,
      configKind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: null,
      lowQuotaRemainingPercent: null,
      resetNotifyEnabled: null,
      pollIntervalMinutes: null,
      createdAt: "2026-08-07T09:00:00.000Z",
      updatedAt: "2026-08-07T09:00:00.000Z",
    }).run();

    expect((await store.getSettings(profileId))?.config).toEqual({
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: false,
      lowQuotaRemainingPercent: DEFAULT_LOW_QUOTA_REMAINING_PERCENT,
      resetNotifyEnabled: false,
      pollIntervalMinutes: DEFAULT_QUOTA_POLL_INTERVAL_MINUTES,
    });
  });

  test("listSettings returns every persisted profile", async () => {
    const second = await providers.create({ name: "DeepSeek", ...BASE_CREATE, providerPreset: "deepseek" });
    await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: false,
      lowQuotaRemainingPercent: 10,
      resetNotifyEnabled: false,
      pollIntervalMinutes: 5,
    });
    await store.upsertSettings(second.id, {
      kind: PROVIDER_QUOTA_KIND.balance,
      displayEnabled: true,
      pollIntervalMinutes: 5,
    });

    const all = await store.listSettings();
    expect(all.map((entry) => entry.providerProfileId).sort()).toEqual([profileId, second.id].sort());
  });

  // ─── Snapshots ────────────────────────────────────────────────────────────

  test("snapshot + transition state round-trip as objects, not strings", async () => {
    const snapshot = windowedSnapshot(profileId, 42);
    const state = transitionState(42);
    await store.upsertSnapshot(profileId, { snapshot, transitionState: state, lastError: null });

    const read = await store.getSnapshot(profileId);
    expect(read?.snapshot).toEqual(snapshot);
    expect(read?.transitionState).toEqual(state);
    expect(read?.lastError).toBeNull();
  });

  test("an auth failure before any successful poll persists with a null snapshot", async () => {
    await store.upsertSnapshot(profileId, {
      snapshot: null,
      transitionState: null,
      lastError: PROVIDER_QUOTA_ERROR_KIND.auth,
    });

    const read = await store.getSnapshot(profileId);
    expect(read?.snapshot).toBeNull();
    expect(read?.lastError).toBe(PROVIDER_QUOTA_ERROR_KIND.auth);
  });

  test("upsertSnapshot replaces the whole poll result and keeps one row", async () => {
    await store.upsertSnapshot(profileId, {
      snapshot: windowedSnapshot(profileId, 10),
      transitionState: transitionState(10),
      lastError: null,
    });
    const balance: BalanceProviderQuotaSnapshot = {
      kind: PROVIDER_QUOTA_KIND.balance,
      providerProfileId: profileId,
      capabilityId: "deepseek",
      capabilityVersion: 1,
      observedAt: "2026-08-07T11:00:00.000Z",
      balances: [
        { kind: PROVIDER_BALANCE_KIND.total, unit: PROVIDER_BALANCE_UNIT.cny, amount: "110.05", primary: true },
      ],
    };
    await store.upsertSnapshot(profileId, { snapshot: balance, transitionState: null, lastError: null });

    expect(await db.select().from(providerQuotaSnapshots).all()).toHaveLength(1);
    const read = await store.getSnapshot(profileId);
    expect(read?.snapshot).toEqual(balance);
    expect(read?.transitionState).toBeNull();
  });

  test("deleteSnapshot removes the row without touching settings", async () => {
    await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.balance,
      displayEnabled: true,
      pollIntervalMinutes: 5,
    });
    await store.upsertSnapshot(profileId, {
      snapshot: windowedSnapshot(profileId, 10),
      transitionState: null,
      lastError: null,
    });

    await store.deleteSnapshot(profileId);
    expect(await store.getSnapshot(profileId)).toBeNull();
    expect(await store.getSettings(profileId)).not.toBeNull();
  });

  // ─── Event ledger ─────────────────────────────────────────────────────────

  test("recordEvent reports inserted once and never again for the same id", async () => {
    const event = lowRemainingEvent(profileId, `${profileId}:zai:session:low_remaining:2026-08-07T14:00:00.000Z`);

    expect(await store.recordEvent(event)).toBe(true);
    expect(await store.recordEvent(event)).toBe(false);
    expect(await db.select().from(providerQuotaEvents).all()).toHaveLength(1);
  });

  test("recorded events read back as the exact payload", async () => {
    const event = lowRemainingEvent(profileId, "evt-1");
    await store.recordEvent(event);
    expect(await store.listEvents(profileId)).toEqual([event]);
  });

  test("deleteEvents clears the ledger so a rebaseline may notify again", async () => {
    const event = lowRemainingEvent(profileId, "evt-1");
    await store.recordEvent(event);
    await store.deleteEvents(profileId);

    expect(await store.listEvents(profileId)).toEqual([]);
    expect(await store.recordEvent(event)).toBe(true);
  });

  // ─── Cascade ──────────────────────────────────────────────────────────────

  test("deleting the profile cascades all three quota tables", async () => {
    await store.upsertSettings(profileId, {
      kind: PROVIDER_QUOTA_KIND.windowed,
      displayEnabled: true,
      lowQuotaEnabled: true,
      lowQuotaRemainingPercent: 10,
      resetNotifyEnabled: true,
      pollIntervalMinutes: 5,
    });
    await store.upsertSnapshot(profileId, {
      snapshot: windowedSnapshot(profileId, 91),
      transitionState: transitionState(91),
      lastError: null,
    });
    await store.recordEvent(lowRemainingEvent(profileId, "evt-1"));

    await providers.delete(profileId);

    expect(await db.select().from(providerQuotaSettings).all()).toHaveLength(0);
    expect(await db.select().from(providerQuotaSnapshots).all()).toHaveLength(0);
    expect(await db.select().from(providerQuotaEvents).all()).toHaveLength(0);
  });
});
