import type { ComponentProps } from "react";
import { describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Command } from "cmdk";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ProviderModelList } from "./ProviderModelList.js";

const models = [
  { id: "supported", label: "Supported", toolSupport: "supported" as const },
  { id: "unknown", label: "Unknown", toolSupport: "unknown" as const },
  { id: "unsupported", label: "Unsupported", toolSupport: "unsupported" as const },
];

function renderList(overrides: Partial<ComponentProps<typeof ProviderModelList>> = {}) {
  const onSelect = vi.fn();
  const onToggleFavorite = vi.fn();
  const onUseCustomSlug = vi.fn();
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
    const { getByText, onUseCustomSlug } = renderList({ search: "custom/model" });
    await user.click(getByText("Use “custom/model”"));
    expect(onUseCustomSlug).toHaveBeenCalledWith("custom/model");
  });
});
