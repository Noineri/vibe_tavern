/**
 * ScriptManagementControls — presentation tests.
 *
 * Pins the AS-8c1 management bar boundary (row 1 only since AS-8c4e: name,
 * kind badge, status pill, enable toggle, desktop save-state text, save,
 * delete — the description field + the entity-only links block moved into
 * the Code tab's toolbar strip). i18n is stubbed (key-echo translator);
 * every callback is asserted through the component's explicit props.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type {
  ScriptDraftSaveState,
  ScriptDraftValues,
} from "../../../stores/script-draft-store.js";

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
let ScriptManagementControls: typeof import("./script-management-controls.js").ScriptManagementControls;
beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ScriptManagementControls } = await import("./script-management-controls.js"));
});

interface ControlOverrides {
  name?: string;
  enabled?: boolean;
  scriptKind?: string;
  draftDirty?: boolean;
  draftSaveState?: ScriptDraftSaveState;
  draftError?: string | null;
  resetKey?: string | null;
  isMobile?: boolean;
}

function renderControls(overrides: ControlOverrides = {}) {
  const patches: Array<Partial<ScriptDraftValues>> = [];
  const toggles: boolean[] = [];
  let saves = 0;
  let deletes = 0;
  const result = render(
    <ScriptManagementControls
      name="My script"
      enabled={true}
      scriptKind="prompt"
      draftDirty={true}
      draftSaveState="idle"
      draftError={null}
      resetKey="s1"
      isMobile={false}
      onUpdateDraft={(patch) => { patches.push(patch); }}
      onToggleEnabled={(enabled) => { toggles.push(enabled); }}
      onDelete={() => { deletes += 1; }}
      onSave={() => { saves += 1; }}
      {...overrides}
    />,
  );
  return {
    ...result,
    calls: { patches, toggles, saves: () => saves, deletes: () => deletes },
  };
}

describe("ScriptManagementControls", () => {
  it("renders the row-1 management cluster with no description or links", () => {
    const { getByPlaceholderText, getByRole, getByText, queryByPlaceholderText, queryByText, queryByTestId } = renderControls();
    // Row 1: name, kind badge, status pill, toggle, save-state text, save, delete.
    getByPlaceholderText("script_name");
    getByText("script_kind_prompt");
    getByText("experience_editor_enabled");
    getByRole("switch");
    getByText("unsaved_changes");
    getByRole("button", { name: "save" });
    getByRole("button", { name: "delete_script_confirm" });
    // Row 2 moved to the Code tab's toolbar strip (AS-8c4e): the bar renders
    // no description field and no links block.
    expect(queryByPlaceholderText("script_desc_placeholder")).toBeNull();
    expect(queryByText("script_links_label")).toBeNull();
    expect(queryByTestId("links-picker")).toBeNull();
  });

  it("shows the dice kind label for dice scripts", () => {
    const { getByText, queryByText } = renderControls({ scriptKind: "dice" });
    getByText("script_kind_dice");
    expect(queryByText("script_kind_prompt")).toBeNull();
  });

  it("routes name edits through onUpdateDraft", () => {
    const { getByPlaceholderText, calls } = renderControls();
    fireEvent.change(getByPlaceholderText("script_name"), { target: { value: "Renamed" } });
    expect(calls.patches).toEqual([{ name: "Renamed" }]);
  });

  it("routes toggle, save and delete through their callbacks", () => {
    const { getByRole, calls } = renderControls({ enabled: true, draftDirty: true });
    fireEvent.click(getByRole("switch"));
    expect(calls.toggles).toEqual([false]);
    fireEvent.click(getByRole("button", { name: "save" }));
    expect(calls.saves()).toBe(1);
    fireEvent.click(getByRole("button", { name: "delete_script_confirm" }));
    expect(calls.deletes()).toBe(1);
  });

  it("hides the save-state text on mobile and shortens the status pill", () => {
    // As in the model, the mobile hiding is the `max-md:hidden` CSS class,
    // not conditional rendering — so the text stays in the DOM on both
    // viewports and the class carries the boundary.
    const desktop = renderControls({ isMobile: false, draftDirty: false });
    expect(desktop.getByText("saved_state").getAttribute("class")).toContain("max-md:hidden");
    desktop.getByText("experience_editor_enabled");
    desktop.unmount();
    const mobile = renderControls({ isMobile: true, draftDirty: false });
    expect(mobile.getByText("saved_state").getAttribute("class")).toContain("max-md:hidden");
    mobile.getByText("experience_editor_enabled_short");
  });
});
