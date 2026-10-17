/**
 * ManagementMobileRow — presentation tests.
 *
 * Pins the AS-8c4f1 shared mobile management row boundary: one row with the
 * name input, the enable toggle, the save button and the `...` button; the
 * `...` button opens an ActionSheet with the caller's title and items; a
 * danger item fires its action; a disabled item never fires. AS-8c4h adds
 * the optional badge slot: the badge renders in the row when given, and the
 * row renders as before without it. i18n is stubbed
 * (key-echo translator); every callback is asserted through the component's
 * explicit props. No status pill and no save-state text exist anywhere — the
 * toggle and the save button carry the state.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ScriptDraftSaveState } from "../../../stores/script-draft-store.js";
import type { ActionSheetItem } from "../../shared/ActionSheet.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ManagementMobileRow: typeof import("./management-mobile-row.js").ManagementMobileRow;
beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ManagementMobileRow } = await import("./management-mobile-row.js"));
});

interface RowOverrides {
  name?: string;
  enabled?: boolean;
  enableLocked?: boolean;
  dirty?: boolean;
  saveState?: ScriptDraftSaveState;
  saveLabel?: string;
  sheetTitle?: string;
  sheetItems?: ActionSheetItem[];
  badge?: ReactNode;
}

function renderRow(overrides: RowOverrides = {}) {
  const names: string[] = [];
  const toggles: boolean[] = [];
  let saves = 0;
  const actions: string[] = [];
  const result = render(
    <ManagementMobileRow
      name="My script"
      namePlaceholder="Name here"
      onNameChange={(name) => { names.push(name); }}
      enabled={true}
      onToggleEnabled={(enabled) => { toggles.push(enabled); }}
      dirty={true}
      saveState="idle"
      saveLabel="Save now"
      resetKey="s1"
      onSave={() => { saves += 1; }}
      sheetTitle="My script"
      sheetItems={[
        { icon: <span />, label: "Kind info", disabled: true, action: () => { actions.push("kind"); } },
        { icon: <span />, label: "Delete it", danger: true, action: () => { actions.push("delete"); } },
      ]}
      {...overrides}
    />,
  );
  return {
    ...result,
    calls: { names, toggles, saves: () => saves, actions },
  };
}

describe("ManagementMobileRow", () => {
  it("renders the name input, toggle, save and ... in one row with the sheet closed", () => {
    const { getByPlaceholderText, getByRole, queryByText, container } = renderRow();
    getByPlaceholderText("Name here");
    getByRole("switch");
    getByRole("button", { name: "Save now" });
    getByRole("button", { name: "management_more_actions" });
    // One row, no status pill, no save-state text.
    expect(container.querySelector("div.flex.w-full.items-center.gap-1\\.5")).toBeTruthy();
    expect(queryByText("Kind info")).toBeNull();
    expect(queryByText("Delete it")).toBeNull();
  });

  it("renders the badge in the row when given, inside a shrink-0 wrapper", () => {
    const { getByText } = renderRow({ badge: <span>Prompt badge</span> });
    // Badge is authored copy in the name row — visible with the sheet closed,
    // never truncated (shrink-0 wrapper keeps it out of the input's flex).
    const badge = getByText("Prompt badge");
    expect(badge.parentElement?.className).toContain("shrink-0");
  });

  it("renders as before without a badge", () => {
    const { queryByText, getByPlaceholderText, getByRole } = renderRow();
    getByPlaceholderText("Name here");
    getByRole("switch");
    getByRole("button", { name: "Save now" });
    expect(queryByText("Prompt badge")).toBeNull();
  });

  it("opens the sheet with the caller's title and items from the ... button", () => {
    const { getByRole, getByText } = renderRow();
    fireEvent.click(getByRole("button", { name: "management_more_actions" }));
    getByText("My script");
    getByText("Kind info");
    getByText("Delete it");
  });

  it("fires a danger item's action from the sheet", () => {
    const { getByRole, getByText, calls } = renderRow();
    fireEvent.click(getByRole("button", { name: "management_more_actions" }));
    fireEvent.click(getByText("Delete it"));
    expect(calls.actions).toEqual(["delete"]);
  });

  it("never fires a disabled item's action", () => {
    const { getByRole, getByText, calls } = renderRow();
    fireEvent.click(getByRole("button", { name: "management_more_actions" }));
    fireEvent.click(getByText("Kind info"));
    expect(calls.actions).toEqual([]);
  });
});
