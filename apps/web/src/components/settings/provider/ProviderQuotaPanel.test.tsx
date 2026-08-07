/**
 * ProviderQuotaPanel — the disclosure that only exists for providers whose
 * quota can be read, and what each control writes.
 *
 * The pins that matter: the panel is absent for a `none` capability, the header
 * toggle writes `displayEnabled` immediately (it is the feature switch), the
 * notification rows exist ONLY for windowed providers (a balance has no
 * denominator, so a percentage threshold is not a statement about it), and the
 * poll-period control writes an integer number of minutes.
 *
 * quota-api is stubbed with the spread-real pattern — mock.module is
 * process-global, so every other export must stay genuine.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import {
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_NONE_REASON,
  type ProviderQuotaConfig,
} from "@vibe-tavern/domain";
import type { ProviderQuotaCapabilityRecord, ProviderQuotaRecord } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const PROFILE = "prov_1";

let capability: ProviderQuotaCapabilityRecord | null = null;
let record: ProviderQuotaRecord | null = null;
const updateCalls: ProviderQuotaConfig[] = [];

const realQuotaApi = await import("../../../api/quota-api.js");
mock.module("../../../api/quota-api.js", () => ({
  ...realQuotaApi,
  fetchQuotaCapability: () => capability
    ? Promise.resolve(capability)
    : Promise.reject(new Error("no capability")),
  fetchQuota: () => record ? Promise.resolve(record) : Promise.reject(new Error("no record")),
  updateQuotaConfig: (_id: string, config: ProviderQuotaConfig) => {
    updateCalls.push(config);
    return Promise.resolve({ ...record!, config });
  },
}));

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let ProviderQuotaPanel: typeof import("./ProviderQuotaPanel.js").ProviderQuotaPanel;
let useQuotaStore: typeof import("../../../stores/quota-store.js").useQuotaStore;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ ProviderQuotaPanel } = await import("./ProviderQuotaPanel.js"));
  ({ useQuotaStore } = await import("../../../stores/quota-store.js"));
});

const WINDOWED_CONFIG: ProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.windowed,
  displayEnabled: false,
  lowQuotaEnabled: false,
  lowQuotaRemainingPercent: 10,
  resetNotifyEnabled: false,
  pollIntervalMinutes: 5,
};

const BALANCE_CONFIG: ProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.balance,
  displayEnabled: true,
  pollIntervalMinutes: 5,
};

function windowedCapability(): ProviderQuotaCapabilityRecord {
  return {
    providerProfileId: PROFILE,
    kind: PROVIDER_QUOTA_KIND.windowed,
    capabilityId: "zai",
    capabilityVersion: 1,
    pollIntervalMs: 300_000,
    reason: null,
  };
}

function setup(
  nextCapability: ProviderQuotaCapabilityRecord,
  config: ProviderQuotaConfig,
): ReturnType<typeof render> {
  capability = nextCapability;
  record = { providerProfileId: PROFILE, config, snapshot: null, lastError: null, updatedAt: null };
  return render(<ProviderQuotaPanel providerProfileId={PROFILE} />);
}

describe("ProviderQuotaPanel", () => {
  beforeEach(() => {
    useQuotaStore.getState().reset();
    updateCalls.length = 0;
  });

  test("does not exist for a provider that exposes no quota", async () => {
    const { container, queryByText } = setup({
      providerProfileId: PROFILE,
      kind: PROVIDER_QUOTA_KIND.none,
      capabilityId: null,
      capabilityVersion: null,
      pollIntervalMs: null,
      reason: PROVIDER_QUOTA_NONE_REASON.notExposed,
    }, { kind: PROVIDER_QUOTA_KIND.none });

    await waitFor(() => {
      expect(useQuotaStore.getState().entries[PROFILE]?.capability).not.toBeNull();
    });
    expect(queryByText("quota_section")).toBeNull();
    expect(container.querySelector("[role=switch]")).toBeNull();
  });

  test("appears for a supported provider and toggles display immediately", async () => {
    const { findByText, getByLabelText } = setup(windowedCapability(), WINDOWED_CONFIG);

    await findByText("quota_section");
    fireEvent.click(getByLabelText("quota_display_enabled"));

    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({ ...WINDOWED_CONFIG, displayEnabled: true });
  });

  test("the notification rows only exist for windowed providers", async () => {
    const windowed = setup(windowedCapability(), WINDOWED_CONFIG);
    fireEvent.click(await windowed.findByText("quota_section"));
    expect(windowed.queryByLabelText("quota_low_notify")).not.toBeNull();
    expect(windowed.queryByLabelText("quota_reset_notify")).not.toBeNull();
    windowed.unmount();

    useQuotaStore.getState().reset();
    const balance = setup({
      providerProfileId: PROFILE,
      kind: PROVIDER_QUOTA_KIND.balance,
      capabilityId: "deepseek",
      capabilityVersion: 1,
      pollIntervalMs: 300_000,
      reason: null,
    }, BALANCE_CONFIG);

    fireEvent.click(await balance.findByText("quota_section"));
    expect(balance.queryByLabelText("quota_low_notify")).toBeNull();
    expect(balance.queryByLabelText("quota_reset_notify")).toBeNull();
    // The poll period is not a notification setting — it survives.
    expect(balance.queryByText("quota_poll_interval")).not.toBeNull();
  });

  test("the low-quota toggle and its threshold write the same config", async () => {
    const { findByText, getByLabelText } = setup(windowedCapability(), WINDOWED_CONFIG);
    fireEvent.click(await findByText("quota_section"));

    fireEvent.click(getByLabelText("quota_low_notify"));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toMatchObject({ lowQuotaEnabled: true, lowQuotaRemainingPercent: 10 });

    fireEvent.change(getByLabelText("quota_low_threshold"), { target: { value: "25" } });
    await waitFor(() => expect(updateCalls).toHaveLength(2));
    expect(updateCalls[1]).toMatchObject({ lowQuotaRemainingPercent: 25 });
  });

  test("the poll period writes whole minutes", async () => {
    const { findByText, getByText } = setup(windowedCapability(), WINDOWED_CONFIG);
    fireEvent.click(await findByText("quota_section"));

    fireEvent.click(getByText('quota_minutes_short:{"minutes":2}'));

    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toMatchObject({ pollIntervalMinutes: 2 });
  });
});
