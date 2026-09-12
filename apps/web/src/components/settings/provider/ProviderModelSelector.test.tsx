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
import type { FormState } from "../../modals/ProviderModal.js";
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
let render: typeof import("@testing-library/react").render;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ ProviderModelSelector } = await import("./ProviderModelSelector.js"));
});

const MODELS: ProviderModelListOption[] = [
  { id: "gpt-4o", label: "gpt-4o" },
  { id: "claude-3-7", label: "claude-3-7" },
];

/** Props shape derived from the component (the interface is not exported). */
type Props = Parameters<typeof ProviderModelSelector>[0];

function baseProps(over: Partial<Props> = {}): Props {
  return {
    form: { model: "gpt-4o" } as FormState,
    models: MODELS,
    filteredModels: MODELS,
    fetching: false,
    fetchError: null,
    modelSearch: "",
    modelListOpen: false,
    favoriteModels: [],
    updateForm: () => {},
    onFetchModels: () => {},
    setModelSearch: () => {},
    setModelListOpen: () => {},
    onToggleFavoriteModel: () => {},
    ...over,
  };
}

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