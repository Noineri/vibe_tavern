/**
 * MobileModelSheet — the mobile model sheet: a collapsible context card, a
 * provider-quota card that appears only when the shared gate allows it, and
 * the starred-models list.
 *
 * The quota HTTP layer is stubbed with the spread-real pattern (spies, so the
 * "fetch on open" contract is observable) and the quota store is seeded
 * directly — it is the sheet's only quota input.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  MODEL_FAVORITE_SCOPE,
  PROVIDER_BALANCE_KIND,
  PROVIDER_BALANCE_UNIT,
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_WINDOW_KIND,
  type ProviderQuotaConfig,
  type ProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import type { FavoriteProviderModelRecord } from "../../api/types.js";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

const PROFILE = "prov_1";

const fetchQuotaCapability = mock((_id: string) => new Promise<never>(() => {}));
const fetchQuota = mock((_id: string) => new Promise<never>(() => {}));
const realQuotaApi = await import("../../api/quota-api.js");
mock.module("../../api/quota-api.js", () => ({
  ...realQuotaApi,
  fetchQuotaCapability,
  fetchQuota,
  updateQuotaConfig: () => new Promise<never>(() => {}),
}));

installI18nContextSeam({
  custom: {
    t: (key, opts?) => opts ? `${key}:${JSON.stringify(opts)}` : key,
    tDynamic: (key) => key,
  },
});

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let MobileModelSheet: typeof import("./mobile-model-sheet.js").MobileModelSheet;
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;
let useQuotaStore: typeof import("../../stores/quota-store.js").useQuotaStore;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ MobileModelSheet } = await import("./mobile-model-sheet.js"));
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
  ({ useQuotaStore } = await import("../../stores/quota-store.js"));
});

afterAll(() => {
  useQuotaStore.getState().reset();
});

beforeEach(() => {
  useQuotaStore.getState().reset();
  fetchQuotaCapability.mockClear();
  fetchQuota.mockClear();
});

type SheetProps = import("./mobile-model-sheet.js").MobileModelSheetProps;

// Number formatting follows the runtime locale; derive the expectation the same way.
const fmt = (n: number): string => n.toLocaleString();

function fav(modelId: string, label: string | null): FavoriteProviderModelRecord {
  return {
    id: `fav_${modelId}`,
    providerProfileId: PROFILE,
    modelId,
    scope: MODEL_FAVORITE_SCOPE.rp,
    label,
    contextLength: null,
    createdAt: "2026-08-08T12:00:00.000Z",
  };
}

function props(overrides: Partial<SheetProps> = {}): SheetProps {
  return {
    open: true,
    onClose: mock(),
    context: {
      permanent: 3000,
      history: 2000,
      inputTokens: 500,
      maxTokens: 1024,
      availableBudget: 7168,
      tokenState: "ok",
      permanentItems: [
        { label: "row_system", value: 1000 },
        { label: "row_character", value: 2000 },
      ],
    },
    providerProfile: { id: PROFILE, name: "DeepSeek" },
    favoriteModels: [fav("model-a", "Alpha"), fav("model-b", null)],
    activeModelId: "model-a",
    onSelectModel: mock(),
    ...overrides,
  };
}

function mountSheet(p: SheetProps) {
  const view = render(<TooltipProvider><MobileModelSheet {...p} /></TooltipProvider>);
  return {
    ...view,
    rerenderWith: (next: SheetProps) => view.rerender(<TooltipProvider><MobileModelSheet {...next} /></TooltipProvider>),
  };
}

function contextCard(view: ReturnType<typeof mountSheet>): HTMLElement {
  const card = view.getByText("context_label").closest("button");
  if (!card) throw new Error("context card not rendered");
  return card;
}

const WINDOWED_CONFIG: ProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.windowed,
  displayEnabled: true,
  lowQuotaEnabled: false,
  lowQuotaRemainingPercent: 10,
  resetNotifyEnabled: false,
  pollIntervalMinutes: 5,
};

function windowedSnapshot(usedPercent: number): ProviderQuotaSnapshot {
  return {
    kind: PROVIDER_QUOTA_KIND.windowed,
    providerProfileId: PROFILE,
    capabilityId: "zai",
    capabilityVersion: 1,
    observedAt: "2026-08-08T12:00:00.000Z",
    windows: [{ kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "5-hour session", usedPercent, resetsAt: "2099-01-01T00:00:00.000Z" }],
    balances: [{ kind: PROVIDER_BALANCE_KIND.available, unit: PROVIDER_BALANCE_UNIT.usd, amount: "12.40", primary: true }],
  };
}

function seedQuota(entry: { config?: ProviderQuotaConfig | null; snapshot?: ProviderQuotaSnapshot | null }): void {
  useQuotaStore.setState({
    entries: {
      [PROFILE]: {
        status: "success",
        capability: null,
        config: entry.config === undefined ? WINDOWED_CONFIG : entry.config,
        snapshot: entry.snapshot ?? null,
        lastError: null,
        loadError: null,
        updatedAt: "2026-08-08T12:00:00.000Z",
      },
    },
  });
}

describe("MobileModelSheet context card", () => {
  test("is collapsed by default: figures, bar and the one-line summary, no breakdown rows", async () => {
    const view = mountSheet(props());
    await waitFor(() => view.getByText("context_label"));
    const card = contextCard(view);

    expect(card.getAttribute("aria-expanded")).toBe("false");
    // 3000 / 2000 / 500 of 7168 -> 42 / 28 / 7 percent; used 5500 -> 77 percent.
    expect(card.textContent).toContain(`77% · ${fmt(5500)} / ${fmt(7168)}`);
    expect(card.textContent).toContain('context_summary:{"permanent":42,"history":28,"input":7}');
    expect(card.querySelector(".bg-accent")).not.toBeNull();
    expect(view.queryByText("row_system")).toBeNull();
    expect(view.queryByText("context_response_budget")).toBeNull();
  });

  // The figure shares the ring's state mapping (CONTEXT_STATE_CLASSES): ok accent,
  // mid warning text, warn danger text.
  for (const [state, expected, others] of [
    ["ok", "text-accent-t", ["text-warning-text", "text-danger-text"]],
    ["mid", "text-warning-text", ["text-accent-t", "text-danger-text"]],
    ["warn", "text-danger-text", ["text-accent-t", "text-warning-text"]],
  ] as const) {
    test(`colors the context figure for tokenState "${state}"`, async () => {
      const view = mountSheet(props({ context: { ...props().context, tokenState: state } }));
      await waitFor(() => view.getByText("context_label"));
      const figure = contextCard(view).querySelector<HTMLElement>("span.tabular-nums");

      expect(figure?.textContent).toContain("%");
      expect(figure?.classList.contains(expected)).toBe(true);
      for (const other of others) expect(figure?.classList.contains(other)).toBe(false);
    });
  }

  test("tapping expands the full breakdown in place and tapping again collapses it", async () => {
    const view = mountSheet(props());
    await waitFor(() => view.getByText("context_label"));
    const card = contextCard(view);

    fireEvent.click(card);

    expect(card.getAttribute("aria-expanded")).toBe("true");
    const text = card.textContent ?? "";
    for (const [label, value] of [
      ["row_system", fmt(1000)], ["row_character", fmt(2000)],
      ["context_history", fmt(2000)], ["context_current_input", fmt(500)],
      ["context_response_budget", `-${fmt(1024)}`], ["context_total_available", fmt(7168)],
    ] as const) {
      expect(text).toContain(`${label}${value}`);
    }
    expect(text).not.toContain("context_summary");

    fireEvent.click(card);

    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(card.textContent).toContain("context_summary");
    expect(view.queryByText("row_system")).toBeNull();
  });

  test("starts collapsed again every time the sheet opens", async () => {
    const view = mountSheet(props());
    await waitFor(() => view.getByText("context_label"));
    fireEvent.click(contextCard(view));
    expect(contextCard(view).getAttribute("aria-expanded")).toBe("true");

    view.rerenderWith(props({ open: false }));
    await waitFor(() => expect(view.queryByText("context_label")).toBeNull());
    view.rerenderWith(props({ open: true }));

    await waitFor(() => view.getByText("context_label"));
    expect(contextCard(view).getAttribute("aria-expanded")).toBe("false");
  });

  test("with no known budget shows the figures and rows only, no bar and no summary", async () => {
    const view = mountSheet(props({
      context: { permanent: 3000, history: 2000, inputTokens: 500, maxTokens: 0, availableBudget: 0, tokenState: "ok", permanentItems: [{ label: "row_system", value: 1000 }] },
    }));
    await waitFor(() => view.getByText("context_label"));
    const card = contextCard(view);

    expect(card.textContent).toContain(`0% · ${fmt(5500)} / ${fmt(0)}`);
    expect(card.textContent).not.toContain("context_summary");
    expect(card.querySelector(".bg-accent")).toBeNull();

    fireEvent.click(card);

    expect(card.textContent).toContain(`row_system${fmt(1000)}`);
    expect(card.textContent).toContain(`context_total_available${fmt(0)}`);
  });
});

describe("MobileModelSheet quota card", () => {
  test("is present with the snapshot rows and the provider name when supported, on, and a snapshot exists", async () => {
    seedQuota({ snapshot: windowedSnapshot(62) });
    const view = mountSheet(props());

    await waitFor(() => view.getByText("quota_section"));
    expect(view.getByText("DeepSeek")).toBeTruthy();
    expect(view.getByText("quota_window_session")).toBeTruthy();
    expect(view.getByText('quota_remaining_value:{"percent":38}')).toBeTruthy();
    expect(view.getByText("$12.40")).toBeTruthy();
  });

  test("is absent for a provider with no quota capability", async () => {
    seedQuota({ config: { kind: PROVIDER_QUOTA_KIND.none }, snapshot: windowedSnapshot(62) });
    const view = mountSheet(props());
    await waitFor(() => view.getByText("context_label"));
    expect(view.queryByText("quota_section")).toBeNull();
  });

  test("is absent when the display toggle is off", async () => {
    seedQuota({ config: { ...WINDOWED_CONFIG, displayEnabled: false }, snapshot: windowedSnapshot(62) });
    const view = mountSheet(props());
    await waitFor(() => view.getByText("context_label"));
    expect(view.queryByText("quota_section")).toBeNull();
  });

  test("is absent while there is no snapshot yet", async () => {
    seedQuota({ snapshot: null });
    const view = mountSheet(props());
    await waitFor(() => view.getByText("context_label"));
    expect(view.queryByText("quota_section")).toBeNull();
  });

  test("is absent without an active provider profile", async () => {
    seedQuota({ snapshot: windowedSnapshot(62) });
    const view = mountSheet(props({ providerProfile: null }));
    await waitFor(() => view.getByText("context_label"));
    expect(view.queryByText("quota_section")).toBeNull();
  });

  test("triggers the capability and quota fetch when the sheet opens, not before", async () => {
    const view = mountSheet(props({ open: false }));
    expect(fetchQuotaCapability).not.toHaveBeenCalled();
    expect(fetchQuota).not.toHaveBeenCalled();

    view.rerenderWith(props({ open: true }));

    await waitFor(() => expect(fetchQuota).toHaveBeenCalledTimes(1));
    expect(fetchQuota.mock.calls[0]?.[0]).toBe(PROFILE);
    expect(fetchQuotaCapability).toHaveBeenCalledTimes(1);
    expect(fetchQuotaCapability.mock.calls[0]?.[0]).toBe(PROFILE);
  });
});

describe("MobileModelSheet starred models", () => {
  test("titles the sheet, lists the favorites and marks the active one", async () => {
    const view = mountSheet(props());

    const alpha = await waitFor(() => view.getByText("Alpha").closest("button"));
    expect(view.getByText("model_label")).toBeTruthy();
    expect(view.getByText("starred_models")).toBeTruthy();
    expect(alpha?.querySelector("svg")).not.toBeNull();
    expect(view.getByText("model-b").closest("button")?.querySelector("svg")).toBeNull();
  });

  test("picking a model selects it and closes the sheet", async () => {
    const onSelectModel = mock();
    const onClose = mock();
    const view = mountSheet(props({ onSelectModel, onClose }));

    fireEvent.click(await waitFor(() => view.getByText("model-b")));

    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectModel.mock.calls[0]?.[0]).toBe("model-b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("shows the empty state when nothing is starred", async () => {
    const view = mountSheet(props({ favoriteModels: [] }));
    await waitFor(() => expect(view.getByText("no_starred_models")).toBeTruthy());
  });
});
