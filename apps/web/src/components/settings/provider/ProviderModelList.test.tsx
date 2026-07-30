import type { ComponentProps } from "react";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let userEvent: typeof import("@testing-library/user-event").default;
let Command: typeof import("cmdk").Command;
let Tooltip: typeof import("@radix-ui/react-tooltip");
let ProviderModelList: typeof import("./ProviderModelList.js").ProviderModelList;
beforeAll(async () => {
	({ render } = await import("@testing-library/react"));
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ Command } = await import("cmdk"));
	Tooltip = await import("@radix-ui/react-tooltip");
	({ ProviderModelList } = await import("./ProviderModelList.js"));
});

const models = [
  { id: "supported", label: "Supported", toolSupport: "supported" as const },
  { id: "unknown", label: "Unknown", toolSupport: "unknown" as const },
  { id: "unsupported", label: "Unsupported", toolSupport: "unsupported" as const },
];

function renderList(overrides: Partial<ComponentProps<typeof ProviderModelList>> = {}) {
  const onSelect = mock();
  const onToggleFavorite = mock();
  const onUseCustomSlug = mock();
  const view = render(<Tooltip.Provider><Command><ProviderModelList models={models} selectedId="" search="" favorites={[]} onSelect={onSelect} onToggleFavorite={onToggleFavorite} onUseCustomSlug={onUseCustomSlug} {...overrides} /></Command></Tooltip.Provider>);
  return { ...view, onSelect, onToggleFavorite, onUseCustomSlug };
}

describe("ProviderModelList", () => {
  test("applies an exact tri-state filter", () => {
    const { queryByText, getByText } = renderList({ toolFilter: "unknown" });
    expect(getByText("Unknown")).toBeTruthy();
    expect(queryByText("Supported")).toBeNull();
    expect(queryByText("Unsupported")).toBeNull();
  });

  test("starring a row does not select it", async () => {
    const user = userEvent.setup();
    const { getByText, onSelect, onToggleFavorite } = renderList();
    await user.click(getByText("Supported").closest("[cmdk-item]")!.querySelector("button")!);
    expect(onToggleFavorite).toHaveBeenCalledWith(models[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("offers a custom slug while the fetched list is populated", async () => {
    const user = userEvent.setup();
    const { getByTestId, onUseCustomSlug } = renderList({ search: "custom/model" });
    await user.click(getByTestId("use-custom-model"));
    expect(onUseCustomSlug).toHaveBeenCalledWith("custom/model");
  });

  test("groups rows under owner headers when groupByOwner is on (multiple owners)", () => {
    const groupedModels = [
      { id: "anthropic/claude", label: "Claude" },
      { id: "openai/gpt-4o", label: "GPT-4o" },
      { id: "anthropic/haiku", label: "Haiku" },
    ];
    const { getByText } = renderList({ models: groupedModels, groupByOwner: true });
    // Two distinct owners → two headers rendered.
    expect(getByText("anthropic")).toBeTruthy();
    expect(getByText("openai")).toBeTruthy();
    // Model labels still render inside their groups.
    expect(getByText("Claude")).toBeTruthy();
    expect(getByText("Haiku")).toBeTruthy();
  });

  test("collapses to flat (no owner header) when only one owner exists", () => {
    // Neither id has a slash/colon/dash → both derive to "Other" (single owner).
    const singleOwnerModels = [
      { id: "gpt4", label: "GPT4" },
      { id: "claude3", label: "Claude3" },
    ];
    const { queryByText, getByText } = renderList({ models: singleOwnerModels, groupByOwner: true });
    expect(queryByText("Other")).toBeNull();
    expect(getByText("GPT4")).toBeTruthy();
  });
});
