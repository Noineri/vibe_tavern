/**
 * RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT step 3 — the Co-Author selector's
 * budget auto-feed wiring: the selector feeds the ONE shared auto-fill rule
 * (lib/context-autofill.ts) with the form's current budget, so an unknown
 * model context leaves a set budget untouched (owner ruling 2026-10-04,
 * recorded in the report). The rule's own four cases (including the
 * no-budget Co-Author fallback 128 000) are pinned in
 * lib/context-autofill.test.ts; this file pins the selector's WIRING for
 * both entry points — list selection and the custom
 * slug row (whose context length is always unknown).
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

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
// implement. The desktop variant is the path under test here.
const realUseMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => false,
}));

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let CoauthorModelSelector: typeof import("./CoauthorModelSelector.js").CoauthorModelSelector;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ CoauthorModelSelector } = await import("./CoauthorModelSelector.js"));
});

/** The Popover portals its list into document.body; cmdk items carry the
 *  model id as data-value (set by cmdk from the Command.Item value). */
function cmdkItem(value: string): HTMLElement {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>("[cmdk-item]"))
    .find((el) => el.getAttribute("data-value") === value);
  if (!item) throw new Error(`cmdk item not rendered: ${value}`);
  return item;
}

const MODELS = [
  { id: "ctx-unknown", label: "ctx-unknown" },
  { id: "ctx-32k", label: "ctx-32k", contextLength: 32_768 },
];

/** Props shape derived from the component (the interface is not exported). */
type Props = Parameters<typeof CoauthorModelSelector>[0];

function baseProps(over: Partial<Props> = {}): Props {
  return {
    values: { model: "ctx-unknown", contextBudget: 5_000, pinContextBudget: false },
    models: MODELS,
    fetching: false,
    fetchError: null,
    modelSearch: "",
    modelListOpen: true,
    favoriteModels: [],
    onChange: () => {},
    onFetchModels: () => {},
    setModelSearch: () => {},
    setModelListOpen: () => {},
    onToggleFavoriteModel: () => {},
    ...over,
  };
}

/** Assert which onChange keys fired, in order — the wiring contract for the
 *  budget auto-fill (model always, contextBudget only when the rule fills). */
function onChangeKeys(onChange: { mock: { calls: unknown[] } }): string[] {
  return (onChange.mock.calls as Array<["model" | "contextBudget", unknown]>).map(([key]) => key);
}

describe("CoauthorModelSelector context-budget auto-fill (RP_QUICK_SWITCH step 3)", () => {
  it("unknown model context keeps the set budget (no contextBudget write)", () => {
    const onChange = mock((_key: "model" | "contextBudget", _value: string | number) => {});
    const view = render(<CoauthorModelSelector {...baseProps({ onChange })} />);
    fireEvent.click(cmdkItem("ctx-unknown"));
    expect(onChangeKeys(onChange)).toEqual(["model"]);
    view.unmount();
  });

  it("known model context fills the budget — over the current value", () => {
    const onChange = mock((_key: "model" | "contextBudget", _value: string | number) => {});
    const view = render(<CoauthorModelSelector {...baseProps({ onChange })} />);
    fireEvent.click(cmdkItem("ctx-32k"));
    expect(onChange.mock.calls).toContainEqual(["contextBudget", 32_768]);
    view.unmount();
  });

  it("pinned budget is never written, even for a known context length", () => {
    const onChange = mock((_key: "model" | "contextBudget", _value: string | number) => {});
    const view = render(
      <CoauthorModelSelector
        {...baseProps({ onChange, values: { model: "ctx-32k", contextBudget: 5_000, pinContextBudget: true } })}
      />,
    );
    fireEvent.click(cmdkItem("ctx-32k"));
    expect(onChangeKeys(onChange)).toEqual(["model"]);
    view.unmount();
  });

  it("custom slug row (context always unknown) keeps the set budget", () => {
    const onChange = mock((_key: "model" | "contextBudget", _value: string | number) => {});
    const view = render(<CoauthorModelSelector {...baseProps({ onChange, modelSearch: "my-model" })} />);
    const customRow = document.body.querySelector<HTMLElement>('[data-testid="use-custom-model"]');
    if (!customRow) throw new Error("use-custom-model row not rendered");
    fireEvent.click(customRow);
    expect(onChangeKeys(onChange)).toEqual(["model"]);
    view.unmount();
  });
});
