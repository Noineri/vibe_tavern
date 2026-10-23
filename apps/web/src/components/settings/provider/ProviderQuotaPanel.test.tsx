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
  PROVIDER_BALANCE_KIND,
  PROVIDER_BALANCE_UNIT,
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_NONE_REASON,
  PROVIDER_QUOTA_WINDOW_KIND,
  type ProviderQuotaConfig,
  type ProviderQuotaSnapshot,
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

function thresholdShell(rangeInput: HTMLElement): HTMLElement {
  const shell = rangeInput.closest<HTMLElement>("[data-slider-field-shell]");
  if (!shell) throw new Error("Expected the threshold range to live inside a slider field");
  return shell;
}

/** Counts the elements from the range input up to the document root that carry the 40% disabled dim. */
function dimLayers(rangeInput: HTMLElement): number {
  let layers = 0;
  for (let node: HTMLElement | null = rangeInput; node; node = node.parentElement) {
    if (node.classList.contains("opacity-40")) layers += 1;
  }
  return layers;
}

function typeThreshold(rangeInput: HTMLElement, text: string) {
  const shell = thresholdShell(rangeInput);
  const field = shell.querySelector<HTMLElement>("[data-slider-field]");
  if (!field) throw new Error("Missing the threshold field box");
  fireEvent.doubleClick(field);
  const editor = shell.querySelector<HTMLInputElement>("[data-slider-field-editor] input");
  if (!editor) throw new Error("The inline editor did not open");
  fireEvent.change(editor, { target: { value: text } });
  fireEvent.keyDown(editor, { key: "Enter" });
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

  test("the low-quota toggle and its nested slider threshold write the same config", async () => {
    const { findByText, getByLabelText } = setup(windowedCapability(), WINDOWED_CONFIG);
    fireEvent.click(await findByText("quota_section"));
    const threshold = getByLabelText("quota_low_threshold") as HTMLInputElement;

    expect(threshold.type).toBe("range");
    expect(threshold.min).toBe("1");
    expect(threshold.max).toBe("100");
    expect(threshold.step).toBe("1");
    expect(threshold.disabled).toBe(true);

    fireEvent.click(getByLabelText("quota_low_notify"));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toMatchObject({ lowQuotaEnabled: true, lowQuotaRemainingPercent: 10 });
    await waitFor(() => expect((getByLabelText("quota_low_threshold") as HTMLInputElement).disabled).toBe(false));

    fireEvent.change(getByLabelText("quota_low_threshold"), { target: { value: "25" } });
    await waitFor(() => expect(updateCalls).toHaveLength(2));
    expect(updateCalls[1]).toMatchObject({ lowQuotaRemainingPercent: 25 });
  });

  test("the threshold is one field with its label inside and a single 40% dim while the notification is off", async () => {
    const { findByText, getByLabelText } = setup(windowedCapability(), WINDOWED_CONFIG);
    fireEvent.click(await findByText("quota_section"));
    const shell = thresholdShell(getByLabelText("quota_low_threshold"));

    expect(shell.querySelector("[data-slider-field-label]")?.textContent).toBe("quota_low_threshold");
    expect(shell.querySelector("[data-slider-field-value]")?.textContent).toBe("10");
    // Disabled: the field dims itself (label included) and nothing around it dims a second time.
    expect(dimLayers(getByLabelText("quota_low_threshold"))).toBe(1);

    fireEvent.click(getByLabelText("quota_low_notify"));
    await waitFor(() => expect((getByLabelText("quota_low_threshold") as HTMLInputElement).disabled).toBe(false));
    expect(dimLayers(getByLabelText("quota_low_threshold"))).toBe(0);
  });

  test("a typed threshold goes through the inline editor into the same debounced config, rounded and clamped", async () => {
    const { findByText, getByLabelText } = setup(windowedCapability(), WINDOWED_CONFIG);
    fireEvent.click(await findByText("quota_section"));
    fireEvent.click(getByLabelText("quota_low_notify"));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    await waitFor(() => expect((getByLabelText("quota_low_threshold") as HTMLInputElement).disabled).toBe(false));

    // Seam: the number box beside the slider is now the field's inline editor, opened by double-click.
    typeThreshold(getByLabelText("quota_low_threshold"), "42.6");
    await waitFor(() => expect(updateCalls).toHaveLength(2));
    // Behavior change: a typed fraction was written as typed (42.6) -> now whole percent (26), like a drag; basis: SL-9 brief (integer rounding on both paths).
    expect(updateCalls[1]).toMatchObject({ lowQuotaEnabled: true, lowQuotaRemainingPercent: 43 });

    typeThreshold(getByLabelText("quota_low_threshold"), "150");
    await waitFor(() => expect(updateCalls).toHaveLength(3));
    expect(updateCalls[2]).toMatchObject({ lowQuotaRemainingPercent: 100 });
  });

  test("the poll period writes whole minutes", async () => {
    const { findByText, getByText } = setup(windowedCapability(), WINDOWED_CONFIG);
    fireEvent.click(await findByText("quota_section"));

    fireEvent.click(getByText('quota_minutes_short:{"minutes":2}'));

    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toMatchObject({ pollIntervalMinutes: 2 });
  });

  test("the current quota summary renders inside the disclosure (MUI step 4: quota viewable on phones)", async () => {
    capability = windowedCapability();
    record = {
      providerProfileId: PROFILE,
      config: WINDOWED_CONFIG,
      snapshot: {
        kind: PROVIDER_QUOTA_KIND.windowed,
        providerProfileId: PROFILE,
        capabilityId: "zai",
        capabilityVersion: 1,
        observedAt: "2026-09-11T12:00:00.000Z",
        windows: [
          {
            kind: PROVIDER_QUOTA_WINDOW_KIND.session,
            label: "5-hour session",
            usedPercent: 50,
            resetsAt: "2099-01-01T00:00:00.000Z",
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
      } satisfies ProviderQuotaSnapshot,
      lastError: null,
      updatedAt: "2026-09-11T12:00:00.000Z",
    };

    const { findByText, getByText } = render(<ProviderQuotaPanel providerProfileId={PROFILE} />);
    fireEvent.click(await findByText("quota_section"));

    // Windowed row (50% used → 50% remaining) and the reported balance both
    // render — the same body the chat flyout shows.
    await waitFor(() => {
      expect(getByText('quota_remaining_value:{"percent":50}')).toBeTruthy();
    });
    expect(getByText("$12.40")).toBeTruthy();
  });
});
