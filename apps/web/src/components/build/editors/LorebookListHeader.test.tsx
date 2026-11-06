import { describe, expect, it } from "bun:test";
import { useState } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { Tab } from "./use-lorebook-editor-state.js";

useDomEnv();
const { fireEvent, render: rtlRender, waitFor } = await import("@testing-library/react");
const { TooltipProvider } = await import("../../shared/Tooltip.js");
function render(ui: React.ReactNode) {
  return rtlRender(ui, { wrapper: ({ children }) => <TooltipProvider delayDuration={0}>{children}</TooltipProvider> });
}


const { WorldLoreListHeader, WorldLoreOwnerFilter } = await import("./LorebookListHeader.js");

const itemsByTab = {
  lorebooks: ["Bestiary", "Tavern rules"],
  scripts: ["Greeting", "Tavern narrator"],
} as const;

function MobileListHarness({ tab }: { tab: Tab }) {
  const [nameSearch, setNameSearch] = useState("");
  const visibleItems = itemsByTab[tab].filter((item) => item.toLowerCase().includes(nameSearch.toLowerCase()));

  return (
    <>
      <WorldLoreListHeader
        isMobile
        scope="all"
        tab={tab}
        ownerId={null}
        owners={[]}
        nameSearch={nameSearch}
        onNameSearchChange={setNameSearch}
        onOwnerChange={() => {}}
        onBack={() => {}}
        onSwitchTab={() => {}}
        onAddLorebook={() => {}}
        onImportLorebook={() => {}}
        onAddScript={() => {}}
        onAddDiceScript={() => {}}
        onImportScript={() => {}}
        t={(key) => key}
      />
      <ul>{visibleItems.map((item) => <li key={item} data-testid={`${tab}-list-item`}>{item}</li>)}</ul>
    </>
  );
}

describe("WorldLoreListHeader mobile search", () => {
  it.each([
    ["lorebooks", "tavern"],
    ["scripts", "tavern"],
  ] as const)("clears the %s query and restores its full list when closed", async (tab, query) => {
    const ui = render(<MobileListHarness tab={tab} />);
    const searchTestId = `${tab === "lorebooks" ? "lorebook" : "script"}-name-search`;

    fireEvent.click(ui.getByTestId(`${searchTestId}-toggle`));
    fireEvent.change(ui.getByTestId(searchTestId), { target: { value: query } });

    await waitFor(() => expect(ui.queryAllByTestId(`${tab}-list-item`)).toHaveLength(1));
    fireEvent.click(ui.getByRole("button", { name: "close" }));

    await waitFor(() => expect(ui.queryAllByTestId(`${tab}-list-item`)).toHaveLength(2));
    expect(ui.queryByTestId(searchTestId)).toBeNull();
  });
});


describe("WorldLoreOwnerFilter mobile owner", () => {
  it("retains the bounded truncation and exposes the full clipped owner name", async () => {
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
    try {
      const name = "An exceptionally long owner name";
      const view = render(<WorldLoreOwnerFilter isMobile ownerId="c1" owners={[{ id: "c1", name, kind: "character" }]} onOwnerChange={() => {}} testId="owner" t={(key) => key} />);
      const label = view.getByText(name);
      expect(label.className).toContain("truncate");
      expect(label.className).toContain("max-w-36");
      expect(label.hasAttribute("title")).toBe(false);
      fireEvent.pointerMove(label, { pointerType: "mouse" });
      expect((await view.findByRole("tooltip")).textContent).toBe(name);
      view.unmount();
    } finally {
      if (scrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });
});
