/**
 * W1 (MOBILE_UI_DEFECTS_REPORT step 5): the refresh-models button must match
 * the closed dropdown's height on mobile. The row is items-end, so the
 * icon-only button (natural 25px: 2px borders + 12px py + 11px icon) would
 * come up ~8.5px short of the trigger (33.5px: 2px borders + 12px py + 13px×1.5
 * line box). Pins: the mobile variant carries the min-h-[33.5px] parity class,
 * the desktop variant keeps its text-driven canon height (no override), and
 * the closed trigger carries the 13px / py-[6px] metrics the value derives from.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ProviderModelListOption } from "./ProviderModelList.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// useIsMobile reads window.matchMedia, which happy-dom does not reliably
// implement. The mutable flag lets one file pin BOTH branches (the mobile
// variant is the defect under test; desktop must stay untouched).
let isMobileValue = false;
const realUseMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => isMobileValue,
}));

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let ProviderModelSelector: typeof import("./ProviderModelSelector.js").ProviderModelSelector;
let ProviderModalModelSelector: typeof import("./ProviderModalModelSelector.js").ProviderModalModelSelector;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ProviderModelSelector } = await import("./ProviderModelSelector.js"));
  ({ ProviderModalModelSelector } = await import("./ProviderModalModelSelector.js"));
});

/** The Popover portals its list into document.body; cmdk items carry the
 *  model id as data-value (set by cmdk from the Command.Item value). */
function cmdkItem(value: string): HTMLElement {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>("[cmdk-item]"))
    .find((el) => el.getAttribute("data-value") === value);
  if (!item) throw new Error(`cmdk item not rendered: ${value}`);
  return item;
}

const MODELS: ProviderModelListOption[] = [
  { id: "gpt-4o", label: "gpt-4o" },
  { id: "claude-3-7", label: "claude-3-7" },
];

function updateFormKeys(onChange: { mock: { calls: unknown[] } }): string[] {
  return (onChange.mock.calls as Array<[string, unknown]>).map(([key]) => key);
}

/** Props shape derived from the component (the interface is not exported). */
type Props = Parameters<typeof ProviderModelSelector>[0];

function baseProps(over: Partial<Props> = {}): Props {
  return {
    value: "gpt-4o",
    onChange: () => {},
    options: MODELS,
    fetching: false,
    fetchError: null,
    onRefreshOptions: () => {},
    favoriteModels: [],
    onToggleFavoriteModel: () => {},
    ...over,
  };
}

describe("ProviderModelSelector local status chip (IG-CF12b)", () => {
  it("localConnection: the shared primitive renders with the state class + the mb-2.5 placement", () => {
    const view = render(
      <ProviderModelSelector
        {...baseProps({ localConnection: { endpoint: "http://127.0.0.1:11434", status: "online" } })}
      />,
    );
    const label = view.getByText("local_connection_online");
    // Two divs up: the status row wrapper (CF-12d) sits between the label
    // and the chip body that carries the state class + placement margin.
    const chip = label.closest("div")!.parentElement!;
    expect(chip.className).toContain("border-success/30");
    expect(chip.className).toContain("mb-2.5");
    view.unmount();
  });

  it("showRefreshButton=false: no mini re-check button inside the chip (the gating moved into the onRefresh presence)", () => {
    const view = render(
      <ProviderModelSelector
        {...baseProps({ localConnection: { endpoint: "", status: "unknown" }, showRefreshButton: false })}
      />,
    );
    const label = view.getByText("local_connection_unknown");
    const chip = label.closest("div")!.parentElement!;
    expect(chip.querySelector("button")).toBeNull();
    view.unmount();
  });
});

describe("ProviderModelSelector refresh button height (W1 step 5)", () => {
  beforeEach(() => {
    isMobileValue = false;
  });

  it("mobile: the icon-only refresh button matches the closed dropdown height (min-h-[33.5px] = 2px borders + 12px py + 13px×1.5 line box)", () => {
    isMobileValue = true;
    const view = render(<ProviderModelSelector {...baseProps()} />);
    const refresh = view.getByTestId("provider-models-refresh");
    expect(refresh.className).toContain("min-h-[33.5px]");
    expect(refresh.className).toContain("w-[34px]");
    // Icon-only on phones — no text slot, so the min-height carries the parity.
    expect(refresh.className).not.toContain("font-ui");
    expect(refresh.textContent).toBe("");
    // The closed trigger's metrics that 33.5px derives from (parity pin, not a
    // re-implementation): 13px text on the preflight 1.5 line-height + py-[6px].
    const trigger = view.getByText("gpt-4o").closest("button")!;
    expect(trigger.className).toContain("text-[13px]");
    expect(trigger.className).toContain("py-[6px]");
    view.unmount();
  });

  it("desktop: the refresh button keeps its text-driven canon height (no min-h override)", () => {
    isMobileValue = false;
    const view = render(<ProviderModelSelector {...baseProps()} />);
    const refresh = view.getByTestId("provider-models-refresh");
    expect(refresh.className).not.toContain("min-h-[33.5px]");
    expect(refresh.className).toContain("font-ui");
    expect(refresh.className).toContain("text-[13px]");
    expect(refresh.textContent).toContain("refresh_models");
    view.unmount();
  });
});

/** RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT step 3 — the RP adapter retains the
 * selector's original context-budget policy while the shared source only
 * delivers a selected catalog option through its optional callback. */
describe("ProviderModelSelector context-budget auto-fill (RP_QUICK_SWITCH step 3)", () => {
  const AUTOFILL_MODELS: ProviderModelListOption[] = [
    { id: "ctx-unknown", label: "ctx-unknown" },
    { id: "ctx-32k", label: "ctx-32k", contextLength: 32_768 },
  ];

  function renderAutofill(values: { model: string; contextBudget: number; pinContextBudget: boolean }) {
    const onChange = mock((_key: string, _value: string | number | boolean) => {});
    const view = render(
      <ProviderModalModelSelector
        values={{ ...values, modelFreeOnly: false, modelGroupByOwner: false }}
        options={AUTOFILL_MODELS}
        fetching={false}
        fetchError={null}
        favoriteModels={[]}
        onChange={onChange}
        onRefreshOptions={() => {}}
        onToggleFavoriteModel={() => {}}
        requiresAuthForModels={false}
      />,
    );
    return { view, onChange };
  }

  it("unknown model context keeps the form's set budget (no contextBudget write)", () => {
    const { view, onChange } = renderAutofill({ model: "ctx-unknown", contextBudget: 8_192, pinContextBudget: false });
    fireEvent.click(view.getByText("ctx-unknown").closest("button")!);
    fireEvent.click(cmdkItem("ctx-unknown"));
    expect(updateFormKeys(onChange)).toEqual(["model"]);
    view.unmount();
  });

  it("known model context fills the budget — over the form's current value", () => {
    const { view, onChange } = renderAutofill({ model: "ctx-32k", contextBudget: 8_192, pinContextBudget: false });
    fireEvent.click(view.getByText("ctx-32k").closest("button")!);
    fireEvent.click(cmdkItem("ctx-32k"));
    expect(onChange.mock.calls).toContainEqual(["contextBudget", 32_768]);
    view.unmount();
  });

  it("pinned budget is never written, even for a known context length", () => {
    const { view, onChange } = renderAutofill({ model: "ctx-32k", contextBudget: 8_192, pinContextBudget: true });
    fireEvent.click(view.getByText("ctx-32k").closest("button")!);
    fireEvent.click(cmdkItem("ctx-32k"));
    expect(updateFormKeys(onChange)).toEqual(["model"]);
    view.unmount();
  });
});

/** The family source delivers catalog selection through an optional callback
 * after changing its controlled value, and never invokes it for custom IDs. */
describe("ProviderModelSelector optional selection callback", () => {
  const CALLBACK_MODELS: ProviderModelListOption[] = [
    { id: "ctx-unknown", label: "ctx-unknown" },
    { id: "ctx-32k", label: "ctx-32k", contextLength: 32_768 },
  ];

  it("delivers the catalog option after changing the controlled value", () => {
    const calls: string[] = [];
    const onChange = mock((value: string) => calls.push(`value:${value}`));
    const onOptionSelected = mock((model: ProviderModelListOption) => calls.push(`option:${model.id}`));
    const view = render(<ProviderModelSelector {...baseProps({ options: CALLBACK_MODELS, value: "ctx-unknown", onChange, onOptionSelected })} />);
    fireEvent.click(view.getByText("ctx-unknown").closest("button")!);
    fireEvent.click(cmdkItem("ctx-32k"));
    expect(calls).toEqual(["value:ctx-32k", "option:ctx-32k"]);
    view.unmount();
  });

  it("keeps the callback out of the custom-ID fallback", () => {
    const onChange = mock((_value: string) => {});
    const onOptionSelected = mock((_model: ProviderModelListOption) => {});
    const view = render(<ProviderModelSelector {...baseProps({ options: CALLBACK_MODELS, onChange, onOptionSelected })} />);
    fireEvent.click(view.getByText("gpt-4o").closest("button")!);
    const search = document.body.querySelector<HTMLInputElement>("[cmdk-input]")!;
    fireEvent.input(search, { target: { value: "custom-id" } });
    fireEvent.click(view.getByTestId("use-custom-model"));
    expect(onChange.mock.calls).toEqual([["custom-id"]]);
    expect(onOptionSelected.mock.calls).toEqual([]);
    view.unmount();
  });

  it("forwards family row slots without deriving their chrome in a fork", () => {
    const view = render(
      <ProviderModelSelector
        {...baseProps({
          options: [MODELS[0]],
          renderRowBadges: (model) => <span data-testid="family-badge">{model.id}</span>,
          renderRowDescription: (model) => <span data-testid="family-description">{model.label}</span>,
        })}
      />,
    );
    fireEvent.click(view.getByText("gpt-4o").closest("button")!);
    expect(document.body.querySelector("[data-testid='family-badge']")?.textContent).toBe("gpt-4o");
    expect(document.body.querySelector("[data-testid='family-description']")?.textContent).toBe("gpt-4o");
    view.unmount();
  });
});