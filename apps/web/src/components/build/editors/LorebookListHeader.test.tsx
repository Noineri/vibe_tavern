import { describe, expect, it, mock } from "bun:test";
import { useState, type ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { Tab } from "./use-lorebook-editor-state.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const { WorldLoreListHeader } = await import("./LorebookListHeader.js");

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
