/**
 * QuotaIndicator — when the chat toolbar shows a quota icon, and what the
 * flyout says once it is open.
 *
 * The gating is the important half: an unsupported provider, a supported one
 * with the display toggle off, and "no profile active" must all render NOTHING,
 * because an icon that opens onto an empty box is worse than no icon.
 *
 * The store is driven directly (it is the component's only input) and the HTTP
 * layer is stubbed with the spread-real pattern, so mounting never reaches the
 * network — `mock.module` is process-global and every other quota-api export
 * has to stay genuine.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import {
  PROVIDER_BALANCE_KIND,
  PROVIDER_BALANCE_UNIT,
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_NONE_REASON,
  PROVIDER_QUOTA_WINDOW_KIND,
  type ProviderQuotaConfig,
  type ProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import type { ProviderQuotaCapabilityRecord } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const PROFILE = "prov_1";

const realQuotaApi = await import("../../api/quota-api.js");
mock.module("../../api/quota-api.js", () => ({
  ...realQuotaApi,
  fetchQuotaCapability: () => new Promise<never>(() => {}),
  fetchQuota: () => new Promise<never>(() => {}),
  updateQuotaConfig: () => new Promise<never>(() => {}),
}));

const realI18nContext = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => opts ? `${key}:${JSON.stringify(opts)}` : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const realTooltip = await import("../shared/Tooltip.js");
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let QuotaIndicator: typeof import("./QuotaIndicator.js").QuotaIndicator;
let useQuotaStore: typeof import("../../stores/quota-store.js").useQuotaStore;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ QuotaIndicator } = await import("./QuotaIndicator.js"));
  ({ useQuotaStore } = await import("../../stores/quota-store.js"));
});

const WINDOWED_CONFIG: ProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.windowed,
  displayEnabled: true,
  lowQuotaEnabled: false,
  lowQuotaRemainingPercent: 10,
  resetNotifyEnabled: false,
  pollIntervalMinutes: 5,
};

const WINDOWED_CAPABILITY: ProviderQuotaCapabilityRecord = {
  providerProfileId: PROFILE,
  kind: PROVIDER_QUOTA_KIND.windowed,
  capabilityId: "zai",
  capabilityVersion: 1,
  pollIntervalMs: 300_000,
  reason: null,
};

function windowedSnapshot(usedPercent: number, resetsAt = "2099-01-01T00:00:00.000Z"): ProviderQuotaSnapshot {
  return {
    kind: PROVIDER_QUOTA_KIND.windowed,
    providerProfileId: PROFILE,
    capabilityId: "zai",
    capabilityVersion: 1,
    observedAt: "2026-08-08T12:00:00.000Z",
    windows: [
      {
        kind: PROVIDER_QUOTA_WINDOW_KIND.session,
        label: "5-hour session",
        usedPercent,
        resetsAt,
      },
    ],
    balances: [
      {
        kind: PROVIDER_BALANCE_KIND.available,
        unit: PROVIDER_BALANCE_UNIT.usd,
        amount: "12.40",
        primary: true,
      },
    ],
  };
}

function seed(entry: {
  capability?: ProviderQuotaCapabilityRecord | null;
  config?: ProviderQuotaConfig | null;
  snapshot?: ProviderQuotaSnapshot | null;
  lastError?: "auth" | null;
}): void {
  useQuotaStore.setState({
    entries: {
      [PROFILE]: {
        status: "success",
        capability: entry.capability ?? WINDOWED_CAPABILITY,
        config: entry.config === undefined ? WINDOWED_CONFIG : entry.config,
        snapshot: entry.snapshot ?? null,
        lastError: entry.lastError ?? null,
        loadError: null,
        updatedAt: "2026-08-08T12:00:00.000Z",
      },
    },
  });
}

describe("QuotaIndicator gating", () => {
  beforeEach(() => {
    useQuotaStore.getState().reset();
  });

  test("renders nothing without an active provider profile", () => {
    seed({ snapshot: windowedSnapshot(50) });
    const { container } = render(<QuotaIndicator providerProfileId={null} />);
    expect(container.querySelector("button")).toBeNull();
  });

  test("renders nothing while the config is still unknown", () => {
    seed({ config: null });
    const { container } = render(<QuotaIndicator providerProfileId={PROFILE} />);
    expect(container.querySelector("button")).toBeNull();
  });

  test("renders nothing when the display toggle is off", () => {
    seed({ config: { ...WINDOWED_CONFIG, displayEnabled: false }, snapshot: windowedSnapshot(50) });
    const { container } = render(<QuotaIndicator providerProfileId={PROFILE} />);
    expect(container.querySelector("button")).toBeNull();
  });

  test("renders nothing for a provider with no quota capability", () => {
    seed({
      capability: {
        providerProfileId: PROFILE,
        kind: PROVIDER_QUOTA_KIND.none,
        capabilityId: null,
        capabilityVersion: null,
        pollIntervalMs: null,
        reason: PROVIDER_QUOTA_NONE_REASON.notExposed,
      },
      config: { kind: PROVIDER_QUOTA_KIND.none },
    });
    const { container } = render(<QuotaIndicator providerProfileId={PROFILE} />);
    expect(container.querySelector("button")).toBeNull();
  });

  test("shows the trigger once display is on, even before the first reading", () => {
    seed({ snapshot: null });
    const { getByLabelText } = render(<QuotaIndicator providerProfileId={PROFILE} />);
    expect(getByLabelText("quota_indicator_tooltip")).toBeTruthy();
  });
});

describe("QuotaIndicator flyout", () => {
  beforeEach(() => {
    useQuotaStore.getState().reset();
  });

  test("opens onto a per-window gauge showing the REMAINING share", () => {
    seed({ snapshot: windowedSnapshot(62) });
    const { getByLabelText, getByText } = render(<QuotaIndicator providerProfileId={PROFILE} />);

    fireEvent.click(getByLabelText("quota_indicator_tooltip"));

    expect(getByText("quota_window_session")).toBeTruthy();
    expect(getByText('quota_remaining_value:{"percent":38}')).toBeTruthy();
  });

  test("lists balances a windowed provider reports alongside its windows", () => {
    seed({ snapshot: windowedSnapshot(10) });
    const { getByLabelText, getByText } = render(<QuotaIndicator providerProfileId={PROFILE} />);

    fireEvent.click(getByLabelText("quota_indicator_tooltip"));

    expect(getByText("quota_balance_available")).toBeTruthy();
    expect(getByText("$12.40")).toBeTruthy();
  });

  test("a far-off reset reads in days, not in three-digit hours", () => {
    seed({ snapshot: windowedSnapshot(20) });
    const { getByLabelText, container } = render(<QuotaIndicator providerProfileId={PROFILE} />);

    fireEvent.click(getByLabelText("quota_indicator_tooltip"));

    expect(container.ownerDocument.body.textContent).toContain("quota_resets_in_days:");
    expect(container.ownerDocument.body.textContent).not.toContain("quota_resets_in:");
  });

  test("a reset inside the day still reads in hours and minutes", () => {
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000 + 31 * 60 * 1000).toISOString();
    seed({ snapshot: windowedSnapshot(20, soon) });
    const { getByLabelText, container } = render(<QuotaIndicator providerProfileId={PROFILE} />);

    fireEvent.click(getByLabelText("quota_indicator_tooltip"));

    expect(container.ownerDocument.body.textContent).toContain('quota_resets_in:{"hours":2,"minutes":30}');
  });

  test("says so when no reading has landed yet", () => {
    seed({ snapshot: null });
    const { getByLabelText, getByText } = render(<QuotaIndicator providerProfileId={PROFILE} />);

    fireEvent.click(getByLabelText("quota_indicator_tooltip"));

    expect(getByText("quota_no_data")).toBeTruthy();
  });

  test("surfaces a rejected API key instead of silently showing stale numbers", () => {
    seed({ snapshot: windowedSnapshot(20), lastError: "auth" });
    const { getByLabelText, getByText } = render(<QuotaIndicator providerProfileId={PROFILE} />);

    fireEvent.click(getByLabelText("quota_indicator_tooltip"));

    expect(getByText("quota_error_auth")).toBeTruthy();
  });
});
